// api/analyze-apple-podcast.js
// Apple Podcasts URL → metadata → upload remote MP3 to Vercel Blob (server-side) → stream to Groq → Enhanced TROOP

import { setCorsHeaders } from '../lib/cors.js';
import { put } from '@vercel/blob';
import FormData from 'form-data';

const APP_CONFIG = {
  // This endpoint is your existing metadata helper (unchanged)
  METADATA_URL: 'https://podcast-api-amber.vercel.app/api/transcribe', // POST { url, metadataOnly: true }

  GROQ: {
    API_URL: 'https://api.groq.com/openai/v1/audio/transcriptions',
    MODEL: 'whisper-large-v3-turbo',
    RESPONSE_FORMAT: 'text',
  },

  OPENAI: {
    CHAT_URL: 'https://api.openai.com/v1/chat/completions',
    ANALYSIS_MODEL: 'gpt-4o-mini',
  },

  // Fail-fast hard cap based on HEAD (some hosts return it)
  HARD_SIZE_LIMIT_BYTES: 1024 * 1024 * 300, // 300 MB
};

export default async function handler(req, res) {
  setCorsHeaders(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startTime = Date.now();
  const debug = [];

  try {
    const { appleUrl, title } = await readJsonBody(req);
    if (!appleUrl) return res.status(400).json({ error: 'Apple Podcast URL is required' });

    debug.push(`🚀 Start Apple URL flow: ${appleUrl}`);

    // 1) Get metadata (title, audio enclosure URL, etc.)
    debug.push('📞 Fetching episode metadata…');
    const meta = await getEpisodeMetadata(appleUrl, debug);
    const episodeTitle = meta.title || title || 'Episode';
    const podcastTitle = meta.podcast_title || meta.podcastTitle || 'Podcast';
    const audioUrl = pickAudioUrl(meta);
    if (!audioUrl) {
      return res.status(400).json({ error: 'No audio URL found in episode metadata.', debug });
    }
    debug.push(`🎵 MP3: ${String(audioUrl).slice(0, 180)}…`);

    // 2) Optional HEAD check (fast reject if absurdly large)
    const { contentLength } = await headInfo(audioUrl);
    if (contentLength && contentLength > APP_CONFIG.HARD_SIZE_LIMIT_BYTES) {
      return res.status(413).json({
        error: `Audio too large (${Math.round(contentLength / 1024 / 1024)}MB). Try the MP3 upload path or trim the file.`,
        debug,
      });
    }

    // 3) Server-side upload of remote MP3 → Vercel Blob (tokened)
    debug.push('☁️ Uploading remote MP3 to Vercel Blob (server-side)…');
    const { blobUrl, contentType } = await uploadRemoteMp3ToBlob(audioUrl, `${episodeTitle || 'episode'}.mp3`);
    debug.push(`✅ Blob created: ${blobUrl}`);

    // 4) Transcribe by STREAMING Blob → Groq (no /tmp, no giant buffers)
    debug.push('⚡ Transcribing via Groq (streaming from Blob)…');
    const transcription = await transcribeWithGroqFromBlobUrl(blobUrl, {
      filename: `${episodeTitle || 'episode'}.mp3`,
      fallbackContentType: contentType || 'audio/mpeg',
    });
    debug.push(`📝 Transcript chars: ${transcription.transcript.length}`);

    // 5) Enhanced TROOP analysis (strict JSON)
    debug.push('🧠 Running Enhanced TROOP analysis…');
    const analysis = await analyzeWithEnhancedTROOP(
      transcription.transcript,
      episodeTitle,
      podcastTitle
    );
    debug.push('🎯 Enhanced TROOP analysis complete');

    const processingTime = Date.now() - startTime;
    return res.status(200).json({
      success: true,
      source: 'Apple URL + Blob upload (server) + Groq Whisper + Enhanced TROOP',
      metadata: {
        title: episodeTitle,
        podcastTitle,
        originalUrl: appleUrl,
        audioUrl,                 // original remote MP3 (from feed)
        blobUrl,                  // your re-hosted MP3
        duration: meta.duration || transcription.metrics.durationSeconds,
        transcriptionSource: transcription.metrics.source,
        audio_metrics: transcription.metrics,
        processed_at: new Date().toISOString(),
        processing_time_ms: processingTime,
        api_version: '5.0-apple-blob-streaming',
      },
      transcript: transcription.transcript,
      description: meta.description || '',
      keywords: meta.keywords || [],
      analysis,
      debug,
    });
  } catch (err) {
    const processingTime = Date.now() - startTime;
    return res.status(500).json({
      error: 'Analysis failed',
      details: err.message,
      processing_time_ms: processingTime,
    });
  }
}

/* ---------------------------
   Helpers
----------------------------*/

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(raw);
}

