// api/uppy-blob-upload.js - Uppy-compatible blob upload endpoint
import { put } from '@vercel/blob';
import formidable from 'formidable';
import { createReadStream } from 'fs';

export default async function handler(req, res) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://podcastgrowthagent.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse multipart form data from Uppy
    const form = formidable({
      maxFileSize: 100 * 1024 * 1024, // 100MB
      uploadDir: '/tmp',
      keepExtensions: true
    });

    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve([fields, files]);
      });
    });

    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`📁 Uploading to blob: ${file.originalFilename} (${Math.round(file.size / 1024 / 1024)}MB)`);

    // Upload to Vercel Blob
    const blob = await put(file.originalFilename, createReadStream(file.filepath), {
      access: 'public',
      addRandomSuffix: true
    });

    console.log(`✅ Blob uploaded: ${blob.url}`);

    // Clean up temp file
    try {
      await import('fs').then(fs => fs.promises.unlink(file.filepath));
    } catch (cleanupError) {
      console.warn('Cleanup warning:', cleanupError.message);
    }

    // Return blob URL in format Uppy v4 expects
    res.json({
      blobUrl: blob.url,
      url: blob.url,
      filename: file.originalFilename,
      size: file.size,
      // Uppy v4 expects this structure
      success: true
    });

  } catch (error) {
    console.error('❌ Uppy blob upload error:', error);
    res.status(500).json({ 
      error: error.message || 'Upload failed',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: '100mb'
  },
};