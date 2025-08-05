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

    console.log('Starting Apple Podcast analysis for:', appleUrl);

    // Step 1: Extract episode ID from Apple Podcast URL
    const episodeId = extractEpisodeId(appleUrl);
    if (!episodeId) {
      return res.status(400).json({ error: 'Invalid Apple Podcast URL format' });
    }

    console.log('Extracted episode ID:', episodeId);

    // Step 2: Get audio URL using simple regex (avoid JSON parsing issues)
    console.log('Getting episode metadata...');
    const metadataResponse = await fetch('https://podcast-api-amber.vercel.app/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: appleUrl })
    });

    if (!metadataResponse.ok) {
      throw new Error(`Metadata service failed: ${metadataResponse.status}`);
    }

    const responseText = await metadataResponse.text();
    console.log('Got metadata response, extracting audio URL...');

    // Extract audio URL using regex (avoids JSON parsing issues)
    const audioUrlMatch = responseText.match(/"audio_url":"([^"]+)"/);
    const titleMatch = responseText.match(/"title":"([^"]+)"/);
    
    if (!audioUrlMatch) {
      console.error('No audio URL found in response');
      return res.status(400).json({ 
        error: 'Could not extract audio URL from episode' 
      });
    }

    const audioUrl = audioUrlMatch[1];
    const episodeTitle = titleMatch ? titleMatch[1] : (title || 'Apple Podcast Episode');
    
    console.log('Found audio URL:', audioUrl);
    console.log('Episode title:', episodeTitle);

    // EVERYTHING BELOW IS IDENTICAL TO YOUR WORKING MP3 SYSTEM

    // Step 3: Download audio file (same as MP3 upload)
    console.log('Downloading audio file...');
    const audioResponse = await fetch(audioUrl);
    
    if (!audioResponse.ok) {
      throw new Error(`Failed to download audio file: ${audioResponse.status} - ${audioResponse.statusText}`);
    }

    // Get file info (same as MP3 upload)
    const contentLength = audioResponse.headers.get('content-length');
    const contentType = audioResponse.headers.get('content-type') || 'audio/mpeg';
    
    console.log(`Audio file size: ${contentLength} bytes, type: ${contentType}`);

    // Create filename (same pattern as MP3 upload)
    const filename = `apple-podcast-${episodeId}-${Date.now()}.mp3`;
    
    // Step 4: Upload to Vercel Blob (IDENTICAL to your MP3 system)
    console.log('Uploading to Vercel Blob storage...');
    const blob = await put(filename, audioResponse.body, {
      access: 'public',
      contentType: contentType
    });

    console.log('Blob upload successful:', blob.url);

    // Step 5: Route to your PROVEN analyze-from-blob.js API (IDENTICAL to MP3 system)
    console.log('Starting TROOP analysis...');
    const baseUrl = req.headers.origin || 'https://podcast-growth-agent.vercel.app';
    const analysisResponse = await fetch(`${baseUrl}/api/analyze-from-blob`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blobUrl: blob.url,
        filename: filename,
        title: episodeTitle
      })
    });

    if (!analysisResponse.ok) {
      const errorText = await analysisResponse.text();
      console.error('Analysis API error:', errorText);
      throw new Error(`Analysis failed: ${analysisResponse.status} - ${errorText}`);
    }

    const analysisResult = await analysisResponse.json();
    
    console.log('Analysis completed successfully');

    // Return the same format as your working MP3 system
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
    console.error('Apple Podcast analysis error:', error);
    return res.status(500).json({ 
      error: 'Analysis failed', 
      details: error.message
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