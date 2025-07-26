// api/blob-upload.js - Production-ready blob upload endpoint with CORS fixed
import { put } from '@vercel/blob';
import formidable from 'formidable';
import { createReadStream } from 'fs';

export default async function handler(req, res) {
  // CORS headers - Applied to ALL responses (CRITICAL FOR UPPY.JS)
  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://podcastgrowthagent.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control',
    'Access-Control-Allow-Credentials': 'false',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };

  // Set CORS headers on EVERY response (this is what was missing!)
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Handle preflight OPTIONS request (CRITICAL for CORS)
  if (req.method === 'OPTIONS') {
    console.log('🚀 CORS preflight request received and handled');
    return res.status(200).end();
  }

  // Only allow POST requests for actual uploads
  if (req.method !== 'POST') {
    console.log(`❌ Method ${req.method} not allowed`);
    return res.status(405).json({ 
      success: false,
      error: 'Method not allowed',
      allowedMethods: ['POST', 'OPTIONS'] 
    });
  }

  const startTime = Date.now();
  console.log(`📁 Starting blob upload from origin: ${req.headers.origin}`);

  try {
    // Enhanced formidable configuration for better performance
    const form = formidable({
      maxFileSize: 100 * 1024 * 1024, // 100MB
      maxTotalFileSize: 100 * 1024 * 1024, // 100MB total
      uploadDir: '/tmp',
      keepExtensions: true,
      allowEmptyFiles: false,
      multiples: false, // Single file only
      filename: (name, ext, part) => {
        // Sanitize filename to prevent issues
        const safeName = part.originalFilename?.replace(/[^a-zA-Z0-9.-]/g, '_') || 'upload';
        return `${Date.now()}-${safeName}`;
      }
    });

    // Parse form with better error handling
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) {
          console.error('📋 Form parsing error:', err.message);
          reject(new Error(`File parsing failed: ${err.message}`));
        } else {
          resolve([fields, files]);
        }
      });
    });

    // Validate file upload
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    
    if (!file) {
      console.log('❌ No file in upload request');
      return res.status(400).json({ 
        success: false,
        error: 'No file uploaded',
        expectedField: 'file'
      });
    }

    // Additional file validation
    if (file.size === 0) {
      console.log('❌ Empty file uploaded');
      return res.status(400).json({ 
        success: false,
        error: 'Empty file not allowed',
        receivedSize: file.size
      });
    }

    // Validate file type (audio files only)
    const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav'];
    const allowedExtensions = ['.mp3', '.m4a', '.wav', '.mp4'];
    const hasValidType = allowedTypes.includes(file.mimetype) || file.mimetype?.startsWith('audio/');
    const hasValidExtension = allowedExtensions.some(ext => 
      file.originalFilename?.toLowerCase().endsWith(ext)
    );

    if (!hasValidType && !hasValidExtension) {
      console.log(`❌ Invalid file type: ${file.mimetype}, filename: ${file.originalFilename}`);
      return res.status(400).json({ 
        success: false,
        error: 'Invalid file type',
        allowedTypes: 'MP3, M4A, WAV, MP4 audio files only',
        receivedType: file.mimetype
      });
    }

    const fileSizeMB = Math.round(file.size / 1024 / 1024);
    console.log(`📁 Processing: ${file.originalFilename} (${fileSizeMB}MB, ${file.mimetype})`);

    // Upload to Vercel Blob with enhanced configuration
    const blob = await put(
      file.originalFilename || 'podcast-episode.mp3', 
      createReadStream(file.filepath), 
      {
        access: 'public',
        addRandomSuffix: true,
        contentType: file.mimetype || 'audio/mpeg'
      }
    );

    const uploadTime = Date.now() - startTime;
    console.log(`✅ Blob uploaded successfully: ${blob.url} (${uploadTime}ms)`);

    // Enhanced cleanup with retry logic
    try {
      const fs = await import('fs');
      await fs.promises.unlink(file.filepath);
      console.log('🧹 Temporary file cleaned up');
    } catch (cleanupError) {
      console.warn('⚠️ Cleanup warning:', cleanupError.message);
      // Non-critical error, don't fail the request
    }

    // Enhanced response format optimized for Uppy v4 with CORS headers already set
    const response = {
      success: true,
      blobUrl: blob.url,
      url: blob.url, // Uppy expects this field
      filename: file.originalFilename,
      size: file.size,
      contentType: file.mimetype,
      uploadTime: uploadTime,
      // Additional metadata for debugging
      metadata: {
        uploadedAt: new Date().toISOString(),
        originalName: file.originalFilename,
        processedName: blob.pathname
      }
    };

    console.log(`🎉 Upload complete for ${file.originalFilename} in ${uploadTime}ms`);
    return res.status(200).json(response);

  } catch (error) {
    const uploadTime = Date.now() - startTime;
    console.error(`❌ Upload failed after ${uploadTime}ms:`, error.message);
    
    // Enhanced error response with CORS headers already set
    const errorResponse = {
      success: false,
      error: error.message || 'Upload failed',
      code: error.code || 'UPLOAD_ERROR',
      uploadTime: uploadTime
    };

    // Add stack trace in development only
    if (process.env.NODE_ENV === 'development') {
      errorResponse.details = error.stack;
    }

    // Return appropriate HTTP status based on error type
    const statusCode = error.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
    return res.status(statusCode).json(errorResponse);
  }
}

// Enhanced Vercel configuration
export const config = {
  api: {
    bodyParser: false, // Required for formidable
    sizeLimit: '100mb',
    externalResolver: true,
    responseLimit: false
  },
  maxDuration: 300 // 5 minutes for large files
};