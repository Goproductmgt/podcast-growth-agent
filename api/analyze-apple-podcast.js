// api/analyze-apple-podcast.js
// Apple Podcasts URL → metadata → stream MP3 → Vercel Blob (public) → Groq Whisper → Enhanced TROOP
// This version includes hardened JSON parsing for the TROOP step (no more "Unexpected non-whitespace" 500s)

import { setCorsHeaders } from '../lib/cors.js';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { put } from '@vercel/blob';

// -----------------------
// Config
// -----------------------
const APP_CONFIG = {
  METADATA_URL: 'https://podcast-api-amber.vercel.app/api/transcribe', // metadataOnly=true
  GROQ: {
    API_URL: 'https://api.groq.com/openai/v1/audio/transcriptions',
    MODEL: 'whisper-large-v3-turbo',
    RESPONSE_FORMAT: 'text',
  },
  OPENAI: {
    CHAT_URL: 'https://api.openai.com/v1/chat/completions',
    ANALYSIS_MODEL: 'gpt-4o-mini',
  },
  HARD_SIZE_LIMIT_BYTES: 1024 * 1024 * 300, // 300MB hard stop
  BLOB_ACCESS: 'public', // generated blobs are public-read to let Groq fetch them if needed
};

// -----------------------
// CORS + handler
// -----------------------
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
    debug.push('📞 Fetching episode metadata…');

    // 1) Metadata (fast)
    const meta = await getEpisodeMetadata(appleUrl, debug);
    const episodeTitle = meta.title || title || 'Episode';
    const podcastTitle = meta.podcast_title || meta.podcastTitle || 'Podcast';

    const audioUrl = pickAudioUrl(meta);
    if (!audioUrl) {
      return res.status(400).json({ error: 'No audio URL found in episode metadata.', debug });
    }
    debug.push(`🎵 MP3: ${String(audioUrl).slice(0, 140)}…`);

    // 2) HEAD check (fail fast on absurd size)
    debug.push('🧪 HEAD check…');
    const { contentLength } = await headInfo(audioUrl);
    if (contentLength && contentLength > APP_CONFIG.HARD_SIZE_LIMIT_BYTES) {
      return res.status(413).json({
        error: `Audio too large (${Math.round(contentLength / 1024 / 1024)}MB). Try the MP3 upload path or trim the file.`,
        debug,
      });
    }

    // 3) Download MP3 → /tmp (streaming)
    debug.push('📥 Downloading to /tmp…');
    const tmpInfo = await downloadAudioToTmp(audioUrl);
    debug.push(`📁 Downloaded to /tmp: ~${Math.round(tmpInfo.sizeBytes / 1024 / 1024)}MB`);

    // 4) Upload that file to Vercel Blob (public) so Groq can fetch if needed later
    debug.push('🫧 Uploading to Vercel Blob…');
    const blobUrl = await uploadTmpToBlob(tmpInfo.tmpPath, `${safeSlug(episodeTitle)}.mp3`);
    debug.push(`🫧 Blob URL: ${blobUrl}`);

    // 5) Transcribe with Groq (file stream – fastest path)
    debug.push('⚡ Transcribing with Groq…');
    const transcription = await transcribeWithGroqFromTmp(tmpInfo.tmpPath, episodeTitle);
    debug.push(`✅ Transcribed chars: ${transcription.transcript.length}`);

    // 6) Enhanced TROOP analysis (hardened JSON parsing + retries)
    debug.push('🧠 Running Enhanced TROOP…');
    const analysis = await analyzeWithEnhancedTROOP(
      transcription.transcript,
      episodeTitle,
      podcastTitle,
      debug
    );
    debug.push('✅ TROOP complete');

    const processingTime = Date.now() - startTime;

    return res.status(200).json({
      success: true,
      source: 'Apple URL → /tmp → Blob → Groq Whisper → Enhanced TROOP',
      metadata: {
        title: episodeTitle,
        podcastTitle,
        originalUrl: appleUrl,
        audioUrl,               // from metadata
        blobUrl,                // the blob we created
        duration: meta.duration || transcription.metrics.durationSeconds,
        transcriptionSource: transcription.metrics.source,
        audio_metrics: transcription.metrics,
        processing_time_ms: processingTime,
        processed_at: new Date().toISOString(),
        api_version: '4.3-apple-blob-troop-hardened',
      },
      transcript: transcription.transcript,
      description: meta.description,
      keywords: meta.keywords || [],
      analysis,
      debug,
    });

  } catch (err) {
    const processingTime = Date.now() - startTime;
    return res.status(500).json({
      error: 'Analysis failed',
      details: String(err?.message || err),
      processing_time_ms: processingTime,
    });
  }
}