async function getEpisodeMetadata(appleUrl, debug) {
  const { default: fetch } = await import('node-fetch');
  try {
    const r = await fetch(APP_CONFIG.METADATA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: appleUrl, metadataOnly: true }),
    });

    if (!r.ok) {
      debug.push(`⚠️ Metadata service error ${r.status} ${r.statusText}, falling back to URL parse`);
      return extractBasicMetadataFromUrl(appleUrl);
    }

    const text = await r.text();
    const lines = text.trim().split('\n').filter(Boolean);
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'success' || parsed.title) return parsed;
      } catch { /* ignore bad JSON lines */ }
    }
    debug.push('⚠️ Metadata stream unreadable, falling back to URL parse');
    return extractBasicMetadataFromUrl(appleUrl);
  } catch (e) {
    debug.push(`⚠️ Metadata fetch failed: ${e.message}, falling back to URL parse`);
    return extractBasicMetadataFromUrl(appleUrl);
  }
}

function pickAudioUrl(meta) {
  return meta.audio_url || meta.audioUrl || meta.enclosure_url || meta.mp3_url || null;
}

function extractBasicMetadataFromUrl(appleUrl) {
  const parts = appleUrl.split('/');
  const titlePart = parts.find((p) => p.includes('-') && !p.includes('id'));
  const title = titlePart
    ? titlePart.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
    : 'Episode';
  return {
    title,
    podcast_title: 'Podcast',
    description: 'Episode analysis from Apple Podcast URL',
    duration: 0,
  };
}

async function headInfo(url) {
  const { default: fetch } = await import('node-fetch');
  try {
    const r = await fetch(url, { method: 'HEAD' });
    if (!r.ok) return { contentLength: 0, contentType: '' };
    return {
      contentLength: Number(r.headers.get('content-length') || 0),
      contentType: r.headers.get('content-type') || '',
    };
  } catch {
    // many hosts block HEAD, just return empty and keep going
    return { contentLength: 0, contentType: '' };
  }
}

/* ---------------------------
   Blob (server-side) upload
----------------------------*/

function getBlobToken() {
  return (
    process.env.VERCEL_BLOB_READ_WRITE_TOKEN ||
    process.env.BLOB_READ_WRITE_TOKEN ||
    ''
  );
}

// Download remote MP3 and stream to Vercel Blob using server RW token
async function uploadRemoteMp3ToBlob(audioUrl, filenameHint = 'episode.mp3') {
  const token = getBlobToken();
  if (!token) {
    throw new Error(
      'Blob token missing. Set VERCEL_BLOB_READ_WRITE_TOKEN (or BLOB_READ_WRITE_TOKEN) in Vercel env.'
    );
  }

  const { default: fetch } = await import('node-fetch');
  const resp = await fetch(audioUrl);
  if (!resp.ok || !resp.body) {
    throw new Error(`Failed to fetch audio: ${resp.status} ${resp.statusText}`);
  }

  const contentType = resp.headers.get('content-type') || 'audio/mpeg';
  const pathname = `apple/${Date.now()}-${filenameHint.replace(/[^\w.\-]+/g, '_')}`;

  const { url } = await put(pathname, resp.body, {
    access: 'public',
    contentType,
    token,
    addRandomSuffix: false,
  });

  return { blobUrl: url, contentType };
}

/* ---------------------------
   Transcription (Groq)
----------------------------*/

