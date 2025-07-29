// api/large-file-upload.js - Server-side client upload handler
import { put } from '@vercel/blob';
import { setCorsHeaders, handleCorsPrelight } from '../lib/cors.js';

export default async function handler(req, res) {
  console.log(`🔄 Large file upload handler called from: ${req.headers.origin}`);
  
  // Set CORS headers
  setCorsHeaders(res, req.headers.origin);
  
  // Handle preflight
  if (handleCorsPrelight(req, res)) {
    return;
  }

  if (req.method !== 'POST') {
    console.log(`❌ Method ${req.method} not allowed`);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  try {
    console.log('📋 Processing large file upload request...');
    
    // Get the file data from the request body (as binary)
    const chunks = [];
    req.on('data', chunk => {
      chunks.push(chunk);
    });
    
    await new Promise((resolve, reject) => {
      req.on('end', resolve);
      req.on('error', reject);
    });
    
    const fileBuffer = Buffer.concat(chunks);
    console.log(`📁 Received file buffer: ${Math.round(fileBuffer.length / 1024 / 1024)}MB`);
    
    // Get filename from headers (we'll send it this way)
    const filename = req.headers['x-filename'] || 'large-podcast-episode.mp3';
    const contentType = req.headers['content-type'] || 'audio/mpeg';
    
    console.log(`📁 Uploading to blob: ${filename} (${contentType})`);
    
    // Use the official put method - this should work for large files when called from server
    const blob = await put(filename, fileBuffer, {
      access: 'public',
      addRandomSuffix: true,
      contentType: contentType
    });

    const uploadTime = Date.now() - startTime;
    console.log(`✅ Large file uploaded successfully: ${blob.url} (${uploadTime}ms)`);

    const response = {
      success: true,
      blobUrl: blob.url,
      url: blob.url,
      filename: filename,
      size: fileBuffer.length,
      contentType: contentType,
      uploadTime: uploadTime,
      metadata: {
        uploadedAt: new Date().toISOString(),
        method: 'server-side-large-file'
      }
    };

    return res.status(200).json(response);

  } catch (error) {
    const uploadTime = Date.now() - startTime;
    console.error(`❌ Large file upload failed after ${uploadTime}ms:`, error.message);
    
    return res.status(500).json({
      success: false,
      error: error.message || 'Large file upload failed',
      uploadTime: uploadTime
    });
  }
}

export const config = {
  api: {
    bodyParser: false, // We need raw body for file data
    sizeLimit: false,  // Disable size limit for this endpoint
    responseLimit: false
  },
  maxDuration: 300 // 5 minutes
};