// api/analyze-apple-podcast.js
// Apple Podcasts URL → metadata → stream MP3 to /tmp (with retries/timeouts) → Groq Whisper → TROOP JSON (forced + fallback)

import { setCorsHeaders } from '../lib/cors.js';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const APP_CONFIG = {
  METADATA_URL: 'https://podcast-api-amber.vercel.app/api/transcribe',
  GROQ: {
    API_URL: 'https://api.groq.com/openai/v1/audio/transcriptions',
    MODEL: 'whisper-large-v3-turbo',
    RESPONSE_FORMAT: 'text',
  },
  OPENAI: {
    CHAT_URL: 'https://api.openai.com/v1/chat/completions',
    ANALYSIS_MODEL: 'gpt-4o-mini',
  },
  HARD_SIZE_LIMIT_BYTES: 1024 * 1024 * 300, // 300MB
  FETCH_TIMEOUT_MS: 60_000,
  MAX_RETRIES: 2,
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

    debug.push(`🚀 Apple analysis start: ${appleUrl}`);
    debug.push('📞 Fetching metadata (fast)…');

    // 1) Metadata (metadataOnly)
    const meta = await getEpisodeMetadata(appleUrl, debug);
    const episodeTitle = meta.title || title || 'Episode';
    const podcastTitle = meta.podcast_title || meta.podcastTitle || 'Podcast';
    const audioUrl = pickAudioUrl(meta);
    if (!audioUrl) {
      return res.status(400).json({ error: 'No audio URL found in metadata', debug });
    }
    debug.push(`🎵 Audio URL found: ${String(audioUrl).slice(0, 140)}…`);

    // 2) HEAD check
    debug.push('🧪 HEAD check…');
    const { contentLength } = await headInfo(audioUrl);
    if (contentLength && contentLength > APP_CONFIG.HARD_SIZE_LIMIT_BYTES) {
      return res.status(413).json({
        error: `Audio too large (${Math.round(contentLength / 1024 / 1024)}MB). Use MP3 upload path.`,
        debug,
      });
    }

    // 3) Download → /tmp with retries
    debug.push('📥 Downloading MP3 → /tmp (stream) with retries…');
    const tmpInfo = await downloadToTmpWithRetries(audioUrl, APP_CONFIG.MAX_RETRIES, APP_CONFIG.FETCH_TIMEOUT_MS);
    debug.push(`📁 Saved to /tmp (${Math.round(tmpInfo.sizeBytes / 1024 / 1024)}MB)`);

    // 4) Groq Whisper (from disk)
    debug.push('⚡ Transcribing with Groq Whisper…');
    const transcription = await transcribeWithGroqFromTmp(tmpInfo.tmpPath, episodeTitle);
    debug.push(`✅ Transcribed (${transcription.transcript.length} chars)`);

    // 5) TROOP analysis (forced JSON + retry + distilled fallback)
    debug.push('🧠 Running TROOP analysis…');
    const analysis = await analyzeWithTROOP(transcription.transcript, episodeTitle, podcastTitle);
    debug.push('✅ TROOP analysis complete');

    const processingTime = Date.now() - startTime;
    return res.status(200).json({
      success: true,
      source: 'Apple URL + /tmp streaming + Groq Whisper + TROOP',
      metadata: {
        title: episodeTitle,
        podcastTitle,
        originalUrl: appleUrl,
        audioUrl,
        description: meta.description,
        duration: meta.duration || transcription.metrics.durationSeconds,
        keywords: meta.keywords || [],
        transcriptionSource: transcription.metrics.source,
        processing_time_ms: processingTime,
        processed_at: new Date().toISOString(),
        api_version: '4.3-apple-url-stable',
      },
      transcript: transcription.transcript,
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

/* ---------- helpers ---------- */

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
      signal: AbortSignal.timeout(APP_CONFIG.FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`Metadata ${r.status}`);
    const text = await r.text();
    const lines = text.trim().split('\n').filter(Boolean);
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'success' || parsed.title) return parsed;
      } catch {}
    }
    throw new Error('No metadata lines parsed');
  } catch (e) {
    debug.push(`⚠️ Metadata fallback: ${e.message}`);
    return extractBasicMetadataFromUrl(appleUrl);
  }
}

function pickAudioUrl(meta) {
  return meta.audio_url || meta.audioUrl || meta.enclosure_url || meta.mp3_url || null;
}

