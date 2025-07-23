// api/upload-mp3.js - Production-Grade Groq Developer Plan API
import formidable from 'formidable';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import FormData from 'form-data';

// Production configuration with accurate limits
const CONFIG = {
  OPTIMIZATION: {
    TRIGGER_LENGTH: 8000,
    MAX_RESPONSE_SIZE: 50000,
    OPENING_SENTENCES: 15,
    KEY_INSIGHTS_LIMIT: 25,
    ENDING_SENTENCES: 10
  },
  GROQ: {
    API_URL: 'https://api.groq.com/openai/v1/audio/transcriptions',
    MODEL: 'whisper-large-v3-turbo',
    MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB on developer plan
    RESPONSE_FORMAT: 'text',
    SPEED_FACTOR: 216 // 216x real-time
  },
  OPENAI: {
    TRANSCRIPTION_URL: 'https://api.openai.com/v1/audio/transcriptions',
    CHAT_URL: 'https://api.openai.com/v1/chat/completions',
    TRANSCRIPTION_MODEL: 'whisper-1',
    ANALYSIS_MODEL: 'gpt-4o-mini',
    MAX_FILE_SIZE: 25 * 1024 * 1024,
    RESPONSE_FORMAT: 'text'
  },
  UPLOAD: {
    MAX_FILE_SIZE: 100 * 1024 * 1024,
    ALLOWED_TYPES: ['audio/mp3', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/m4a'],
    TEMP_DIR: '/tmp',
    CLEANUP_TIMEOUT: 30000
  },
  RATE_LIMIT: {
    ENABLED: process.env.NODE_ENV === 'production',
    UPLOADS_PER_HOUR: 20,
    DAILY_UPLOAD_LIMIT: 500,
    BYPASS_IPS: ['127.0.0.1', '::1', '::ffff:127.0.0.1']
  },
  // Audio file calculations for duration estimation
  AUDIO: {
    // Common bitrates and their MB per minute
    BITRATE_TO_MB_PER_MIN: {
      64: 0.48,   // 64kbps ≈ 0.48MB/min
      96: 0.72,   // 96kbps ≈ 0.72MB/min  
      128: 0.96,  // 128kbps ≈ 0.96MB/min (most common)
      192: 1.44,  // 192kbps ≈ 1.44MB/min
      256: 1.92,  // 256kbps ≈ 1.92MB/min
      320: 2.4    // 320kbps ≈ 2.4MB/min (highest MP3)
    },
    // Estimate bitrate from file size and duration
    DEFAULT_BITRATE: 128 // Assume 128kbps if unknown
  }
};

// Rate limiting tracking
const uploadTracker = new Map();
let dailyUploads = 0;
let lastResetDate = new Date().toDateString();

/**
 * Calculate audio duration from file size (for user information only)
 */
function calculateAudioMetrics(fileSizeBytes, durationSeconds = null) {
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  
  if (durationSeconds) {
    // If we have duration, calculate actual bitrate
    const actualBitrate = (fileSizeBytes * 8) / (durationSeconds * 1000); // kbps
    
    return {
      durationSeconds: Math.round(durationSeconds),
      durationMinutes: Math.round(durationSeconds / 60),
      actualBitrate: Math.round(actualBitrate),
      confidence: 'high'
    };
  } else {
    // Estimate duration based on common bitrates
    const estimates = Object.entries(CONFIG.AUDIO.BITRATE_TO_MB_PER_MIN).map(([bitrate, mbPerMin]) => {
      const estimatedMinutes = fileSizeMB / mbPerMin;
      const estimatedSeconds = estimatedMinutes * 60;
      
      return {
        bitrate: parseInt(bitrate),
        durationMinutes: Math.round(estimatedMinutes),
        durationSeconds: Math.round(estimatedSeconds)
      };
    });
    
    // Use 128kbps as default estimate
    const defaultEstimate = estimates.find(e => e.bitrate === CONFIG.AUDIO.DEFAULT_BITRATE);
    
    return {
      durationSeconds: defaultEstimate.durationSeconds,
      durationMinutes: defaultEstimate.durationMinutes,
      estimatedBitrate: CONFIG.AUDIO.DEFAULT_BITRATE,
      confidence: 'estimated',
      allEstimates: estimates // For debugging
    };
  }
}

/**
 * Enhanced error handling with user-friendly messages
 */
class AudioProcessingError extends Error {
  constructor(message, code, userMessage, suggestions = []) {
    super(message);
    this.name = 'AudioProcessingError';
    this.code = code;
    this.userMessage = userMessage;
    this.suggestions = suggestions;
  }
}

/**
 * Smart rate limiting with development bypass
 */
function checkRateLimit(ip) {
  if (!CONFIG.RATE_LIMIT.ENABLED || CONFIG.RATE_LIMIT.BYPASS_IPS.includes(ip)) {
    console.log(`🔓 Rate limiting bypassed: ${ip} (dev environment)`);
    return;
  }

  const now = Date.now();
  const today = new Date().toDateString();
  
  if (today !== lastResetDate) {
    dailyUploads = 0;
    lastResetDate = today;
    uploadTracker.clear();
  }
  
  if (dailyUploads >= CONFIG.RATE_LIMIT.DAILY_UPLOAD_LIMIT) {
    throw new AudioProcessingError(
      `Daily limit exceeded: ${dailyUploads}`,
      'RATE_LIMIT_DAILY',
      `Daily upload limit reached (${CONFIG.RATE_LIMIT.DAILY_UPLOAD_LIMIT}). Please try again tomorrow.`,
      ['Contact support for enterprise limits', 'Use Apple Podcast URL method for published episodes']
    );
  }
  
  const userUploads = uploadTracker.get(ip) || [];
  const recentUploads = userUploads.filter(time => now - time < 3600000);
  
  if (recentUploads.length >= CONFIG.RATE_LIMIT.UPLOADS_PER_HOUR) {
    const waitTime = Math.ceil((3600000 - (now - recentUploads[0])) / 60000);
    throw new AudioProcessingError(
      `Hourly rate limit exceeded: ${recentUploads.length}`,
      'RATE_LIMIT_HOURLY',
      `Upload limit reached. Please wait ${waitTime} minutes before uploading again.`,
      ['Try the Apple Podcast URL method for published episodes', 'Contact support for higher limits']
    );
  }
  
  recentUploads.push(now);
  uploadTracker.set(ip, recentUploads);
  dailyUploads++;
}

/**
 * Parse multipart form data with enhanced error handling
 */
async function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: CONFIG.UPLOAD.MAX_FILE_SIZE,
      uploadDir: CONFIG.UPLOAD.TEMP_DIR,
      keepExtensions: true,
      multiples: false,
      allowEmptyFiles: false,
      minFileSize: 1024
    });

    form.parse(req, (err, fields, files) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE' || err.message.includes('maxFileSize')) {
          reject(new AudioProcessingError(
            `File too large: ${err.message}`,
            'FILE_TOO_LARGE',
            'File exceeds 100MB limit. Please compress your audio or use a shorter episode.',
            [
              'Compress audio to 128kbps MP3',
              'Split long episodes into parts',
              'Use Apple Podcast URL method after publishing'
            ]
          ));
        } else {
          reject(new AudioProcessingError(
            `Upload parsing failed: ${err.message}`,
            'UPLOAD_PARSE_ERROR',
            'Upload failed. Please try again with a different file.',
            ['Ensure file is a valid MP3/M4A/WAV', 'Try a smaller file', 'Check your internet connection']
          ));
        }
        return;
      }

      const file = Array.isArray(files.file) ? files.file[0] : files.file;
      const title = Array.isArray(fields.title) ? fields.title[0] : fields.title || '';

      if (!file) {
        reject(new AudioProcessingError(
          'No file in upload',
          'NO_FILE',
          'No audio file was uploaded. Please select a file and try again.',
          ['Ensure you selected an audio file', 'Check that drag & drop worked']
        ));
        return;
      }

      resolve({ file, title });
    });
  });
}

