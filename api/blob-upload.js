import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        console.log(`📁 Authorizing upload: ${pathname}`);
        
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
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('✅ Blob upload completed:', blob.url);
        console.log('📝 Token payload:', tokenPayload);
      },
    });

    res.json(jsonResponse);
  } catch (error) {
    console.error('❌ Blob upload error:', error);
    res.status(400).json({ error: error.message });
  }
}