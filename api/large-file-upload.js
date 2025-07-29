// api/large-file-upload.js - Server-side large file upload with FormData
import { put } from '@vercel/blob';
import formidable from 'formidable';
import { createReadStream } from 'fs';
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
    console.log('📋 Processing large file upload with FormData...');
    
    // Use formidable to parse the large file upload
    const form = formidable({
      maxFileSize: 100 * 1024 * 1024, // 100MB
      maxTotalFileSize: 100 * 1024 * 1024,
      uploadDir: '/tmp',
      keepExtensions: true,
      allowEmptyFiles: false,
      multiples: false
    });

    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) {
          console.error('📋 Large file form parsing error:', err.message);
          reject(new Error(`Large file parsing failed: ${err.message}`));
        } else {
          resolve([fields, files]);
        }
      });
    });

    // Get the uploaded file
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    
    if (!file) {
      console.log('❌ No file in large file upload request');
      return res.status(400).json({ 
        success: false,
        error: 'No file uploaded',
        method: 'large-file-upload'
      });
    }

    // Get metadata from form fields
    const filename = fields.filename || file.originalFilename || 'large-podcast-episode.mp3';
    const contentType = fields.contentType || file.mimetype || 'audio/mpeg';
    
    const fileSizeMB = Math.round(file.size / 1024 / 1024);
    console.log(`📁 Processing large file: ${filename} (${fileSizeMB}MB, ${contentType})`);

    // Upload to Vercel Blob using the same method as small files
    const blob = await put(
      filename, 
      createReadStream(file.filepath), 
      {
        access: 'public',
        addRandomSuffix: true,
        contentType: contentType
      }
    );

    const uploadTime = Date.now() - startTime;
    console.log(`✅ Large file uploaded successfully: ${blob.url} (${uploadTime}ms)`);

    // Clean up temporary file
    try {
      const fs = await import('fs');
      await fs.promises.unlink(file.filepath);
      console.log('🧹 Large file temporary file cleaned up');
    } catch (cleanupError) {
      console.warn('⚠️ Large file cleanup warning:', cleanupError.message);
    }

    const response = {
      success: true,
      blobUrl: blob.url,
      url: blob.url,
      filename: filename,
      size: file.size,
      contentType: contentType,
      uploadTime: uploadTime,
      metadata: {
        uploadedAt: new Date().toISOString(),
        method: 'large-file-server-upload',
        originalName: file.originalFilename
      }
    };

    console.log(`🎉 Large file upload complete for ${filename} in ${uploadTime}ms`);
    return res.status(200).json(response);

  } catch (error) {
    const uploadTime = Date.now() - startTime;
    console.error(`❌ Large file upload failed after ${uploadTime}ms:`, error.message);
    
    const errorResponse = {
      success: false,
      error: error.message || 'Large file upload failed',
      code: error.code || 'LARGE_UPLOAD_ERROR',
      uploadTime: uploadTime
    };

    const statusCode = error.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
    return res.status(statusCode).json(errorResponse);
  }
}

export const config = {
  api: {
    bodyParser: false, // Required for formidable
    sizeLimit: '100mb', // Allow large files
    externalResolver: true,
    responseLimit: false
  },
  maxDuration: 300 // 5 minutes for large files
};