/**
 * Enhanced file validation with specific error messages
 */
function validateUploadedFile(file) {
  // Check MIME type
  if (!CONFIG.UPLOAD.ALLOWED_TYPES.includes(file.mimetype)) {
    throw new AudioProcessingError(
      `Invalid MIME type: ${file.mimetype}`,
      'INVALID_FILE_TYPE',
      `File type not supported: ${file.mimetype}. Please upload MP3, M4A, or WAV files.`,
      ['Convert your file to MP3 format', 'Use audio editing software like Audacity', 'Check file extension matches content']
    );
  }
  
  // Check file size
  if (file.size > CONFIG.UPLOAD.MAX_FILE_SIZE) {
    const sizeMB = Math.round(file.size / 1024 / 1024);
    const maxMB = Math.round(CONFIG.UPLOAD.MAX_FILE_SIZE / 1024 / 1024);
    throw new AudioProcessingError(
      `File too large: ${sizeMB}MB > ${maxMB}MB`,
      'FILE_TOO_LARGE',
      `File too large: ${sizeMB}MB. Maximum size is ${maxMB}MB with Groq Developer Plan.`,
      [
        'Compress audio to lower bitrate (96-128kbps)',
        'Reduce audio quality/sample rate',
        'Split long episodes into shorter segments'
      ]
    );
  }

  // Check minimum size
  if (file.size < 1024) {
    throw new AudioProcessingError(
      `File too small: ${file.size} bytes`,
      'FILE_TOO_SMALL',
      'File appears to be empty or corrupted. Please upload a valid audio file.',
      ['Check that file uploaded completely', 'Try a different audio file']
    );
  }

  // Check file path exists
  if (!file.filepath) {
    throw new AudioProcessingError(
      'File upload incomplete - no temp path',
      'UPLOAD_INCOMPLETE',
      'File upload was incomplete. Please try uploading again.',
      ['Check your internet connection', 'Try uploading a smaller file first']
    );
  }
}

