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

    // Step 2: Get episode metadata from your existing API
    console.log('Getting episode metadata...');
    const metadataResponse = await fetch('https://podcast-api-amber.vercel.app/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: appleUrl })
    });

    console.log('Metadata response status:', metadataResponse.status);

    if (!metadataResponse.ok) {
      const errorText = await metadataResponse.text();
      console.error('Metadata API error:', errorText);
      throw new Error(`Failed to get episode metadata: ${metadataResponse.status} - ${errorText}`);
    }

    // Handle streaming JSON response (multiple JSON objects)
    const metadataText = await metadataResponse.text();
    console.log('Raw metadata response length:', metadataText.length);

    // Parse the streaming response - look for the final success JSON
    let metadata = null;
    const jsonObjects = metadataText.split('\n').filter(line => line.trim());
    
    for (const jsonLine of jsonObjects) {
      try {
        const parsed = JSON.parse(jsonLine);
        if (parsed.status === 'success' && parsed.audio_url) {
          metadata = parsed;
          break;
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }

    if (!metadata) {
      // Try parsing as single JSON if streaming didn't work
      try {
        metadata = JSON.parse(metadataText);
      } catch (parseError) {
        console.error('Could not parse any valid JSON from response:', metadataText.substring(0, 500));
        throw new Error('Invalid response format from metadata API');
      }
    }

    // Check for audio_url (your service returns this field)
    if (!metadata.audio_url) {
      console.error('No audio_url in metadata:', metadata);
      return res.status(400).json({ 
        error: 'Could not extract audio URL from episode',
        metadata: metadata
      });
    }

    console.log('Found audio URL:', metadata.audio_url);

    // Step 3: Download audio file and upload to your Vercel Blob storage
    console.log('Downloading audio file...');
    const audioResponse = await fetch(metadata.audio_url);
    
    if (!audioResponse.ok) {
      throw new Error(`Failed to download audio file: ${audioResponse.status} - ${audioResponse.statusText}`);
    }

    // Get file info
    const contentLength = audioResponse.headers.get('content-length');
    const contentType = audioResponse.headers.get('content-type') || 'audio/mpeg';
    
    console.log(`Audio file size: ${contentLength} bytes, type: ${contentType}`);

    // Create filename
    const filename = `apple-podcast-${episodeId}-${Date.now()}.mp3`;
    
    // Upload to your Vercel Blob storage (same as your working MP3 system)
    console.log('Uploading to Vercel Blob storage...');
    const blob = await put(filename, audioResponse.body, {
      access: 'public',
      contentType: contentType
    });

    console.log('Blob upload successful:', blob.url);

    // Step 4: Route to your existing analyze-from-blob.js API
    console.log('Starting TROOP analysis...');
    const baseUrl = req.headers.origin || 'https://podcast-growth-agent.vercel.app';
    const analysisResponse = await fetch(`${baseUrl}/api/analyze-from-blob`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blobUrl: blob.url,
        filename: filename,
        title: title || metadata.title || 'Apple Podcast Episode'
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
        title: metadata.title,
        duration: metadata.duration,
        publishDate: metadata.publishDate,
        originalUrl: appleUrl,
        podcastTitle: metadata.podcast_title
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
    // Apple Podcast URLs typically look like:
    // https://podcasts.apple.com/us/podcast/episode-title/id123456789?i=1000567890123
    const match = url.match(/[?&]i=(\d+)/);
    return match ? match[1] : null;
  } catch (error) {
    console.error('Error extracting episode ID:', error);
    return null;
  }
}