function extractBasicMetadataFromUrl(appleUrl) {
  const parts = appleUrl.split('/');
  const titlePart = parts.find((p) => p.includes('-') && !p.includes('id'));
  const title = titlePart ? titlePart.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()) : 'Episode';
  return { title, podcast_title: 'Podcast', description: 'Episode from Apple URL', duration: 0 };
}

async function headInfo(url) {
  const { default: fetch } = await import('node-fetch');
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { contentLength: 0, contentType: '' };
    return {
      contentLength: Number(r.headers.get('content-length') || 0),
      contentType: r.headers.get('content-type') || '',
    };
  } catch {
    return { contentLength: 0, contentType: '' };
  }
}

async function downloadToTmpWithRetries(audioUrl, maxRetries, timeoutMs) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await downloadAudioToTmp(audioUrl, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (attempt <= maxRetries) await new Promise(r => setTimeout(r, 600 * attempt));
    }
  }
  throw lastErr;
}

async function downloadAudioToTmp(audioUrl, timeoutMs) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(audioUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`Download failed ${res.status} ${res.statusText}`);

  const tmpPath = path.join('/tmp', `episode-${Date.now()}.mp3`);
  await pipeline(res.body, fs.createWriteStream(tmpPath));
  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error('Downloaded audio empty/truncated');
  }
  return { tmpPath, sizeBytes: stat.size };
}