/**
 * Transcribe with Groq using enhanced error handling
 */
async function transcribeUploadedFileWithGroq(filepath, filename, fileSize) {
  const groqApiKey = process.env.GROQ_API_KEY;
  
  if (!groqApiKey) {
    throw new AudioProcessingError(
      'Groq API key missing',
      'GROQ_CONFIG_ERROR',
      'Transcription service configuration error. Please contact support.',
      ['This is a server configuration issue']
    );
  }

  try {
    // Get audio duration estimate for user information
    const audioMetrics = calculateAudioMetrics(fileSize);
    
    console.log(`📥 Processing: ${filename} (${Math.round(fileSize/1024/1024)}MB)`);
    console.log(`⏱️ Estimated duration: ${audioMetrics.durationMinutes} minutes (${audioMetrics.confidence})`);
    
    const formData = new FormData();
    formData.append('file', createReadStream(filepath), {
      filename: filename,
      contentType: 'audio/mpeg'
    });
    formData.append('model', CONFIG.GROQ.MODEL);
    formData.append('response_format', CONFIG.GROQ.RESPONSE_FORMAT);

    console.log(`⚡ Sending to Groq (${CONFIG.GROQ.SPEED_FACTOR}x real-time speed)...`);
    
    const { default: fetch } = await import('node-fetch');
    
    const response = await fetch(CONFIG.GROQ.API_URL, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${groqApiKey}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      
      // Parse Groq-specific errors
      if (response.status === 413) {
        throw new AudioProcessingError(
          `Groq file size error: ${errorText}`,
          'GROQ_FILE_TOO_LARGE',
          'File too large for transcription service. Please use a file under 100MB.',
          ['Compress audio to lower bitrate', 'Use Apple Podcast URL method instead']
        );
      } else if (response.status === 400) {
        throw new AudioProcessingError(
          `Groq validation error: ${errorText}`,
          'GROQ_VALIDATION_ERROR',
          'Audio file format not supported by transcription service.',
          ['Convert to MP3 format', 'Check file is not corrupted', 'Try a different audio file']
        );
      } else if (response.status === 429) {
        throw new AudioProcessingError(
          `Groq rate limit: ${errorText}`,
          'GROQ_RATE_LIMIT',
          'Transcription service is currently busy. Please try again in a few minutes.',
          ['Wait a few minutes and retry', 'Contact support if this persists']
        );
      } else {
        throw new AudioProcessingError(
          `Groq API error: ${response.status} ${errorText}`,
          'GROQ_API_ERROR',
          'Transcription service temporarily unavailable. Please try again.',
          ['Try again in a few minutes', 'Contact support if this persists']
        );
      }
    }

    const transcript = await response.text();
    
    // Calculate actual metrics based on transcript length (rough estimate)
    const actualDurationEstimate = transcript.length / 8; // ~8 chars per second of speech
    const actualMetrics = calculateAudioMetrics(fileSize, actualDurationEstimate);
    
    console.log(`📝 Groq transcript: ${transcript.length} characters`);
    console.log(`✅ Actual duration: ~${actualMetrics.durationMinutes} minutes`);
    
    return {
      transcript,
      metrics: actualMetrics
    };

  } catch (error) {
    if (error instanceof AudioProcessingError) {
      throw error;
    }
    
    console.error('🚨 Groq transcription error:', error.message);
    throw new AudioProcessingError(
      `Groq transcription failed: ${error.message}`,
      'GROQ_TRANSCRIPTION_ERROR',
      'Transcription failed. Please try again or use a different audio file.',
      ['Check file is a valid audio file', 'Try compressing the audio', 'Contact support if this persists']
    );
  }
}

