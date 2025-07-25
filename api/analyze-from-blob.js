import FormData from 'form-data';

const APP_CONFIG = {
  GROQ: {
    API_URL: 'https://api.groq.com/openai/v1/audio/transcriptions',
    MODEL: 'whisper-large-v3-turbo',
    RESPONSE_FORMAT: 'text',
  },
  OPENAI: {
    CHAT_URL: 'https://api.openai.com/v1/chat/completions',
    ANALYSIS_MODEL: 'gpt-4o-mini',
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  try {
    const { blobUrl, filename, title } = req.body;

    if (!blobUrl) {
      return res.status(400).json({ error: 'Blob URL is required' });
    }

    console.log(`📥 Processing from blob: ${filename}`);

    res.write(JSON.stringify({
      status: 'processing',
      progress: 10,
      message: `📁 Downloading from blob: ${filename}`,
      next_step: 'Starting transcription...'
    }) + '\n');

    const { default: fetch } = await import('node-fetch');
    const fileResponse = await fetch(blobUrl);
    
    if (!fileResponse.ok) {
      throw new Error(`Failed to download from blob: ${fileResponse.statusText}`);
    }

    const fileBuffer = await fileResponse.buffer();
    console.log(`📁 Downloaded ${fileBuffer.length} bytes from blob`);

    res.write(JSON.stringify({
      status: 'processing',
      progress: 30,
      message: '⚡ Starting Groq transcription...',
      file_size: fileBuffer.length
    }) + '\n');

    const transcriptionResult = await transcribeWithGroq(fileBuffer, filename);

    res.write(JSON.stringify({
      status: 'processing',
      progress: 70,
      message: '✅ Transcription complete, analyzing...',
      transcript_length: transcriptionResult.transcript.length
    }) + '\n');

    const analysis = await analyzeWithTROOP(transcriptionResult.transcript, title, filename);

    res.write(JSON.stringify({
      status: 'processing',
      progress: 90,
      message: '🧠 Finalizing results...'
    }) + '\n');

    const processingTime = Date.now() - startTime;
    const finalResponse = {
      status: 'success',
      filename,
      title: title || filename,
      transcript: transcriptionResult.transcript,
      analysis,
      metadata: {
        audio_metrics: transcriptionResult.metrics,
        processing_time_ms: processingTime,
        source: 'Vercel Blob + Groq + GPT',
        processed_at: new Date().toISOString(),
        api_version: '4.0-blob',
        blob_url: blobUrl
      }
    };

    res.write(JSON.stringify(finalResponse) + '\n');
    res.end();

    console.log(`✅ Blob analysis completed in ${processingTime}ms`);

  } catch (error) {
    console.error('❌ Blob analysis failed:', error);
    
    const processingTime = Date.now() - startTime;
    res.write(JSON.stringify({
      status: 'error',
      error: error.message,
      processing_time_ms: processingTime,
      suggestions: ['Check that the blob URL is accessible', 'Ensure file is a valid audio format']
    }) + '\n');
    res.end();
  }
}

async function transcribeWithGroq(fileBuffer, filename) {
  const groqApiKey = process.env.GROQ_API_KEY;
  
  if (!groqApiKey) {
    throw new Error('Groq API key not configured');
  }

  try {
    const formData = new FormData();
    formData.append('file', fileBuffer, {
      filename: filename,
      contentType: 'audio/mpeg'
    });
    formData.append('model', APP_CONFIG.GROQ.MODEL);
    formData.append('response_format', APP_CONFIG.GROQ.RESPONSE_FORMAT);

    const { default: fetch } = await import('node-fetch');
    
    const response = await fetch(APP_CONFIG.GROQ.API_URL, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${groqApiKey}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error: ${response.status} ${errorText}`);
    }

    const transcript = await response.text();
    
    const durationEstimate = transcript.length / 8;
    const metrics = {
      durationSeconds: Math.round(durationEstimate),
      durationMinutes: Math.round(durationEstimate / 60),
      confidence: 'estimated',
      source: 'groq'
    };
    
    return { transcript, metrics };

  } catch (error) {
    throw new Error(`Transcription failed: ${error.message}`);
  }
}

async function analyzeWithTROOP(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    return createFallbackAnalysis(transcript, episodeTitle);
  }

  const analysisPrompt = `You are Podcast Growth Agent. Analyze this episode using the TROOP framework.

Episode Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

TRANSCRIPT:
${transcript}

Provide analysis in this EXACT JSON format:
{
  "episode_summary": "Engaging 2-3 sentence summary",
  "tweetable_quotes": ["Quote 1", "Quote 2"],
  "topics_keywords": ["keyword1", "keyword2", "keyword3"],
  "optimized_title": "SEO-optimized title",
  "optimized_description": "Compelling description",
  "community_suggestions": [{"name": "Community", "platform": "Platform", "url": "URL", "why": "Reason"}],
  "cross_promo_matches": [{"podcast_name": "Podcast", "host_name": "Host", "contact_info": "Contact", "collaboration_angle": "Why"}],
  "trend_piggyback": "How to connect to trends",
  "social_caption": "Social media caption",
  "next_step": "One specific action",
  "growth_score": "Score/100 with explanation"
}

Respond ONLY with valid JSON.`;

  try {
    const { default: fetch } = await import('node-fetch');
    
    const response = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
        messages: [
          { role: 'system', content: 'You are Podcast Growth Agent. Respond with valid JSON only.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.7,
        max_tokens: 3000
      })
    });

    if (!response.ok) {
      return createFallbackAnalysis(transcript, episodeTitle);
    }

    const result = await response.json();
    const analysisText = result.choices[0]?.message?.content;
    
    if (analysisText) {
      return JSON.parse(analysisText);
    }
    
    return createFallbackAnalysis(transcript, episodeTitle);

  } catch (error) {
    return createFallbackAnalysis(transcript, episodeTitle);
  }
}

function createFallbackAnalysis(transcript, episodeTitle) {
  return {
    episode_summary: "Episode successfully transcribed. AI analysis temporarily unavailable.",
    tweetable_quotes: ["🎙️ New episode transcribed and ready for optimization!"],
    topics_keywords: ["podcast", "content", "growth", "strategy"],
    optimized_title: episodeTitle || "Optimize This Episode Title",
    optimized_description: "Use the transcript to craft an engaging description.",
    community_suggestions: [{ name: "Podcasting", platform: "Reddit", url: "https://reddit.com/r/podcasting", why: "Community feedback" }],
    cross_promo_matches: [{ podcast_name: "Analysis pending", host_name: "Please try again", contact_info: "Service restoration in progress", collaboration_angle: "Future partnership opportunities" }],
    trend_piggyback: "Review transcript for trending topics.",
    social_caption: "🎙️ New episode ready! #podcast #content",
    next_step: "Review transcript and create social media posts",
    growth_score: "Transcript ready - manual analysis recommended"
  };
}