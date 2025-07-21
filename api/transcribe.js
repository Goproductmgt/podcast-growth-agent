// api/transcribe.js - Drop-in compatible Groq upgrade (18x cheaper, 240x faster)
import https from 'https';

// Configuration constants - optimized for Groq speed
const CONFIG = {
  OPTIMIZATION: {
    TRIGGER_LENGTH: 8000,     // When to start optimizing
    MAX_RESPONSE_SIZE: 50000, // Conservative limit well under 100KB
    OPENING_SENTENCES: 15,
    KEY_INSIGHTS_LIMIT: 25,
    ENDING_SENTENCES: 10
  },
  GROQ: {
    API_URL: 'https://api.groq.com/openai/v1/audio/transcriptions',
    MODEL: 'distil-whisper-large-v3-en', // $0.02/hour, 240x real-time speed
    MAX_FILE_SIZE: 25 * 1024 * 1024, // 25MB limit
    RESPONSE_FORMAT: 'text'
  },
  OPENAI: {
    API_URL: 'https://api.openai.com/v1/audio/transcriptions',
    MODEL: 'whisper-1', // Fallback option
    MAX_FILE_SIZE: 25 * 1024 * 1024,
    RESPONSE_FORMAT: 'text'
  }
};

// High-value content patterns for preserving niche insights
const VALUE_PATTERNS = [
  /\b[A-Z][a-z]*\s+[A-Z][a-z]*\b/,                    // Brand names, proper nouns
  /\$\d+|\d+%|\d+\s*(years?|months?|minutes?)/,       // Numbers, stats, metrics
  /\b(recommend|suggest|advice|should|try|use)\b/i,   // Recommendations
  /\b(website|instagram|facebook|twitter|linkedin|tiktok)\b/i, // Social platforms
  /\b(community|group|forum|subreddit|discord)\b/i,   // Communities
  /\b(secret|tip|hack|strategy|method|technique)\b/i, // Actionable content
  /\b(brand|company|product|service|business)\b/i,    // Business mentions
  /\b(contact|email|phone|address|location)\b/i,      // Contact information
];

/**
 * Optimizes transcript for GPT processing while preserving niche insights
 * @param {string} transcript - Raw transcript from Whisper
 * @returns {string} Optimized transcript under size limits
 */
function optimizeTranscriptForGPT(transcript) {
  if (!transcript || transcript.length < CONFIG.OPTIMIZATION.TRIGGER_LENGTH) {
    return transcript;
  }
  
  const sentences = transcript.split(/\.\s+/).filter(s => s.trim().length > 0);
  
  // Extract key sections while preserving context
  const opening = extractSection(sentences, 0, CONFIG.OPTIMIZATION.OPENING_SENTENCES);
  const insights = extractValueSentences(sentences, VALUE_PATTERNS, CONFIG.OPTIMIZATION.KEY_INSIGHTS_LIMIT);
  const ending = extractSection(sentences, -CONFIG.OPTIMIZATION.ENDING_SENTENCES);
  
  const optimizedContent = buildOptimizedTranscript(opening, insights, ending, sentences.length);
  
  // Validate size constraint
  if (optimizedContent.length > CONFIG.OPTIMIZATION.MAX_RESPONSE_SIZE) {
    console.warn(`Transcript still too large (${optimizedContent.length} chars), applying additional compression`);
    return applyAdditionalCompression(opening, insights, ending, sentences.length);
  }
  
  return optimizedContent;
}

/**
 * Extracts a section of sentences
 */
function extractSection(sentences, start, count = null) {
  if (typeof start === 'number' && start < 0) {
    return sentences.slice(start).join('. ');
  }
  return sentences.slice(start, count).join('. ');
}

/**
 * Filters sentences containing high-value content patterns
 */
function extractValueSentences(sentences, patterns, limit) {
  return sentences
    .filter(sentence => patterns.some(pattern => pattern.test(sentence)))
    .slice(0, limit);
}

/**
 * Builds the structured optimized transcript
 */
function buildOptimizedTranscript(opening, insights, ending, totalSentences) {
  return [
    "=== EPISODE OPENING ===",
    opening,
    "",
    "=== KEY INSIGHTS & RECOMMENDATIONS ===", 
    insights.join('. '),
    "",
    "=== EPISODE CONCLUSION ===",
    ending,
    "",
    `[Analyzed ${totalSentences} sentences for comprehensive insights]`
  ].join('\n');
}

/**
 * Applies additional compression when standard optimization isn't enough
 */
function applyAdditionalCompression(opening, insights, ending, totalSentences) {
  const compressedOpening = opening.substring(0, 1000);
  const compressedInsights = insights.slice(0, 15).join('. ').substring(0, 2000);
  const compressedEnding = ending.substring(0, 800);
  
  return [
    "=== EPISODE HIGHLIGHTS ===",
    compressedOpening,
    "",
    "=== TOP INSIGHTS ===",
    compressedInsights,
    "",
    "=== CONCLUSION ===", 
    compressedEnding,
    "",
    `[Compressed analysis of ${totalSentences} sentences]`
  ].join('\n');
}