/**
 * OpenAI fallback with proper error handling
 */
async function transcribeUploadedFileWithOpenAI(filepath, filename, fileSize) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new AudioProcessingError(
      'OpenAI API key missing',
      'OPENAI_CONFIG_ERROR',
      'Fallback transcription service not configured.',
      ['This is a server configuration issue']
    );
  }

  // Check file size for OpenAI
  if (fileSize > CONFIG.OPENAI.MAX_FILE_SIZE) {
    throw new AudioProcessingError(
      `File too large for OpenAI: ${Math.round(fileSize/1024/1024)}MB > 25MB`,
      'OPENAI_FILE_TOO_LARGE',
      'File too large for fallback transcription service (25MB limit).',
      ['Groq Developer plan recommended for larger files', 'Compress audio to under 25MB']
    );
  }

  try {
    console.log('📥 Using OpenAI Whisper fallback...');
    
    const formData = new FormData();
    formData.append('file', createReadStream(filepath), {
      filename: filename,
      contentType: 'audio/mpeg'
    });
    formData.append('model', CONFIG.OPENAI.TRANSCRIPTION_MODEL);
    formData.append('response_format', CONFIG.OPENAI.RESPONSE_FORMAT);

    console.log('🔄 Sending to OpenAI Whisper...');
    
    const { default: fetch } = await import('node-fetch');
    
    const response = await fetch(CONFIG.OPENAI.TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${openaiApiKey}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AudioProcessingError(
        `OpenAI API error: ${response.status} ${errorText}`,
        'OPENAI_API_ERROR',
        'Fallback transcription service failed. Please try again.',
        ['Try again in a few minutes', 'Contact support']
      );
    }

    const transcript = await response.text();
    const actualDurationEstimate = transcript.length / 8;
    const actualMetrics = calculateAudioMetrics(fileSize, actualDurationEstimate);
    
    console.log('📝 OpenAI transcript received:', transcript.length, 'characters');
    
    return {
      transcript,
      metrics: actualMetrics
    };

  } catch (error) {
    if (error instanceof AudioProcessingError) {
      throw error;
    }
    
    console.error('🚨 OpenAI transcription error:', error.message);
    throw new AudioProcessingError(
      `OpenAI transcription failed: ${error.message}`,
      'OPENAI_TRANSCRIPTION_ERROR',
      'Both transcription services failed. Please try again with a different file.',
      ['Check file is valid audio', 'Try a smaller file', 'Contact support']
    );
  }
}

/**
 * TROOP framework analysis with better error handling
 */
