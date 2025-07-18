// api/transcribe.js - Episode title search + Whisper transcription
import https from 'https';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({ 
      message: 'Podcast Growth Agent API v9 - Full Whisper Integration',
      status: 'ready',
      features: [
        'Search for SPECIFIC EPISODE by title',
        'Real Whisper transcription',
        'Fallback to description if transcription fails',
        'Ready for growth recommendations'
      ]
    });
  }

  if (req.method === 'POST') {
    try {
      const { url } = req.body || {};
      
      if (!url) {
        return res.status(400).json({ error: 'Podcast URL is required' });
      }

      // Extract episode title from URL for search
      const searchTerm = extractSearchTerm(url);
      
      // Search for the specific episode by title
      const searchResults = await searchListenNotes(searchTerm);
      
      if (!searchResults.results || searchResults.results.length === 0) {
        return res.status(404).json({ 
          error: 'No episodes found for this episode title',
          search_term: searchTerm,
          received_url: url
        });
      }

      // Use the first (most relevant) result
      const episode = searchResults.results[0];
      
      // Check if we have a valid audio URL
      if (!episode.audio) {
        return res.status(400).json({ 
          error: 'No audio file available for transcription',
          episode_title: episode.title_original 
        });
      }

      // Transcribe the audio using Whisper
      let transcript;
      let transcription_source = 'whisper';
      
      try {
        console.log('Starting Whisper transcription for:', episode.title_original);
        transcript = await transcribeWithWhisper(episode.audio);
        console.log('Whisper transcription completed successfully');
      } catch (transcriptionError) {
        console.error('Whisper transcription failed:', transcriptionError.message);
        // Fallback to description-based content
        transcript = `Transcription not available. Episode about: ${episode.description_original || episode.title_original}`;
        transcription_source = 'fallback_description';
      }
      
      return res.status(200).json({
        status: 'success',
        title: episode.title_original,
        description: episode.description_original,
        transcript: transcript,
        keywords: extractKeywordsFromText((transcript || '') + ' ' + episode.title_original),
        duration: episode.audio_length_sec,
        audio_url: episode.audio,
        podcast_title: episode.podcast?.title_original || 'Unknown Podcast',
        source: 'ListenNotes + Whisper',
        transcription_source: transcription_source,
        listennotes_id: episode.id,
        received_url: url,
        search_term: searchTerm,
        search_strategy: 'episode_title_search'
      });

    } catch (error) {
      console.error('API Error:', error);
      return res.status(500).json({ 
        error: 'Failed to process episode',
        details: error.message 
      });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function extractSearchTerm(url) {
  // Extract the full episode title from the Apple Podcasts URL
  // Format: /podcast/full-episode-title-here/id123456?i=episode_id
  
  const episodeMatch = url.match(/\/podcast\/([^\/]+)\/id\d+/);
  if (episodeMatch) {
    // Convert URL slug to readable episode title
    return episodeMatch[1]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase()); // Title case
  }
  
  // Fallback patterns for known URLs
  if (url.includes('easy-breezy-eats-simple-summer-recipes')) {
    return 'Easy Breezy Eats Simple Summer Recipes To Keep You Cool';
  }
  if (url.includes('pressed-for-greatness-the-olive-oil-episode')) {
    return 'Pressed For Greatness The Olive Oil Episode';
  }
  
  return 'episode';
}

async function searchListenNotes(query) {
  const apiKey = process.env.LISTENNOTES_API_KEY;
  
  // Search for the specific EPISODE by title
  return searchEpisodeByTitle(query, apiKey);
}

async function searchEpisodeByTitle(query, apiKey) {
  return new Promise((resolve, reject) => {
    const searchQuery = encodeURIComponent(query);
    const options = {
      hostname: 'listen-api.listennotes.com',
      path: `/api/v2/search?q=${searchQuery}&type=episode&only_in=title&language=English&len_min=5`,
      method: 'GET',
      headers: {
        'X-ListenAPI-Key': apiKey
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(parsed);
          } else {
            reject(new Error(`ListenNotes episode search error: ${parsed.error || 'Unknown error'}`));
          }
        } catch (e) {
          reject(new Error('Failed to parse ListenNotes episode search response'));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

async function transcribeWithWhisper(audioUrl) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OpenAI API key not configured');
  }

  try {
    // Fetch the audio file
    console.log('Fetching audio file from:', audioUrl);
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to fetch audio: ${audioResponse.status} ${audioResponse.statusText}`);
    }
    
    // Check file size (Whisper has a 25MB limit)
    const contentLength = audioResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 25 * 1024 * 1024) {
      throw new Error('Audio file too large for Whisper (>25MB)');
    }
    
    const audioBuffer = await audioResponse.arrayBuffer();
    console.log('Audio file fetched, size:', audioBuffer.byteLength, 'bytes');
    
    // Create FormData for Whisper API
    const formData = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });
    formData.append('file', audioBlob, 'episode.mp3');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'text');

    console.log('Sending to Whisper API...');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API error: ${response.status} ${errorText}`);
    }

    const transcript = await response.text();
    console.log('Transcript received, length:', transcript.length, 'characters');
    return transcript;

  } catch (error) {
    console.error('Whisper transcription error:', error);
    throw error;
  }
}

function extractKeywordsFromText(text) {
  const words = text.toLowerCase()
    .replace(/<[^>]*>/g, '') // Remove HTML tags
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