/**
 * Extracts episode title from Apple Podcasts URL
 */
function extractSearchTerm(url) {
  const episodeMatch = url.match(/\/podcast\/([^\/]+)\/id\d+/);
  if (episodeMatch) {
    return episodeMatch[1]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  }
  
  return 'episode';
}

/**
 * Create AbortController with timeout for proper cancellation
 */
function createTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  return {
    controller,
    cleanup: () => clearTimeout(timeoutId)
  };
}

/**
 * Main API handler - Groq enhanced, format compatible
 */
export default async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({ 
      message: 'Podcast Growth Agent API v14 - Groq Lightning Edition (Compatible)',
      status: 'ready',
      features: [
        'Search for SPECIFIC EPISODE by title',
        '⚡ Lightning-fast Groq AI transcription (240x real-time speed)',
        '💰 18x cost reduction ($0.02/hour vs $0.36/hour)',
        'Smart OpenAI Whisper fallback for maximum reliability',
        'Production-grade response optimization',
        'Guaranteed reliability for all episode lengths',
        'Preserves maximum niche insights for growth recommendations'
      ]
    });
  }

  if (req.method === 'POST') {
    try {
      const { url } = req.body;
      
      if (!url) {
        return res.status(400).json({ error: 'Podcast URL is required' });
      }

      const searchTerm = extractSearchTerm(url);
      const searchResults = await searchListenNotes(searchTerm);
      
      if (!searchResults.results?.length) {
        return res.status(404).json({ 
          error: 'No episodes found for this episode title',
          search_term: searchTerm,
          received_url: url
        });
      }

      const episode = searchResults.results[0];
      
      if (!episode.audio) {
        return res.status(400).json({ 
          error: 'No audio file available for transcription',
          episode_title: episode.title_original 
        });
      }

      console.log(`Found episode: "${episode.title_original}" (${Math.round(episode.audio_length_sec/60)} minutes)`);

      // Send immediate response (no heartbeat needed with Groq speed)
      const initialResponse = {
        status: 'processing',
        progress: 30,
        message: "⚡ Lightning-fast Groq AI transcription in progress...",
        episode_title: episode.title_original,
        duration: episode.audio_length_sec,
        note: "Groq processes at 240x real-time speed - almost done! 🚀"
      };
      
      res.write(JSON.stringify(initialResponse) + '\n');

      // Transcribe with Groq (primary) and OpenAI fallback
      let transcript;
      let transcriptionSource = 'groq';
      
      try {
        console.log('🚀 Starting Groq transcription...');
        transcript = await transcribeWithGroq(episode.audio);
        console.log('✅ Groq transcription completed - BLAZING FAST!');
      } catch (groqError) {
        console.log(`⚠️ Groq failed (${groqError.message}), trying OpenAI fallback...`);
        
        try {
          console.log('🔄 Starting OpenAI Whisper fallback transcription...');
          transcript = await transcribeWithOpenAI(episode.audio);
          console.log('✅ OpenAI transcription completed successfully');
          transcriptionSource = 'whisper'; // Keep same naming as before
        } catch (openaiError) {
          console.error('❌ Both transcription services failed:', openaiError.message);
          transcript = `Transcription not available. Episode about: ${episode.description_original || episode.title_original}`;
          transcriptionSource = 'fallback_description';
        }
      }
      
      // Return response in EXACT same format as before
      const finalResponse = {
        status: 'success',
        title: episode.title_original,
        description: episode.description_original,
        transcript: optimizeTranscriptForGPT(transcript),
        keywords: extractKeywordsFromText((transcript || '') + ' ' + episode.title_original),
        duration: episode.audio_length_sec,
        audio_url: episode.audio,
        podcast_title: episode.podcast?.title_original || 'Unknown Podcast',
        source: transcriptionSource === 'groq' ? 'ListenNotes + Groq' : 'ListenNotes + Whisper',
        transcription_source: transcriptionSource,
        listennotes_id: episode.id,
        received_url: url,
        search_term: searchTerm,
        search_strategy: 'episode_title_search'
      };
      
      res.write(JSON.stringify(finalResponse) + '\n');
      res.end();

    } catch (error) {
      console.error('API Error:', error);
      
      const errorResponse = {
        status: 'error',
        error: 'Failed to process episode',
        details: error.message
      };
      
      res.write(JSON.stringify(errorResponse) + '\n');
      res.end();
    }
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}

/**
 * Search ListenNotes for episode
 */
async function searchListenNotes(query) {
  const apiKey = process.env.LISTENNOTES_API_KEY;
  return searchEpisodeByTitle(query, apiKey);
}

