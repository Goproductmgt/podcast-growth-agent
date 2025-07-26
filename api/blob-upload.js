// api/blob-upload.js - CORRECT implementation for large files
import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        console.log(`📁 Authorizing upload: ${pathname}`);
        
        // Generate token for client-side upload (this bypasses the 4.5MB limit)
        return {
          allowedContentTypes: [
            'audio/mp3',
            'audio/mpeg',
            'audio/mp4', 
            'audio/wav',
            'audio/m4a'
          ],
          tokenPayload: JSON.stringify({
            uploadedAt: new Date().toISOString(),
            // Add any metadata you want to track
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('✅ Blob upload completed:', blob.url);
        console.log('📝 Token payload:', tokenPayload);
        
        // Optional: You could trigger analysis here automatically
        // But for now, we'll let the frontend handle it
      },
    });

    res.json(jsonResponse);
  } catch (error) {
    console.error('❌ Blob upload error:', error);
    res.status(400).json({ error: error.message });
  }
}

// This config is important - it tells Vercel this endpoint handles client uploads
export const config = {
  api: {
    bodyParser: false,
  },
};