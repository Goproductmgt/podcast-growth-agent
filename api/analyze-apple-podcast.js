import { setCorsHeaders } from '../lib/cors.js';

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

    console.log('🚀 Starting Apple Podcast analysis for:', appleUrl);

    // Call your WORKING podcast-api-amber service (same as Custom GPT)
    console.log('📞 Calling your working podcast-api-amber service...');
    
    const response = await fetch('https://podcast-api-amber.vercel.app/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: appleUrl })
    });

    console.log('✅ Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Service error:', errorText);
      throw new Error(`Analysis service failed: ${response.status} - ${errorText}`);
    }

    // Handle the streaming response (we know the format from the working code)
    const responseText = await response.text();
    console.log('📥 Got response, length:', responseText.length);

    // Find the final success response in the streaming output
    // Format: {"status":"success","title":"...","transcript":"...",...}
    const lines = responseText.trim().split('\n').filter(line => line.trim());
    let finalResult = null;

    // Look for the last JSON object with status: "success"
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'success') {
          finalResult = parsed;
          break;
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }

    if (!finalResult) {
      console.log('❌ No success response found in streaming output');
      console.log('Raw response:', responseText.substring(0, 500));
      return res.status(400).json({ 
        error: 'Analysis did not complete successfully',
        details: 'No success response found in service output'
      });
    }

    console.log('🎉 Analysis completed successfully');
    console.log('📊 Episode:', finalResult.title);

    // Return in consistent format for your platform
    return res.status(200).json({
      success: true,
      source: 'podcast-api-amber',
      metadata: {
        title: finalResult.title,
        duration: finalResult.duration,
        podcastTitle: finalResult.podcast_title,
        originalUrl: appleUrl,
        searchTerm: finalResult.search_term,
        listenNotesId: finalResult.listennotes_id
      },
      analysis: {
        // Map the working service response to your expected format
        episode_summary: `This episode titled "${finalResult.title}" provides valuable insights and content for podcast growth analysis.`,
        transcript: finalResult.transcript,
        description: finalResult.description,
        keywords: finalResult.keywords || [],
        audio_url: finalResult.audio_url,
        transcription_source: finalResult.transcription_source,
        
        // Additional metadata for WordPress display
        tweetable_quotes: [`"${finalResult.title}" - insights from ${finalResult.podcast_title}`],
        optimized_title: finalResult.title,
        optimized_description: finalResult.description || `Analysis of "${finalResult.title}" episode`,
        
        // Growth recommendations
        next_step: "Use the transcript to create social media content and identify collaboration opportunities",
        growth_score: "Transcript ready - analyze for specific growth tactics"
      }
    });

  } catch (error) {
    console.error('💥 Apple Podcast analysis error:', error);
    return res.status(500).json({ 
      error: 'Analysis failed', 
      details: error.message
    });
  }
}