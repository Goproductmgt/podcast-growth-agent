// api/upload-handler.js - Official Vercel client upload pattern
import { handleUpload } from '@vercel/blob/client';
import { setCorsHeaders, handleCorsPrelight } from '../lib/cors.js';

export default async function handler(req, res) {
  console.log(`🔄 Client upload handler called from: ${req.headers.origin}`);
  
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

  try {
    console.log('🔄 Processing handleUpload request');
    
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        console.log('🎯 Generating token for:', pathname);
        console.log('📦 Client payload:', clientPayload);
        
        // Validate file extension
        const allowedExtensions = ['.mp3', '.m4a', '.wav', '.mp4'];
        const hasValidExtension = allowedExtensions.some(ext => 
          pathname.toLowerCase().endsWith(ext)
        );
        
        if (!hasValidExtension) {
          throw new Error(`Invalid file type. Allowed: ${allowedExtensions.join(', ')}`);
        }
        
        console.log('✅ Token generation approved for:', pathname);
        
        // Return the configuration for client upload
        return {
          allowedContentTypes: [
            'audio/mpeg', 
            'audio/mp3', 
            'audio/mp4', 
            'audio/x-m4a', 
            'audio/wav',
            'video/mp4'
          ],
          maxFileSize: 100 * 1024 * 1024, // 100MB
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            uploadedAt: new Date().toISOString(),
            source: 'podcast-growth-agent',
            filename: pathname
          })
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('🎉 Large file uploaded successfully:', blob.url);
        console.log('📦 Token payload:', tokenPayload);
        
        // Return the blob info - this gets sent back to the client
        return { 
          success: true,
          uploadedAt: new Date().toISOString(),
          blobUrl: blob.url,
          size: blob.size
        };
      }
    });

    console.log('✅ handleUpload completed successfully');
    return res.json(jsonResponse);
    
  } catch (error) {
    console.error('❌ Client upload handler error:', error);
    console.error('🔍 Error stack:', error.stack);
    
    return res.status(400).json({ 
      error: error.message || 'Client upload failed',
      code: error.code || 'CLIENT_UPLOAD_ERROR'
    });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
  maxDuration: 300
};