// -----------------------
// Helpers (request + meta)
// -----------------------
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(raw);
}

async function getEpisodeMetadata(appleUrl, debug) {
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(APP_CONFIG.METADATA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: appleUrl, metadataOnly: true }),
  });
  if (!r.ok) {
    debug.push('⚠️ Metadata service unavailable, falling back to URL parse');
    return extractBasicMetadataFromUrl(appleUrl);
  }
  const text = await r.text();
  const lines = text.trim().split('\n').filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.status === 'success' || parsed.title) return parsed;
    } catch {}
  }
  return extractBasicMetadataFromUrl(appleUrl);
}

function pickAudioUrl(meta) {
  // prefer direct enclosure if present
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
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!r.ok) return { contentLength: 0, contentType: '' };
    return {
      contentLength: Number(r.headers.get('content-length') || 0),
      contentType: r.headers.get('content-type') || '',
    };
  } catch {
    return { contentLength: 0, contentType: '' };
  }
}

// -----------------------
// Download → /tmp
// -----------------------
async function downloadAudioToTmp(audioUrl) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(audioUrl, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download audio: ${res.status} ${res.statusText}`);
  }
  const tmpPath = path.join('/tmp', `episode-${Date.now()}.mp3`);
  await pipeline(res.body, fs.createWriteStream(tmpPath));
  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error('Downloaded audio appears empty or truncated.');
  }
  return { tmpPath, sizeBytes: stat.size };
}

// -----------------------
// Upload /tmp → Blob
// -----------------------
async function uploadTmpToBlob(tmpPath, filename) {
  const fileBuffer = fs.readFileSync(tmpPath);
  const { url } = await put(filename, fileBuffer, {
    access: APP_CONFIG.BLOB_ACCESS,
    contentType: 'audio/mpeg',
    addRandomSuffix: true,
  });
  return url;
}

function safeSlug(s) {
  return String(s || 'episode')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// -----------------------
// Groq transcription
// -----------------------
async function transcribeWithGroqFromTmp(tmpPath, filenameBase = 'Episode') {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error('Groq API key not configured');

  const { default: fetch } = await import('node-fetch');
  const formData = new FormData();
  formData.append('file', fs.createReadStream(tmpPath), {
    filename: `${filenameBase}.mp3`,
    contentType: 'audio/mpeg',
  });
  formData.append('model', APP_CONFIG.GROQ.MODEL);
  formData.append('response_format', APP_CONFIG.GROQ.RESPONSE_FORMAT);

  try {
    const response = await fetch(APP_CONFIG.GROQ.API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}`, ...formData.getHeaders() },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Groq API error: ${response.status} ${errorText}`);
    }

    const transcript = await response.text();
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
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// -----------------------
// TROOP analysis (hardened)
// -----------------------
function stripCodeFences(s) {
  if (!s) return s;
  return s
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function extractJsonObject(text) {
  if (!text) throw new Error('Empty model response');
  try { return JSON.parse(text); } catch {}
  const unfenced = stripCodeFences(text);
  try { return JSON.parse(unfenced); } catch {}

  let start = -1, depth = 0;
  for (let i = 0; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = unfenced.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch {}
      }
    }
  }
  throw new Error('Could not extract valid JSON from model output');
}

async function analyzeWithEnhancedTROOP(transcript, episodeTitle = '', podcastTitle = '', debugArr = []) {
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

{ "episode_summary": "...",
  "tweetable_quotes": ["...", "...", "..."],
  "topics_keywords": ["...", "...", "...", "...", "..."],
  "optimized_title": "...",
  "optimized_description": "...",
  "community_suggestions": [
    { "name": "...","platform":"...","url":"...","why":"...","post_angle":"...","member_size":"...","engagement_strategy":"...","conversion_potential":"..." },
    { "name": "...","platform":"...","url":"...","why":"...","post_angle":"...","member_size":"...","engagement_strategy":"...","conversion_potential":"..." },
    { "name": "...","platform":"...","url":"...","why":"...","post_angle":"...","member_size":"...","engagement_strategy":"...","conversion_potential":"..." }
  ],
  "cross_promo_matches": [
    { "podcast_name":"...","host_name":"...","contact_info":"...","audience_overlap":"...","collaboration_value":"...","outreach_timing":"...","suggested_approach":"..." },
    { "podcast_name":"...","host_name":"...","contact_info":"...","audience_overlap":"...","collaboration_value":"...","outreach_timing":"...","suggested_approach":"..." },
    { "podcast_name":"...","host_name":"...","contact_info":"...","audience_overlap":"...","collaboration_value":"...","outreach_timing":"...","suggested_approach":"..." }
  ],
  "trend_piggyback":"...",
  "social_caption":"...",
  "next_step":"...",
  "growth_score":"..."
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

  async function callOpenAI(prompt, attempt = 1) {
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
        temperature: attempt === 1 ? 0.6 : 0.4,
        max_tokens: 4000,
        seed: 7,
        messages: [
          { role: 'system', content: baseSystem },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const status = resp.status;
    const raw = await resp.text();

    if (status < 200 || status >= 300) {
      return { ok: false, status, errorText: raw };
    }

    // Try to parse envelope; if not, try direct extraction
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (e) {
      try {
        const json = extractJsonObject(raw);
        return { ok: true, json };
      } catch (ee) {
        return { ok: false, status, errorText: `Envelope parse error: ${e.message} | raw=${raw.slice(0, 400)}...` };
      }
    }

    const content = envelope?.choices?.[0]?.message?.content;
    if (!content) {
      try {
        const json = extractJsonObject(raw);
        return { ok: true, json };
      } catch (e) {
        return { ok: false, status, errorText: `No content in response | raw=${raw.slice(0, 400)}...` };
      }
    }

    try {
      const json = extractJsonObject(content);
      return { ok: true, json };
    } catch (e) {
      try {
        const json = extractJsonObject(raw);
        return { ok: true, json };
      } catch (ee) {
        debugArr.push(`❌ JSON extraction failed (attempt ${attempt}): ${e.message}`);
        debugArr.push(`🔎 First 300: ${String(content).slice(0, 300)}`);
        debugArr.push(`🔎 Last 300: ${String(content).slice(-300)}`);
        return { ok: false, status, errorText: `Model content not valid JSON: ${String(content).slice(0, 300)}...` };
      }
    }
  }

  // 1st attempt
  let attempt = await callOpenAI(enhancedTROOPPrompt, 1);
  if (attempt.ok) return attempt.json;

  // 2nd attempt (tighter)
  attempt = await callOpenAI(enhancedTROOPPrompt, 2);
  if (attempt.ok) return attempt.json;

  // Distill fallback
  const distilled = await distillTranscript(transcript, openaiApiKey, baseSystem);
  const distilledPrompt = enhancedTROOPPrompt.replace(
    /\*\*TRANSCRIPT:\*\*[\s\S]*$/m,
    `**TRANSCRIPT (DISTILLED):**\n${distilled}\n\nRespond ONLY with valid JSON.`
  );
  attempt = await callOpenAI(distilledPrompt, 2);
  if (attempt.ok) return attempt.json;

  return {
    ...createFallbackAnalysis(transcript, episodeTitle),
    _debug_troop_fail: {
      error: attempt.errorText || 'Unknown',
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
    const json = extractJsonObject(content);
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

// -----------------------
// Fallback
// -----------------------
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