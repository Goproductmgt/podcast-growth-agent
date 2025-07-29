// api/upload-handler.js - Hybrid client upload handler
import { handleUpload } from '@vercel/blob/client';
import { setCorsHeaders, handleCorsPrelight } from '../lib/cors.js';

export default async function handler(req, res) {
  console.log(`🔄 Client upload handler called from: ${req.headers.origin}`);
  console.log('📦 Request method:', req.method);
  console.log('📋 Request body type:', typeof req.body);
  
  // Set CORS headers
  setCorsHeaders(res, req.headers.origin);
  
  // Handle preflight
  if (handleCorsPrelight(req, res)) {
    return;
  }

  if (req.method !== 'POST') {
    console.log(`❌ Method ${req.method} not allowed in client upload handler`);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    console.log('📋 Processing client upload request body:', JSON.stringify(body, null, 2));
    
    // Check if this is a token generation request or handleUpload request
    if (body.type === 'blob.generate-client-token') {
      console.log('🎯 Generating client token for direct upload');
      
      // This is a direct token request - we'll use a simpler approach
      const pathname = body.payload?.pathname || 'podcast-episode.mp3';
      
      // Validate file extension
      const allowedExtensions = ['.mp3', '.m4a', '.wav', '.mp4'];
      const hasValidExtension = allowedExtensions.some(ext => 
        pathname.toLowerCase().endsWith(ext)
      );
      
      if (!hasValidExtension) {
        throw new Error(`Invalid file type. Allowed: ${allowedExtensions.join(', ')}`);
      }
      
      // For now, let's fall back to your working get-upload-url approach
      console.log('🔄 Redirecting to get-upload-url for token generation');
      
      return res.status(400).json({
        error: 'Use get-upload-url endpoint for token generation',
        redirect: '/api/get-upload-url'
      });
      
    } else {
      // This is a standard handleUpload request from the Vercel SDK
      console.log('🔄 Processing standard handleUpload request');
      
      const jsonResponse = await handleUpload({
        body,
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
          
          return { 
            success: true,
            uploadedAt: new Date().toISOString()
          };
        }
      });

      console.log('✅ handleUpload completed successfully');
      return res.json(jsonResponse);
    }
    
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