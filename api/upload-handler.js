// api/upload-handler.js - Official Vercel client upload handler
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
    console.log(`❌ Method ${req.method} not allowed in client upload handler`);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('📋 Parsing client upload request body...');
    const body = req.body; // Next.js parses JSON automatically when bodyParser: true
    
    console.log('🔄 Starting handleUpload with body:', JSON.stringify(body, null, 2));
    
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
            'video/mp4' // Some podcast files are video/mp4
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
        
        try {
          const payload = JSON.parse(tokenPayload || '{}');
          console.log('📊 Upload metadata:', payload);
        } catch (e) {
          console.log('⚠️ Could not parse token payload');
        }
        
        // This callback runs after successful upload
        // Perfect place for logging, webhooks, database updates, etc.
        return { 
          success: true,
          uploadedAt: new Date().toISOString()
        };
      }
    });

    console.log('✅ handleUpload completed successfully');
    console.log('📤 Sending response:', JSON.stringify(jsonResponse, null, 2));
    
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
    bodyParser: true, // Different from server uploads - we need JSON parsing
  },
  maxDuration: 300 // 5 minutes for token generation and callbacks
};