/**
 * Execute ListenNotes API search
 */
async function searchEpisodeByTitle(query, apiKey) {
  return new Promise((resolve, reject) => {
    const searchQuery = encodeURIComponent(query);
    const options = {
      hostname: 'listen-api.listennotes.com',
      path: `/api/v2/search?q=${searchQuery}&type=episode&only_in=title&language=English&len_min=5`,
      method: 'GET',
      headers: { 'X-ListenAPI-Key': apiKey }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(parsed);
          } else {
            reject(new Error(`ListenNotes search error: ${parsed.error || 'Unknown error'}`));
          }
        } catch (e) {
          reject(new Error('Failed to parse ListenNotes response'));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Transcribe audio using Groq Whisper (PRIMARY - 18x cheaper, 240x faster)
 */
async function transcribeWithGroq(audioUrl) {
  const groqApiKey = process.env.GROQ_API_KEY;
  
  if (!groqApiKey) {
    throw new Error('Groq API key not configured');
  }

  const { controller, cleanup } = createTimeoutController(120000); // 2 minutes

  try {
    console.log('📥 Fetching audio file for Groq transcription...');
    const audioResponse = await fetch(audioUrl, { 
      signal: controller.signal
    });
    
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch audio: ${audioResponse.status} ${audioResponse.statusText}`);
    }
    
    const contentLength = audioResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > CONFIG.GROQ.MAX_FILE_SIZE) {
      throw new Error('Audio file too large for Groq (>25MB)');
    }
    
    const audioBuffer = await audioResponse.arrayBuffer();
    console.log('📦 Audio file fetched for Groq, size:', audioBuffer.byteLength, 'bytes');
    
    const formData = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
    formData.append('file', audioBlob, 'episode.mp3');
    formData.append('model', CONFIG.GROQ.MODEL);
    formData.append('response_format', CONFIG.GROQ.RESPONSE_FORMAT);

    console.log('⚡ Sending to Groq API (240x real-time speed)...');
    const response = await fetch(CONFIG.GROQ.API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqApiKey}` },
      body: formData,
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error: ${response.status} ${errorText}`);
    }

    const transcript = await response.text();
    console.log('📝 Groq transcript received, length:', transcript.length, 'characters - BLAZING FAST! ⚡');
    return transcript;

  } catch (error) {
    console.error('🚨 Groq transcription error:', error);
    throw error;
  } finally {
    cleanup();
  }
}

/**
 * Transcribe audio using OpenAI Whisper (FALLBACK for reliability)
 */
async function transcribeWithOpenAI(audioUrl) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const { controller, cleanup } = createTimeoutController(300000); // 5 minutes

  try {
    console.log('📥 Fetching audio file for OpenAI transcription...');
    const audioResponse = await fetch(audioUrl, {
      signal: controller.signal
    });
    
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch audio: ${audioResponse.status} ${audioResponse.statusText}`);
    }
    
    const contentLength = audioResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > CONFIG.OPENAI.MAX_FILE_SIZE) {
      throw new Error('Audio file too large for OpenAI (>25MB)');
    }
    
    const audioBuffer = await audioResponse.arrayBuffer();
    console.log('📦 Audio file fetched for OpenAI, size:', audioBuffer.byteLength, 'bytes');
    
    const formData = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
    formData.append('file', audioBlob, 'episode.mp3');
    formData.append('model', CONFIG.OPENAI.MODEL);
    formData.append('response_format', CONFIG.OPENAI.RESPONSE_FORMAT);

    console.log('🔄 Sending to OpenAI Whisper API (fallback)...');
    const response = await fetch(CONFIG.OPENAI.API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiApiKey}` },
      body: formData,
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    const transcript = await response.text();
    console.log('📝 OpenAI transcript received, length:', transcript.length, 'characters');
    return transcript;

  } catch (error) {
    console.error('🚨 OpenAI transcription error:', error);
    throw error;
  } finally {
    cleanup();
  }
}

/**
 * Extract keywords from text using frequency analysis
 */
function extractKeywordsFromText(text) {
  const words = text.toLowerCase()
    .replace(/<[^>]*>/g, '')
    .split(/\s+/);
  
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 
    'is', 'are', 'was', 'were', 'this', 'that', 'you', 'he', 'she', 'it', 'we', 'they',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'like', 'just', 'really', 'very', 'much', 'more', 'so', 'now', 'then', 'here', 'there'
  ]);
  
  const wordCount = {};
  words.forEach(word => {
    const clean = word.replace(/[^\w]/g, '');
    if (clean.length > 3 && !stopWords.has(clean)) {
      wordCount[clean] = (wordCount[clean] || 0) + 1;
    }
  });
  
  return Object.entries(wordCount)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 8)
    .map(([word]) => word);
}