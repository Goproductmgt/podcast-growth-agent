import { setCorsHeaders } from '../lib/cors.js';
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  // Set CORS headers using your proven solution
  setCorsHeaders(res, req.headers.origin);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { appleUrl, title } = req.body;

    if (!appleUrl) {
      return res.status(400).json({ error: 'Apple Podcast URL is required' });
    }

    console.log('🚀 STEP 1: Starting Apple Podcast analysis for:', appleUrl);

    // Step 1: Extract episode ID from Apple Podcast URL
    const episodeId = extractEpisodeId(appleUrl);
    if (!episodeId) {
      return res.status(400).json({ error: 'Invalid Apple Podcast URL format' });
    }

    console.log('✅ STEP 2: Extracted episode ID:', episodeId);

    // Step 2: Get audio URL with detailed debugging
    console.log('🔍 STEP 3: Getting episode metadata...');
    
    let metadataResponse;
    try {
      metadataResponse = await fetch('https://podcast-api-amber.vercel.app/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: appleUrl })
      });
      console.log('✅ STEP 4: Metadata service responded with status:', metadataResponse.status);
    } catch (fetchError) {
      console.log('❌ STEP 4 FAILED: Fetch error:', fetchError.message);
      throw new Error(`Metadata service fetch failed: ${fetchError.message}`);
    }

    if (!metadataResponse.ok) {
      console.log('❌ STEP 4 FAILED: Bad status:', metadataResponse.status);
      throw new Error(`Metadata service failed: ${metadataResponse.status}`);
    }

    let responseText;
    try {
      responseText = await metadataResponse.text();
      console.log('✅ STEP 5: Got response text, length:', responseText.length);
      console.log('🔍 STEP 5: Response preview:', responseText.substring(0, 300));
    } catch (textError) {
      console.log('❌ STEP 5 FAILED: Text extraction error:', textError.message);
      throw new Error(`Failed to read metadata response: ${textError.message}`);
    }

    // Extract audio URL with detailed debugging
    console.log('🔍 STEP 6: Extracting audio URL with regex...');
    
    const audioUrlMatches = responseText.match(/"audio_url":"([^"]+)"/g);
    console.log('🔍 STEP 6: Found audio URL matches:', audioUrlMatches ? audioUrlMatches.length : 0);
    
    if (!audioUrlMatches || audioUrlMatches.length === 0) {
      console.log('❌ STEP 6 FAILED: No audio URL found');
      console.log('Full response for debugging:', responseText);
      return res.status(400).json({ 
        error: 'Could not extract audio URL from episode',
        responsePreview: responseText.substring(0, 500),
        fullResponse: responseText
      });
    }

    // Use the last audio_url match
    const lastAudioUrlMatch = audioUrlMatches[audioUrlMatches.length - 1];
    const audioUrl = lastAudioUrlMatch.match(/"audio_url":"([^"]+)"/)[1];
    console.log('✅ STEP 7: Extracted audio URL:', audioUrl);

    // Extract title
    const titleMatches = responseText.match(/"title":"([^"]+)"/g);
    let episodeTitle = title || 'Apple Podcast Episode';
    if (titleMatches && titleMatches.length > 0) {
      const lastTitleMatch = titleMatches[titleMatches.length - 1];
      episodeTitle = lastTitleMatch.match(/"title":"([^"]+)"/)[1];
    }
    console.log('✅ STEP 8: Episode title:', episodeTitle);

    // Download audio file
    console.log('🔍 STEP 9: Downloading audio file...');
    let audioResponse;
    try {
      audioResponse = await fetch(audioUrl);
      console.log('✅ STEP 10: Audio download response status:', audioResponse.status);
    } catch (downloadError) {
      console.log('❌ STEP 10 FAILED: Audio download error:', downloadError.message);
      throw new Error(`Failed to download audio: ${downloadError.message}`);
    }
    
    if (!audioResponse.ok) {
      console.log('❌ STEP 10 FAILED: Bad audio download status:', audioResponse.status);
      throw new Error(`Failed to download audio file: ${audioResponse.status} - ${audioResponse.statusText}`);
    }

    // Get file info
    const contentLength = audioResponse.headers.get('content-length');
    const contentType = audioResponse.headers.get('content-type') || 'audio/mpeg';
    console.log('✅ STEP 11: Audio file size:', contentLength, 'bytes, type:', contentType);

    // Create filename
    const filename = `apple-podcast-${episodeId}-${Date.now()}.mp3`;
    console.log('✅ STEP 12: Generated filename:', filename);
    
    // Upload to Vercel Blob
    console.log('🔍 STEP 13: Uploading to Vercel Blob storage...');
    let blob;
    try {
      blob = await put(filename, audioResponse.body, {
        access: 'public',
        contentType: contentType
      });
      console.log('✅ STEP 14: Blob upload successful:', blob.url);
    } catch (blobError) {
      console.log('❌ STEP 14 FAILED: Blob upload error:', blobError.message);
      throw new Error(`Blob upload failed: ${blobError.message}`);
    }

    // Handle streaming response from analyze-from-blob.js (same pattern as metadata service)
    console.log('🔍 STEP 15: Starting TROOP analysis...');
    const baseUrl = req.headers.origin || 'https://podcast-growth-agent.vercel.app';
    const analysisPayload = {
      blobUrl: blob.url,
      filename: filename,
      title: episodeTitle
    };
    console.log('🔍 STEP 15: Analysis payload:', JSON.stringify(analysisPayload));

    let analysisResponse;
    try {
      analysisResponse = await fetch(`${baseUrl}/api/analyze-from-blob`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(analysisPayload)
      });
      console.log('✅ STEP 16: Analysis API responded with status:', analysisResponse.status);
    } catch (analysisError) {
      console.log('❌ STEP 16 FAILED: Analysis API fetch error:', analysisError.message);
      throw new Error(`Analysis API fetch failed: ${analysisError.message}`);
    }

    if (!analysisResponse.ok) {
      const errorText = await analysisResponse.text();
      console.log('❌ STEP 16 FAILED: Analysis API error response:', errorText);
      throw new Error(`Analysis failed: ${analysisResponse.status} - ${errorText}`);
    }

    // Handle streaming JSON response from analyze-from-blob.js
    const analysisText = await analysisResponse.text();
    console.log('✅ STEP 17: Got analysis response, length:', analysisText.length);
    console.log('🔍 STEP 17: Analysis response preview:', analysisText.substring(0, 300));

    // Find the final success response (same pattern as metadata extraction)
    const successMatches = analysisText.match(/\{"status":"success"[^}]*\}/g);
    
    if (!successMatches || successMatches.length === 0) {
      console.log('❌ STEP 17 FAILED: No success response found in analysis');
      console.log('Full analysis response:', analysisText);
      throw new Error('Analysis did not complete successfully');
    }

    // Use the last success response
    const lastSuccessMatch = successMatches[successMatches.length - 1];
    
    let analysisResult;
    try {
      // Parse the complete success JSON object
      const fullResponsePattern = /(\{"status":"success".*?\n)/s;
      const fullMatch = analysisText.match(fullResponsePattern);
      
      if (fullMatch) {
        analysisResult = JSON.parse(fullMatch[1].trim());
        console.log('✅ STEP 18: Successfully parsed analysis result');
      } else {
        throw new Error('Could not extract complete success response');
      }
    } catch (parseError) {
      console.log('❌ STEP 18 FAILED: Could not parse analysis result:', parseError.message);
      console.log('Attempted to parse:', lastSuccessMatch);
      throw new Error(`Failed to parse analysis result: ${parseError.message}`);
    }

    // Return success
    console.log('🎉 SUCCESS: Returning results');
    return res.status(200).json({
      success: true,
      blobUrl: blob.url,
      metadata: {
        title: episodeTitle,
        originalUrl: appleUrl
      },
      analysis: analysisResult
    });

  } catch (error) {
    console.log('💥 FINAL ERROR:', error.message);
    console.log('💥 ERROR STACK:', error.stack);
    return res.status(500).json({ 
      error: 'Analysis failed', 
      details: error.message,
      step: 'Check console logs for detailed step-by-step debugging'
    });
  }
}

// Helper function to extract episode ID from Apple Podcast URL
function extractEpisodeId(url) {
  try {
    const match = url.match(/[?&]i=(\d+)/);
    return match ? match[1] : null;
  } catch (error) {
    console.error('Error extracting episode ID:', error);
    return null;
  }
}