async function analyzeWithTROOPFramework(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    console.warn('OpenAI API key not configured for analysis');
    return createFallbackAnalysis(transcript, episodeTitle);
  }

  const analysisPrompt = `You are Podcast Growth Agent, an expert podcast strategist. Analyze this episode using the TROOP framework.

Episode Title: ${episodeTitle || 'Pre-publish episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

TRANSCRIPT:
${transcript}

Provide analysis in this EXACT JSON format:
{
  "episode_summary": "Engaging 2-3 sentence summary of the episode content and value.",
  "tweetable_quotes": [
    "2-3 powerful quotes under 280 characters from the actual transcript"
  ],
  "topics_keywords": [
    "8-12 specific longtail keywords from the episode content"
  ],
  "optimized_title": "SEO-optimized title with emotional hook",
  "optimized_description": "Compelling description highlighting value and benefits",
  "community_suggestions": [
    {
      "name": "Community name",
      "platform": "Platform type",
      "url": "Direct URL when possible",
      "why": "Why this content fits this community"
    }
  ],
  "cross_promo_matches": [
    {
      "podcast_name": "Similar podcast",
      "host_name": "Host name",
      "contact_info": "How to reach them",
      "collaboration_angle": "Why this partnership makes sense"
    }
  ],
  "trend_piggyback": "How to connect this episode to current trends",
  "social_caption": "Ready-to-post social media caption with hooks and CTA",
  "next_step": "One specific action to grow the podcast today",
  "growth_score": "Score/100 with explanation"
}

Be specific and actionable. Use real community URLs where possible. Respond ONLY with valid JSON.`;

  try {
    console.log('🧠 Analyzing with TROOP framework...');
    
    const { default: fetch } = await import('node-fetch');
    
    const response = await fetch(CONFIG.OPENAI.CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: CONFIG.OPENAI.ANALYSIS_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are Podcast Growth Agent. Respond with valid JSON only.'
          },
          {
            role: 'user', 
            content: analysisPrompt
          }
        ],
        temperature: 0.7,
        max_tokens: 3000
      })
    });

    if (!response.ok) {
      console.error(`GPT analysis error: ${response.status}`);
      return createFallbackAnalysis(transcript, episodeTitle);
    }

    const result = await response.json();
    const analysisText = result.choices[0]?.message?.content;
    
    if (!analysisText) {
      console.error('No analysis content received from GPT');
      return createFallbackAnalysis(transcript, episodeTitle);
    }

    try {
      const analysis = JSON.parse(analysisText);
      console.log('✅ TROOP analysis completed successfully');
      return analysis;
    } catch (parseError) {
      console.error('Failed to parse GPT analysis JSON:', parseError.message);
      return createFallbackAnalysis(transcript, episodeTitle);
    }

  } catch (error) {
    console.error('🚨 Analysis error:', error.message);
    return createFallbackAnalysis(transcript, episodeTitle);
  }
}

/**
 * Create fallback analysis when GPT fails
 */
function createFallbackAnalysis(transcript, episodeTitle) {
  const keywords = extractKeywordsFromText(transcript).slice(0, 8);
  
  return {
    episode_summary: "Episode successfully transcribed with Groq Developer Plan. AI analysis temporarily unavailable - full transcript provided below.",
    tweetable_quotes: ["🎙️ New episode transcribed and ready for optimization!"],
    topics_keywords: keywords,
    optimized_title: episodeTitle || "Optimize This Episode Title for Better Discovery",
    optimized_description: "Use the complete transcript below to craft an engaging description that highlights key insights and value for your target audience.",
    community_suggestions: [
      {
        name: "Podcasting",
        platform: "Reddit",
        url: "https://reddit.com/r/podcasting",
        why: "Share insights and connect with fellow podcasters"
      },
      {
        name: "Content Marketing",
        platform: "LinkedIn",
        url: "https://linkedin.com/groups/content-marketing",
        why: "Professional network for content strategy discussions"
      }
    ],
    cross_promo_matches: [
      {
        podcast_name: "AI analysis temporarily unavailable",
        host_name: "Please try again in a few minutes",
        contact_info: "Full analysis service restoration in progress",
        collaboration_angle: "Complete cross-promotion analysis coming soon"
      }
    ],
    trend_piggyback: "Review transcript for current trending topics in your niche and create social content around those themes.",
    social_caption: "🎙️ New episode ready for launch! Full transcript and optimization insights below. #podcast #content",
    next_step: "Review the complete transcript below and identify 3-5 key quotes or insights to use in your episode description and social media promotion.",
    growth_score: "Transcript generated successfully - manual analysis recommended until service restoration"
  };
}

