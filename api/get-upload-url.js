// api/get-upload-url.js - Generate presigned URLs for client uploads
import { handleUpload } from '@vercel/blob/client';
import { setCorsHeaders, handleCorsPrelight } from '../lib/cors.js';

export default async function handler(req, res) {
  // Set CORS headers for cross-origin requests
  setCorsHeaders(res, req.headers.origin);
  
  // Handle preflight OPTIONS request
  if (handleCorsPrelight(req, res)) {
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    console.log(`❌ Method ${req.method} not allowed`);
    return res.status(405).json({ 
      success: false,
      error: 'Method not allowed',
      allowedMethods: ['POST', 'OPTIONS'] 
    });
  }

  const startTime = Date.now();
  console.log(`🔗 Generating presigned URL from origin: ${req.headers.origin}`);

  try {
    // Parse request body
    const { filename, contentType } = req.body;

    if (!filename) {
      return res.status(400).json({
        success: false,
        error: 'Filename is required'
      });
    }

    // Validate file type (audio files only)
    const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav'];
    const allowedExtensions = ['.mp3', '.m4a', '.wav', '.mp4'];
    
    const hasValidType = allowedTypes.includes(contentType) || contentType?.startsWith('audio/');
    const hasValidExtension = allowedExtensions.some(ext => 
      filename.toLowerCase().endsWith(ext)
    );

    if (!hasValidType && !hasValidExtension) {
      console.log(`❌ Invalid file type: ${contentType}, filename: ${filename}`);
      return res.status(400).json({ 
        success: false,
        error: 'Invalid file type',
        allowedTypes: 'MP3, M4A, WAV, MP4 audio files only',
        receivedType: contentType
      });
    }

    console.log(`🎵 Generating URL for: ${filename} (${contentType})`);

    // Use Vercel Blob's handleUpload to generate presigned URL
    const jsonResponse = await handleUpload({
      body: {
        type: 'blob.generate-client-token',
        payload: {
          pathname: filename,
          callbackUrl: `${req.headers.origin || 'https://podcastgrowthagent.com'}/api/upload-callback`,
        },
      },
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        console.log(`🔐 Generating token for: ${pathname}`);
        
        return {
          allowedContentTypes: [contentType || 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav'],
          addRandomSuffix: true,
          maximumSizeInBytes: 100 * 1024 * 1024, // 100MB limit
          tokenPayload: JSON.stringify({
            filename: filename,
            uploadedAt: new Date().toISOString(),
            origin: req.headers.origin
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log(`✅ Client upload completed: ${blob.url}`);
        
        try {
          // Optional: Log successful uploads or trigger additional processing
          const payload = JSON.parse(tokenPayload || '{}');
          console.log(`📊 Upload metadata:`, { 
            filename: payload.filename, 
            blobUrl: blob.url,
            size: blob.size 
          });
        } catch (error) {
          console.warn('⚠️ Failed to parse token payload:', error.message);
        }
      },
    });

    const processingTime = Date.now() - startTime;
    console.log(`🎉 Presigned URL generated in ${processingTime}ms`);

    // Return the response from handleUpload (contains token and upload instructions)
    return res.status(200).json({
      success: true,
      ...jsonResponse,
      metadata: {
        filename: filename,
        contentType: contentType,
        processingTime: processingTime,
        generatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`❌ Presigned URL generation failed after ${processingTime}ms:`, error.message);
    
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate upload URL',
      code: error.code || 'URL_GENERATION_ERROR',
      processingTime: processingTime
    });
  }
}

// Vercel configuration
export const config = {
  api: {
    bodyParser: true, // We need to parse JSON body
    sizeLimit: '1mb', // Small requests only (just filename + metadata)
    externalResolver: true,
  },
  maxDuration: 30 // Should be very fast - just generating URLs
};