async function transcribeWithGroqFromBlobUrl(blobUrl, opts = {}) {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error('Groq API key not configured');

  const { default: fetch } = await import('node-fetch');

  // Stream Blob → Groq using form-data with a Readable stream (no huge memory buffers)
  const blobResp = await fetch(blobUrl);
  if (!blobResp.ok || !blobResp.body) {
    throw new Error(`Failed to fetch blob: ${blobResp.status} ${blobResp.statusText}`);
  }

  const formData = new FormData();
  formData.append('file', blobResp.body, {
    filename: opts.filename || 'episode.mp3',
    contentType: blobResp.headers.get('content-type') || opts.fallbackContentType || 'audio/mpeg',
  });
  formData.append('model', APP_CONFIG.GROQ.MODEL);
  formData.append('response_format', APP_CONFIG.GROQ.RESPONSE_FORMAT);

  const response = await fetch(APP_CONFIG.GROQ.API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey}`, ...formData.getHeaders() },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    // Common: 413 from provider if the upstream stream is too big
    throw new Error(`Groq API error: ${response.status} ${errorText}\n`);
  }

  const transcript = await response.text();

  // quick/rough duration estimate (keeps parity with your other path)
  const durationEstimate = transcript.length / 8;
  return {
    transcript,
    metrics: {
      durationSeconds: Math.round(durationEstimate),
      durationMinutes: Math.round(durationEstimate / 60),
      confidence: 'estimated',
      source: 'groq',
    },
  };
}

/* ---------------------------------
   Enhanced TROOP (JSON-forced + retries)
---------------------------------- */

async function analyzeWithEnhancedTROOP(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) return createFallbackAnalysis(transcript, episodeTitle);

  const baseSystem = [
    'You are Podcast Growth Agent.',
    'Respond with valid JSON only. No markdown, no code fences, no commentary.',
    'Do NOT provide medical advice or health recommendations; focus strictly on marketing, SEO, audience targeting, and community strategy.',
    'Arrays MUST contain exactly 3 items for tweetable_quotes, community_suggestions, and cross_promo_matches.'
  ].join(' ');

  const enhancedTROOPPrompt = `**TASK:**
Analyze the provided podcast episode transcript and generate a comprehensive 10-section growth strategy that helps podcasters expand their audience reach. Extract semantic meaning from the actual transcript content and create actionable marketing recommendations.

**ROLE:**
You are Podcast Growth Agent, an expert podcast growth strategist with 10+ years of experience helping independent podcasters grow their shows. You combine deep transcript analysis with advanced SEO strategy and community targeting expertise.

**CRITICAL REQUIREMENTS:**
- MUST provide EXACTLY 3 tweetable quotes
- MUST provide EXACTLY 3 community suggestions
- MUST provide EXACTLY 3 cross-promo matches
- MUST use NICHE communities (1K-100K members), NOT generic ones like r/podcasts
- ALL data must be based on actual transcript content

**OUTPUT:**
Generate analysis in this EXACT JSON format with EXACT array lengths:

{
  "episode_summary": "2-3 engaging sentences that capture both explicit content and underlying themes, using searchable language while preserving authentic voice",
  "tweetable_quotes": [
    "Direct quote from transcript, lightly edited for social media clarity, under 280 characters",
    "Second actual quote that captures key insight or emotional moment",
    "Third memorable line from episode content, optimized for shareability"
  ],
  "topics_keywords": [
    "High-intent longtail keywords from transcript (3-5 words)",
    "Question-based keywords people search",
    "Problem-solution keywords that match episode content",
    "Semantic SEO terms that align with episode meaning",
    "Platform-specific keywords for discovery"
  ],
  "optimized_title": "SEO-optimized title with primary keyword front-loaded, emotional hook, and clear benefit (under 60 characters)",
  "optimized_description": "150-200 word SEO-optimized description that includes primary keyword in first 125 characters, 2-3 related keywords naturally woven in, emotional hooks, clear value proposition, and call-to-action",
  "community_suggestions": [
    {
      "name": "SPECIFIC niche community name (1K-100K members, active discussions, topic-relevant)",
      "platform": "Reddit/Facebook/Discord/LinkedIn",
      "url": "Direct working URL (or best search query if unknown)",
      "why": "Specific problem this episode solves for this community + evidence of active discussion",
      "post_angle": "Conversation starter that provides value before mentioning podcast",
      "member_size": "Exact member count or best estimate in 1K-100K range",
      "engagement_strategy": "Platform-specific posting strategy with timing recommendations",
      "conversion_potential": "Why this community is likely to become listeners"
    },
    {
      "name": "Second niche community (different platform or angle)",
      "platform": "Platform",
      "url": "URL or discovery query",
      "why": "Different angle or pain point addressed",
      "post_angle": "Alternative value-first post",
      "member_size": "Count or range",
      "engagement_strategy": "Approach that fits culture",
      "conversion_potential": "Expected overlap"
    },
    {
      "name": "Third complementary niche community",
      "platform": "Platform",
      "url": "URL or discovery query",
      "why": "Third angle",
      "post_angle": "Third approach",
      "member_size": "Count or range",
      "engagement_strategy": "Posting strategy",
      "conversion_potential": "Overlap rationale"
    }
  ],
  "cross_promo_matches": [
    {
      "podcast_name": "Complementary podcast (similar size preferred, active host engagement)",
      "host_name": "Real host name",
      "contact_info": "Best public handle or email",
      "audience_overlap": "Estimated %",
      "collaboration_value": "Mutual benefit explanation",
      "outreach_timing": "Best time to reach based on their posting cadence",
      "suggested_approach": "Concrete idea (swap, clip, newsletter, guest)"
    },
    {
      "podcast_name": "Second complementary show",
      "host_name": "Host",
      "contact_info": "Handle/email",
      "audience_overlap": "Estimated %",
      "collaboration_value": "Mutual benefit",
      "outreach_timing": "Timing",
      "suggested_approach": "Idea"
    },
    {
      "podcast_name": "Third complementary show",
      "host_name": "Host",
      "contact_info": "Handle/email",
      "audience_overlap": "Estimated %",
      "collaboration_value": "Mutual benefit",
      "outreach_timing": "Timing",
      "suggested_approach": "Idea"
    }
  ],
  "trend_piggyback": "Current trend or cultural moment this episode connects to, with specific hashtags, timing strategy, and platform recommendations",
  "social_caption": "Platform-ready caption using actual quotes and authentic voice, optimized for engagement with strategic hashtags and clear call-to-action",
  "next_step": "One specific, actionable growth tactic they can execute today based on episode content analysis - achievable in 30-60 minutes",
  "growth_score": "Score out of 100 with detailed explanation based on content quality (30%), audience engagement potential (25%), SEO potential (20%), shareability (15%), actionability (10%)"
}

**EPISODE INFORMATION:**
Episode Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

**TRANSCRIPT:**
${transcript.length > 15000 ? transcript.substring(0, 15000) + '\n\n[Transcript truncated for processing - full analysis based on episode themes]' : transcript}

**IMPORTANT:**
- Do NOT use r/podcasts or other generic podcast communities
- Prefer specific niche communities with real problems this episode solves
- Provide exactly 3 items in each array

Respond ONLY with valid JSON.`;

  async function callOpenAI(prompt) {
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: baseSystem },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const status = resp.status;
    const text = await resp.text();

    if (status < 200 || status >= 300) {
      return { ok: false, status, errorText: text };
    }

    let data;
    try { data = JSON.parse(text); }
    catch (e) { return { ok: false, status, errorText: `JSON parse error: ${e.message} | raw=${text.slice(0, 400)}...` }; }

    const content = data.choices?.[0]?.message?.content;
    if (!content) return { ok: false, status, errorText: `No content in response | raw=${text.slice(0, 400)}...` };

    try {
      const parsed = JSON.parse(content);
      return { ok: true, json: parsed };
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) { try { return { ok: true, json: JSON.parse(match[0]) }; } catch {} }
      return { ok: false, status, errorText: `Model content not valid JSON: ${content.slice(0, 300)}...` };
    }
  }

  // Try 1
  let attempt = await callOpenAI(enhancedTROOPPrompt);
  if (attempt.ok) return attempt.json;

  // Try 2
  attempt = await callOpenAI(enhancedTROOPPrompt);
  if (attempt.ok) return attempt.json;

  // Distill → Analyze (shorter prompt)
  const distilled = await distillTranscript(transcript, openaiApiKey, baseSystem);
  const distilledPrompt = enhancedTROOPPrompt.replace(
    /\*\*TRANSCRIPT:\*\*[\s\S]*$/m,
    `**TRANSCRIPT (DISTILLED):**\n${distilled}\n\nRespond ONLY with valid JSON.`
  );
  attempt = await callOpenAI(distilledPrompt);
  if (attempt.ok) return attempt.json;

  return {
    ...createFallbackAnalysis(transcript, episodeTitle),
    _debug_troop_fail: {
      first_error: attempt.errorText,
      note: 'Fell back after 2 direct attempts + distilled run.',
    },
  };
}

async function distillTranscript(transcript, openaiApiKey, baseSystem) {
  const distilledPrompt = [
    'Condense the following transcript into JSON with keys:',
    '{ "summary": "...", "key_points": ["..."], "entities": ["..."], "topics": ["..."], "quotes": ["..."] }',
    'Focus ONLY on marketing-relevant themes, audience pain points, quotable lines, and topic clusters.',
    'Avoid medical advice; do not include instructions or sensitive guidance.',
    '',
    transcript.length > 24000 ? transcript.substring(0, 24000) + '\n\n[Truncated for distillation]' : transcript,
  ].join('\n');

  const { default: fetch } = await import('node-fetch');
  const resp = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.5,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: baseSystem },
        { role: 'user', content: distilledPrompt },
      ],
    }),
  });

  const text = await resp.text();
  try {
    const data = JSON.parse(text);
    const content = data.choices?.[0]?.message?.content || '{}';
    const json = JSON.parse(content);
    return [
      `SUMMARY: ${json.summary || ''}`,
      `KEY_POINTS: ${(Array.isArray(json.key_points) ? json.key_points : []).join(' | ')}`,
      `ENTITIES: ${(Array.isArray(json.entities) ? json.entities : []).join(', ')}`,
      `TOPICS: ${(Array.isArray(json.topics) ? json.topics : []).join(', ')}`,
      `QUOTES: ${(Array.isArray(json.quotes) ? json.quotes : []).join(' | ')}`,
    ].join('\n');
  } catch {
    return transcript.slice(0, 8000);
  }
}

function createFallbackAnalysis(transcript, episodeTitle) {
  return {
    episode_summary: "Episode successfully transcribed. Enhanced AI analysis temporarily unavailable - using fallback.",
    tweetable_quotes: [
      `🎙️ New episode: "${episodeTitle}" - packed with insights for growth!`,
      "📈 Every episode is an opportunity to connect with your audience.",
      "🚀 Consistent content creation is the key to podcast growth.",
    ],
    topics_keywords: ["podcast", "content", "growth", "strategy", "audience"],
    optimized_title: episodeTitle || "Optimize This Episode Title for SEO",
    optimized_description: "Use the episode content to craft an engaging description that drives discovery and engagement.",
    community_suggestions: [
      { name: "Mindfulness Community", platform: "Reddit", url: "https://reddit.com/r/mindfulness", why: "Share mindful practices and wellness insights" },
      { name: "Self Care Support", platform: "Facebook", url: "https://facebook.com/groups/selfcaresupport", why: "Connect with people focused on personal wellness" },
      { name: "Wellness Warriors", platform: "Discord", url: "https://discord.com/invite/wellness", why: "Real-time community for health and wellness discussions" },
    ],
    cross_promo_matches: [
      { podcast_name: "The Wellness Hour", host_name: "Sarah Johnson", contact_info: "@sarahwellness", collaboration_angle: "Practical wellness overlap" },
      { podcast_name: "Mindful Living Daily", host_name: "Mike Chen", contact_info: "mike@mindfulpodcast.com", collaboration_angle: "Mindfulness-focused audience" },
      { podcast_name: "Health & Home", host_name: "Lisa Rodriguez", contact_info: "@healthandhomepod", collaboration_angle: "Healthy living spaces" },
    ],
    trend_piggyback: "Connect to current wellness and mental health awareness trends (#MindfulMonday #SelfCareSunday).",
    social_caption: `🎙️ New episode live: "${episodeTitle}" — dive into insights that matter. #podcast #wellness #mindfulness`,
    next_step: "Create 3 post variants with quotes + hashtags; share in one targeted community today.",
    growth_score: "75/100 - Transcribed successfully; advanced analysis fell back.",
  };
}