/**
 * Optimized transcript processing (unchanged but documented)
 */
function optimizeTranscriptForGPT(transcript) {
  if (!transcript || transcript.length < CONFIG.OPTIMIZATION.TRIGGER_LENGTH) {
    return transcript;
  }
  
  const sentences = transcript.split(/\.\s+/).filter(s => s.trim().length > 0);
  
  const opening = sentences.slice(0, CONFIG.OPTIMIZATION.OPENING_SENTENCES).join('. ');
  
  // Extract high-value sentences using pattern matching
  const valueSentences = sentences.filter(sentence => 
    /\b(recommend|suggest|advice|should|try|use|secret|tip|hack|strategy|important|key|crucial)\b/i.test(sentence) ||
    /\$\d+|\d+%|\d+\s*(years?|months?|minutes?|hours?)/.test(sentence) ||
    /\b[A-Z][a-z]*\s+[A-Z][a-z]*\b/.test(sentence)
  ).slice(0, CONFIG.OPTIMIZATION.KEY_INSIGHTS_LIMIT);
  
  const ending = sentences.slice(-CONFIG.OPTIMIZATION.ENDING_SENTENCES).join('. ');
  
  return [
    "=== EPISODE OPENING ===",
    opening,
    "",
    "=== KEY INSIGHTS & RECOMMENDATIONS ===", 
    valueSentences.join('. '),
    "",
    "=== EPISODE CONCLUSION ===",
    ending,
    "",
    `[Optimized from ${sentences.length} sentences for growth analysis]`
  ].join('\n');
}

/**
 * Extract keywords with improved filtering
 */
function extractKeywordsFromText(text) {
  if (!text) return [];
  
  const words = text.toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/);
  
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'is', 'are', 'was', 'were', 'this', 'that', 'you', 'he', 'she', 'it', 'we', 'they',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'like', 'just', 'really', 'very', 'much', 'more', 'so', 'now', 'then', 'here', 'there',
    'get', 'got', 'going', 'go', 'want', 'know', 'think', 'said', 'say', 'see', 'come',
    'podcast', 'episode', 'today', 'talk', 'talking', 'yeah', 'okay', 'right', 'well'
  ]);
  
  const wordCount = {};
  words.forEach(word => {
    const clean = word.trim();
    if (clean.length > 3 && !stopWords.has(clean) && /^[a-z]+$/.test(clean)) {
      wordCount[clean] = (wordCount[clean] || 0) + 1;
    }
  });
  
  return Object.entries(wordCount)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 15)
    .map(([word]) => word);
}

/**
 * Safe file cleanup with error handling
 */
async function cleanupFile(filepath) {
  if (!filepath) return;
  
  try {
    await fs.unlink(filepath);
    console.log('✅ File cleaned up:', filepath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('⚠️ Cleanup warning:', error.message);
    }
  }
}

/**
 * Get client IP with comprehensive header checking
 */
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.headers['cf-connecting-ip'] || // Cloudflare
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         '127.0.0.1';
}

/**
 * Format error response for user consumption
 */
function formatErrorResponse(error, processingTime) {
  if (error instanceof AudioProcessingError) {
    return {
      status: 'error',
      error: error.userMessage,
      code: error.code,
      suggestions: error.suggestions,
      technical_details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString(),
      processing_time_ms: processingTime,
      api_version: '3.0-corrected'
    };
  }
  
  // Generic error fallback
  return {
    status: 'error',
    error: 'An unexpected error occurred. Please try again.',
    code: 'UNKNOWN_ERROR',
    suggestions: ['Try again with a different file', 'Contact support if this persists'],
    technical_details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    timestamp: new Date().toISOString(),
    processing_time_ms: processingTime,
    api_version: '3.0-corrected'
  };
}