async function transcribeWithGroqFromTmp(tmpPath, filenameBase = 'Episode') {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error('GROQ_API_KEY not set');

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
      signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Groq ${response.status} ${errorText}`);
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

/* ---------- TROOP (forced JSON + distilled fallback) ---------- */

async function analyzeWithTROOP(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) return createFallbackAnalysis(transcript, episodeTitle);

  const baseSystem = [
    'You are Podcast Growth Agent.',
    'Respond with valid JSON only. No markdown, no code fences, no commentary.',
    'Do NOT provide medical advice; focus on marketing/SEO/community.',
    'Arrays MUST contain exactly 3 items for tweetable_quotes, community_suggestions, cross_promo_matches.'
  ].join(' ');

  const enhancedTROOPPrompt = buildTroopPrompt(transcript, episodeTitle, podcastTitle);

  // one helper that calls OpenAI and enforces JSON
  async function callOpenAI(prompt) {
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 4000,
        messages: [{ role: 'system', content: baseSystem }, { role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(90_000),
    });

    const status = resp.status;
    const raw = await resp.text();
    if (status < 200 || status >= 300) return { ok: false, errorText: `HTTP ${status} ${raw.slice(0, 300)}` };

    let data; try { data = JSON.parse(raw); } catch (e) { return { ok: false, errorText: `openai JSON parse err: ${e.message}` }; }
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { ok: false, errorText: 'no content' };

    try { return { ok: true, json: JSON.parse(content) }; }
    catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) { try { return { ok: true, json: JSON.parse(match[0]) }; } catch {} }
      return { ok: false, errorText: 'model content not JSON' };
    }
  }

  // Try once
  let attempt = await callOpenAI(enhancedTROOPPrompt);
  if (attempt.ok) return attempt.json;

  // Try again (transient)
  attempt = await callOpenAI(enhancedTROOPPrompt);
  if (attempt.ok) return attempt.json;

  // Distill → Analyze
  const distilled = await distillTranscript(transcript, openaiApiKey, baseSystem);
  const distilledPrompt = enhancedTROOPPrompt.replace(
    /\*\*TRANSCRIPT:\*\*[\s\S]*$/m,
    `**TRANSCRIPT (DISTILLED):**\n${distilled}\n\nRespond ONLY with valid JSON.`
  );
  attempt = await callOpenAI(distilledPrompt);
  if (attempt.ok) return attempt.json;

  return { ...createFallbackAnalysis(transcript, episodeTitle), _debug_troop_fail: attempt.errorText || 'unknown' };
}

function buildTroopPrompt(transcript, episodeTitle, podcastTitle) {
  return `**TASK:**
Analyze the provided transcript and generate a comprehensive 10-section growth strategy.

**ROLE:** Podcast Growth Agent (marketing/SEO/community).

**CRITICAL REQUIREMENTS:**
- EXACTLY 3 tweetable quotes
- EXACTLY 3 community suggestions
- EXACTLY 3 cross-promo matches
- Niche communities (1K–100K), not generic
- Use actual transcript content

**OUTPUT:** (valid JSON, arrays sized exactly as specified)
{
  "episode_summary": "...",
  "tweetable_quotes": ["...", "...", "..."],
  "topics_keywords": ["...", "...", "...", "...", "..."],
  "optimized_title": "...",
  "optimized_description": "...",
  "community_suggestions": [
    {"name":"...","platform":"...","url":"...","why":"...","post_angle":"...","member_size":"...","engagement_strategy":"..."},
    {"name":"...","platform":"...","url":"...","why":"...","post_angle":"...","member_size":"...","engagement_strategy":"..."},
    {"name":"...","platform":"...","url":"...","why":"...","post_angle":"...","member_size":"...","engagement_strategy":"..."}
  ],
  "cross_promo_matches": [
    {"podcast_name":"...","host_name":"...","contact_info":"...","collaboration_angle":"...","suggested_approach":"..."},
    {"podcast_name":"...","host_name":"...","contact_info":"...","collaboration_angle":"...","suggested_approach":"..."},
    {"podcast_name":"...","host_name":"...","contact_info":"...","collaboration_angle":"...","suggested_approach":"..."}
  ],
  "trend_piggyback":"...",
  "social_caption":"...",
  "next_step":"...",
  "growth_score":"..."
}

**EPISODE:**
Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast'}

**TRANSCRIPT:**
${transcript.length > 15000 ? transcript.slice(0, 15000) + '\n[Truncated]' : transcript}

Respond ONLY with valid JSON.`;
}

async function distillTranscript(transcript, openaiApiKey, baseSystem) {
  const { default: fetch } = await import('node-fetch');
  const prompt = [
    'Condense transcript into JSON { "summary":"", "key_points":[""], "topics":[""], "quotes":[""] }',
    'Focus only on marketing-relevant themes and quotable lines.',
    transcript.length > 24000 ? transcript.slice(0, 24000) + '\n[Truncated]' : transcript,
  ].join('\n');

  const r = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.5,
      max_tokens: 1200,
      messages: [{ role: 'system', content: baseSystem }, { role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const raw = await r.text();
  try {
    const data = JSON.parse(raw);
    const content = data.choices?.[0]?.message?.content || '{}';
    const json = JSON.parse(content);
    return [
      `SUMMARY: ${json.summary || ''}`,
      `KEY_POINTS: ${(json.key_points || []).join(' | ')}`,
      `TOPICS: ${(json.topics || []).join(', ')}`,
      `QUOTES: ${(json.quotes || []).join(' | ')}`,
    ].join('\n');
  } catch {
    return transcript.slice(0, 8000);
  }
}

function createFallbackAnalysis(transcript, episodeTitle) {
  return {
    episode_summary: "Episode transcribed. Advanced analysis temporarily unavailable (fallback).",
    tweetable_quotes: [
      `🎙️ New episode: "${episodeTitle}" — big insights inside!`,
      "📈 Every episode is a chance to earn a new listener.",
      "🚀 Consistency compounds your podcast growth."
    ],
    topics_keywords: ["podcast", "growth", "strategy", "audience", "content"],
    optimized_title: episodeTitle || "Optimize this title for SEO",
    optimized_description: "Craft a clear value-forward description with primary and related keywords.",
    community_suggestions: [
      { name: "Mindfulness", platform: "Reddit", url: "https://reddit.com/r/mindfulness", why: "Active, aligned topics" },
      { name: "Self Care Support", platform: "Facebook", url: "https://facebook.com/groups/selfcaresupport", why: "Engaged wellness audience" },
      { name: "Wellness Warriors", platform: "Discord", url: "https://discord.com/invite/wellness", why: "Realtime discussions" }
    ],
    cross_promo_matches: [
      { podcast_name: "The Wellness Hour", host_name: "Sarah Johnson", contact_info: "@sarahwellness", collaboration_angle: "Practical overlap" },
      { podcast_name: "Mindful Living Daily", host_name: "Mike Chen", contact_info: "mike@mindfulpodcast.com", collaboration_angle: "Mindfulness focus" },
      { podcast_name: "Health & Home", host_name: "Lisa Rodriguez", contact_info: "@healthandhomepod", collaboration_angle: "Healthy spaces" }
    ],
    trend_piggyback: "Tie to current wellness awareness hashtags (#MindfulMonday #SelfCareSunday).",
    social_caption: `🎙️ New episode: "${episodeTitle}" — listen now. #podcast #growth`,
    next_step: "Create 3 quote posts with hashtags and share in one niche community today.",
    growth_score: "75/100 – transcription OK; advanced analysis fell back.",
  };
}