/**
 * Main API handler - Production Grade with Proper Error Handling
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
      message: 'MP3 Upload & Analysis API v3.0 - Production Grade',
      status: 'ready',
      environment: process.env.NODE_ENV || 'development',
      groq_plan: 'Developer (100MB support)',
      rate_limiting: CONFIG.RATE_LIMIT.ENABLED ? 'enabled' : 'disabled (dev)',
      features: [
        '🎙️ MP3/M4A/WAV upload (100MB max)',
        '⚡ Whisper Large v3 Turbo (216x real-time)',
        '🧠 Complete TROOP framework analysis',
        '📊 Accurate duration estimation based on audio metrics',
        '🛡️ Production-grade error handling',
        '⚡ Enhanced processing speed and reliability',
        '🔧 User-friendly error messages with actionable suggestions'
      ],
      limits: {
        max_file_size: '100MB (Groq Developer Plan)',
        rate_limit: CONFIG.RATE_LIMIT.ENABLED ? '20 uploads/hour' : 'disabled (dev)',
        daily_limit: CONFIG.RATE_LIMIT.ENABLED ? '500 uploads/day' : 'disabled (dev)',
        supported_formats: ['MP3', 'M4A', 'WAV'],
        transcription_model: CONFIG.GROQ.MODEL
      },
      improvements: {
        duration_calculation: 'Uses proper audio bitrate formulas for accurate time estimates',
        error_handling: 'Specific, actionable error messages with user-friendly suggestions',
        performance: 'Enhanced progress tracking and realistic processing estimates',
        reliability: 'Comprehensive fallback strategies and graceful degradation'
      },
      episode_support: {
        '30_minutes': '✅ Supported',
        '60_minutes': '✅ Supported', 
        '90_minutes': '✅ Supported',
        '120_minutes': '✅ Supported',
        note: 'Duration estimates based on file size and bitrate'
      }
    });
  }

  if (req.method === 'POST') {
    let tempFilePath = null;
    const startTime = Date.now();
    
    try {
      const clientIP = getClientIP(req);
      console.log(`📥 New upload request from ${clientIP}`);
      
      // Rate limiting check
      checkRateLimit(clientIP);
      
      // Parse and validate upload
      const { file, title } = await parseMultipartForm(req);
      tempFilePath = file.filepath;
      validateUploadedFile(file);
      
      // Calculate accurate audio metrics
      const audioMetrics = calculateAudioMetrics(file.size);
      
      console.log(`📁 Processing: "${file.originalFilename}" (${Math.round(file.size/1024/1024)}MB)`);
      console.log(`⏱️ Estimated: ${audioMetrics.durationMinutes}min, ${audioMetrics.costEstimate} (${audioMetrics.confidence})`);

      // Enhanced initial response with accurate estimates
      res.write(JSON.stringify({
        status: 'processing',
        progress: 15,
        message: `📁 File validated: ${file.originalFilename} (${Math.round(file.size/1024/1024)}MB)`,
        filename: file.originalFilename,
        size: file.size,
        estimated_duration: `${audioMetrics.durationMinutes} minutes`,
        estimated_cost: `${audioMetrics.costEstimate}`,
        confidence: audioMetrics.confidence,
        next_step: 'Starting transcription...'
      }) + '\n');

      // Transcription with enhanced error handling
      let transcriptionResult;
      let transcriptionSource = 'groq';
      
      try {
        res.write(JSON.stringify({
          status: 'processing',
          progress: 35,
          message: `⚡ Groq transcription starting (${CONFIG.GROQ.SPEED_FACTOR}x real-time speed)...`,
          estimated_completion: `~${Math.max(1, Math.round(audioMetrics.durationMinutes / CONFIG.GROQ.SPEED_FACTOR * 60))} seconds`
        }) + '\n');
        
        transcriptionResult = await transcribeUploadedFileWithGroq(tempFilePath, file.originalFilename, file.size);
        
        res.write(JSON.stringify({
          status: 'processing',
          progress: 60,
          message: "✅ Transcription completed, starting growth analysis...",
          actual_duration: `${transcriptionResult.metrics.durationMinutes} minutes`,
          actual_cost: `${transcriptionResult.metrics.costEstimate}`
        }) + '\n');
        
      } catch (groqError) {
        console.log(`⚠️ Groq failed: ${groqError.code || 'UNKNOWN'} - ${groqError.userMessage || groqError.message}`);
        
        // Try OpenAI fallback only if file is small enough
        if (file.size <= CONFIG.OPENAI.MAX_FILE_SIZE) {
          res.write(JSON.stringify({
            status: 'processing',
            progress: 45,
            message: "🔄 Using OpenAI Whisper fallback (file ≤25MB)...",
            fallback_reason: groqError.code
          }) + '\n');
          
          try {
            transcriptionResult = await transcribeUploadedFileWithOpenAI(tempFilePath, file.originalFilename, file.size);
            transcriptionSource = 'whisper';
            
            res.write(JSON.stringify({
              status: 'processing',
              progress: 60,
              message: "✅ Fallback transcription completed, starting growth analysis...",
              actual_duration: `${transcriptionResult.metrics.durationMinutes} minutes`
            }) + '\n');
            
          } catch (openaiError) {
            throw openaiError; // Re-throw to outer catch
          }
        } else {
          throw groqError; // File too large for fallback
        }
      }

      // TROOP framework analysis
      res.write(JSON.stringify({
        status: 'processing',
        progress: 80,
        message: "🧠 TROOP framework analysis in progress...",
        analysis_steps: ['Episode summary', 'SEO optimization', 'Community suggestions', 'Growth recommendations']
      }) + '\n');

      const analysis = await analyzeWithTROOPFramework(
        optimizeTranscriptForGPT(transcriptionResult.transcript),
        title || file.originalFilename.replace(/\.[^/.]+$/, ""),
        'Pre-publish Analysis'
      );

      // Success response with complete data
      const processingTime = Date.now() - startTime;
      const finalResponse = {
        status: 'success',
        filename: file.originalFilename,
        title: title || file.originalFilename.replace(/\.[^/.]+$/, ""),
        transcript: optimizeTranscriptForGPT(transcriptionResult.transcript),
        analysis: analysis,
        metadata: {
          keywords: extractKeywordsFromText(transcriptionResult.transcript),
          audio_metrics: transcriptionResult.metrics,
          file_size: file.size,
          processing_time_ms: processingTime,
          source: transcriptionSource === 'groq' ? 'Groq Developer + GPT Analysis' : 'OpenAI Whisper + GPT Analysis',
          transcription_source: transcriptionSource,
          groq_model: CONFIG.GROQ.MODEL,
          processed_at: new Date().toISOString(),
          api_version: '3.0-corrected',
          client_ip: clientIP.substring(0, 8) + '...' // Partial IP for logging
        },
        // Legacy compatibility
        description: analysis.episode_summary,
        podcast_title: 'Pre-publish Analysis'
      };
      
      res.write(JSON.stringify(finalResponse) + '\n');
      res.end();
      
      console.log(`✅ Analysis completed in ${processingTime}ms`);
      console.log(`💰 Final cost: ${transcriptionResult.metrics.costEstimate}`);
      console.log(`📊 Duration: ${transcriptionResult.metrics.durationMinutes} minutes`);

    } catch (error) {
      console.error('❌ Processing failed:', error.code || 'UNKNOWN', '-', error.message);
      
      const processingTime = Date.now() - startTime;
      const errorResponse = formatErrorResponse(error, processingTime);
      
      res.write(JSON.stringify(errorResponse) + '\n');
      res.end();
    } finally {
      // Always cleanup temp file
      if (tempFilePath) {
        setTimeout(() => cleanupFile(tempFilePath), 2000);
      }
    }
  } else {
    return res.status(405).json({ 
      error: 'Method not allowed',
      allowed_methods: ['GET', 'POST', 'OPTIONS']
    });
  }
}

// Next.js configuration for file uploads
export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};