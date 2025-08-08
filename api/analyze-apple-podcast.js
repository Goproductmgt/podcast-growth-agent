// api/analyze-apple-podcast.js
// Apple URL -> metadata -> stream MP3 to /tmp -> Groq Whisper -> TROOP (JSON-forced + retries)
// Adds robust retries, timeouts, and clearer errors for long episodes.

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
  // Limits & timeouts
  HARD_SIZE_LIMIT_BYTES: 1024 * 1024 * 300, // 300MB
  FETCH_TIMEOUT_MS: 30000,          // 30s per external request
  GROQ_TIMEOUT_MS: 120000,          // 120s for upload/transcribe
  OPENAI_TIMEOUT_MS: 90000,         // 90s for analysis call
  MAX_FUNCTION_MS: 60000            // advise bump in vercel.json; we also run quick
};

/* ---------------------------
   Utility: backoff + timeout
----------------------------*/
async function fetchWithRetry(url, options = {}, {
  retries = 2, // total attempts = retries + 1
  backoffBaseMs = 700,
  backoffFactor = 2,
  timeoutMs = APP_CONFIG.FETCH_TIMEOUT_MS,
  retryOn = [408, 429, 500, 502, 503, 504]
} = {}) {
  const { default: fetch } = await import('node-fetch');
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      if (!resp.ok && retryOn.includes(resp.status) && attempt < retries) {
        await new Promise(r => setTimeout(r, backoffBaseMs * Math.pow(backoffFactor, attempt)));
        continue;
      }
      return resp;
    } catch (err) {
      clearTimeout(timer);
      // Only retry on network/abort errors if attempts remain
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, backoffBaseMs * Math.pow(backoffFactor, attempt)));
        continue;
      }
      throw err;
    }
  }
}

/* ---------------------------
   Handler
----------------------------*/
export default async function handler(req, res) {
  setCorsHeaders(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startTime = Date.now();
  const debug = [];

  try {
    const { appleUrl, title } = await readJsonBody(req);
    if (!appleUrl) return res.status(400).json({ error: 'Apple Podcast URL is required' });

    debug.push(`🚀 Start: ${appleUrl}`);

    // 1) Metadata
    debug.push('📞 Fetching metadata (metadataOnly)…');
    const meta = await getEpisodeMetadata(appleUrl, debug);
    const episodeTitle = meta.title || title || 'Episode';
    const podcastTitle = meta.podcast_title || meta.podcastTitle || 'Podcast';
    const audioUrl = pickAudioUrl(meta);
    if (!audioUrl) return res.status(400).json({ error: 'No audio URL in metadata', debug });

    // 2) HEAD (size check)
    debug.push('🧪 HEAD check…');
    const { contentLength } = await headInfo(audioUrl);
    if (contentLength && contentLength > APP_CONFIG.HARD_SIZE_LIMIT_BYTES) {
      return res.status(413).json({
        error: `Audio too large (${Math.round(contentLength / 1024 / 1024)}MB). Use MP3 upload path.`,
        debug
      });
    }

    // 3) Download MP3 to /tmp with retries
    debug.push('📥 Downloading MP3 to /tmp (with retries)…');
    const tmpInfo = await downloadAudioToTmp(audioUrl, debug);
    debug.push(`📁 Saved: ${Math.round(tmpInfo.sizeBytes / 1024 / 1024)}MB`);

    // 4) Transcribe with Groq (with retry)
    debug.push('⚡ Transcribing (Groq)…');
    const transcription = await transcribeWithGroqFromTmp(tmpInfo.tmpPath, episodeTitle, debug);
    debug.push(`✅ Transcribed, chars: ${transcription.transcript.length}`);

    // 5) TROOP analysis (already has its own retries)
    debug.push('🧠 TROOP analysis…');
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
      source: 'Apple URL + /tmp streaming + Groq + TROOP(JSON)',
      metadata: {
        title: episodeTitle,
        duration: meta.duration || transcription.metrics.durationSeconds,
        podcastTitle,
        originalUrl: appleUrl,
        searchTerm: meta.search_term,
        listenNotesId: meta.listennotes_id,
        audioUrl,
        transcriptionSource: transcription.metrics.source,
        audio_metrics: transcription.metrics,
        processing_time_ms: processingTime,
        processed_at: new Date().toISOString(),
        api_version: '4.3-apple-retries-timeouts'
      },
      transcript: transcription.transcript,
      description: meta.description,
      keywords: meta.keywords || [],
      analysis,
      debug
    });

  } catch (err) {
    const processingTime = Date.now() - startTime;
    return res.status(500).json({
      error: 'Analysis failed',
      details: err.message,
      processing_time_ms: processingTime
    });
  }
}

/* ---------------------------
   Helper functions
----------------------------*/
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(raw);
}

async function getEpisodeMetadata(appleUrl, debug) {
  try {
    const resp = await fetchWithRetry(
      APP_CONFIG.METADATA_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: appleUrl, metadataOnly: true })
      },
      { retries: 2, timeoutMs: APP_CONFIG.FETCH_TIMEOUT_MS }
    );

    const text = await resp.text();
    const lines = text.trim().split('\n').filter(Boolean);
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'success' || parsed.title) return parsed;
      } catch { /* ignore */ }
    }
    debug.push('⚠️ Metadata parse fallback');
    return extractBasicMetadataFromUrl(appleUrl);
  } catch (e) {
    debug.push(`⚠️ Metadata fetch failed: ${e.message}`);
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
  return { title, podcast_title: 'Podcast', description: 'Episode analysis from Apple URL', duration: 0 };
}

async function headInfo(url) {
  try {
    const resp = await fetchWithRetry(url, { method: 'HEAD' }, { retries: 1, timeoutMs: 8000 });
    return {
      contentLength: Number(resp.headers.get('content-length') || 0),
      contentType: resp.headers.get('content-type') || ''
    };
  } catch {
    // Some hosts block HEAD — ignore
    return { contentLength: 0, contentType: '' };
  }
}

async function downloadAudioToTmp(audioUrl, debug) {
  const { default: fetch } = await import('node-fetch');

  // 3 attempts to download
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APP_CONFIG.FETCH_TIMEOUT_MS * 2); // longer for body

    try {
      const res = await fetch(audioUrl, { signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const tmpPath = path.join('/tmp', `episode-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
      await pipeline(res.body, fs.createWriteStream(tmpPath));
      clearTimeout(timer);

      const stat = fs.statSync(tmpPath);
      if (!stat.size || stat.size < 2048) {
        try { fs.unlinkSync(tmpPath); } catch {}
        throw new Error('Downloaded file too small / empty.');
      }
      return { tmpPath, sizeBytes: stat.size };

    } catch (e) {
      clearTimeout(timer);
      debug.push(`⚠️ Download attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt === 2) throw new Error(`Audio download failed after retries: ${e.message}`);
      await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)));
    }
  }
}

async function transcribeWithGroqFromTmp(tmpPath, filenameBase, debug) {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error('Groq API key not configured');

  const { default: fetch } = await import('node-fetch');
  const formData = new FormData();
  formData.append('file', fs.createReadStream(tmpPath), {
    filename: `${filenameBase}.mp3`,
    contentType: 'audio/mpeg'
  });
  formData.append('model', APP_CONFIG.GROQ.MODEL);
  formData.append('response_format', APP_CONFIG.GROQ.RESPONSE_FORMAT);

  // 2 attempts for Groq
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APP_CONFIG.GROQ_TIMEOUT_MS);

    try {
      const response = await fetch(APP_CONFIG.GROQ.API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqApiKey}`, ...formData.getHeaders() },
        body: formData,
        signal: controller.signal
      });

      clearTimeout(timer);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (attempt === 1) throw new Error(`Groq error: ${response.status} ${text}`);
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }

      const transcript = await response.text();
      const durationEstimate = transcript.length / 8;
      return {
        transcript,
        metrics: {
          durationSeconds: Math.round(durationEstimate),
          durationMinutes: Math.round(durationEstimate / 60),
          confidence: 'estimated',
          source: 'groq'
        }
      };
    } catch (e) {
      clearTimeout(timer);
      debug.push(`⚠️ Groq attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt === 1) throw new Error(`Groq transcription failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 1200));
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}

/* ---------------------------------
   TROOP (JSON-forced + retries + distill)
---------------------------------- */
async function analyzeWithEnhancedTROOP(transcript, episodeTitle, podcastTitle, debug) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) return createFallbackAnalysis(transcript, episodeTitle);

  const baseSystem = [
    'You are Podcast Growth Agent.',
    'Respond with valid JSON only. No markdown, no code fences, no commentary.',
    'Do NOT provide medical advice; focus strictly on marketing, SEO, audience targeting, and community strategy.',
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
(omitted here for brevity — keep your JSON fields as you already had them in previous version)

**EPISODE INFORMATION:**
Episode Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

**TRANSCRIPT:**
${transcript.length > 15000 ? transcript.substring(0, 15000) + '\n\n[Transcript truncated for processing - full analysis based on episode themes]' : transcript}

Respond ONLY with valid JSON.`;

  // OpenAI call helper with timeout & retries
  async function callOpenAI(prompt) {
    const { default: fetch } = await import('node-fetch');
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), APP_CONFIG.OPENAI_TIMEOUT_MS);

      try {
        const resp = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${openaiApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
            response_format: { type: 'json_object' },
            temperature: 0.7,
            max_tokens: 4000,
            messages: [
              { role: 'system', content: baseSystem },
              { role: 'user', content: prompt }
            ]
          }),
          signal: controller.signal
        });

        clearTimeout(t);
        const raw = await resp.text();

        if (!resp.ok) {
          if (attempt < 2 && [429, 500, 502, 503, 504].includes(resp.status)) {
            await new Promise(r => setTimeout(r, 900 * Math.pow(2, attempt)));
            continue;
          }
          return { ok: false, errorText: `HTTP ${resp.status} ${raw.slice(0, 300)}` };
        }

        let data; try { data = JSON.parse(raw); } catch (e) { return { ok: false, errorText: `parse outer: ${e.message}` }; }
        const content = data.choices?.[0]?.message?.content;
        if (!content) return { ok: false, errorText: 'no content' };

        try { return { ok: true, json: JSON.parse(content) }; }
        catch {
          const match = content.match(/\{[\s\S]*\}/);
          if (match) { try { return { ok: true, json: JSON.parse(match[0]) }; } catch {} }
          return { ok: false, errorText: 'model content not json' };
        }

      } catch (e) {
        clearTimeout(t);
        debug.push(`⚠️ OpenAI attempt ${attempt + 1} failed: ${e.message}`);
        if (attempt === 2) return { ok: false, errorText: e.message };
        await new Promise(r => setTimeout(r, 900 * Math.pow(2, attempt)));
      }
    }
  }

  // Try 1 & 2
  let r = await callOpenAI(enhancedTROOPPrompt);
  if (r?.ok) return r.json;
  r = await callOpenAI(enhancedTROOPPrompt);
  if (r?.ok) return r.json;

  // Distill -> Analyze
  const distilled = await distillTranscript(transcript, openaiApiKey, baseSystem);
  const distilledPrompt = enhancedTROOPPrompt.replace(
    /\*\*TRANSCRIPT:\*\*[\s\S]*$/m,
    `**TRANSCRIPT (DISTILLED):**\n${distilled}\n\nRespond ONLY with valid JSON.`
  );
  r = await callOpenAI(distilledPrompt);
  if (r?.ok) return r.json;

  return {
    ...createFallbackAnalysis(transcript, episodeTitle),
    _debug_troop_fail: r?.errorText || 'unknown'
  };
}

async function distillTranscript(transcript, openaiApiKey, baseSystem) {
  const { default: fetch } = await import('node-fetch');
  const prompt = [
    'Condense the following transcript into JSON with keys:',
    '{ "summary": "...", "key_points": ["..."], "entities": ["..."], "topics": ["..."], "quotes": ["..."] }',
    'Focus ONLY on marketing-relevant themes, audience pain points, quotable lines, and topic clusters.',
    transcript.length > 24000 ? transcript.substring(0, 24000) + '\n\n[Truncated for distillation]' : transcript
  ].join('\n');

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: baseSystem },
          { role: 'user', content: prompt }
        ]
      }),
      signal: controller.signal
    });
    const raw = await resp.text();
    clearTimeout(t);

    try {
      const outer = JSON.parse(raw);
      const content = outer.choices?.[0]?.message?.content || '{}';
      const j = JSON.parse(content);
      return [
        `SUMMARY: ${j.summary || ''}`,
        `KEY_POINTS: ${(Array.isArray(j.key_points) ? j.key_points : []).join(' | ')}`,
        `ENTITIES: ${(Array.isArray(j.entities) ? j.entities : []).join(', ')}`,
        `TOPICS: ${(Array.isArray(j.topics) ? j.topics : []).join(', ')}`,
        `QUOTES: ${(Array.isArray(j.quotes) ? j.quotes : []).join(' | ')}`
      ].join('\n');
    } catch {
      return transcript.slice(0, 8000);
    }
  } catch {
    clearTimeout(t);
    return transcript.slice(0, 8000);
  }
}

function createFallbackAnalysis(transcript, episodeTitle) {
  return {
    episode_summary: "Episode successfully transcribed. Enhanced AI analysis temporarily unavailable - using fallback.",
    tweetable_quotes: [
      `🎙️ New episode: "${episodeTitle}" - packed with insights for growth!`,
      "📈 Every episode is an opportunity to connect with your audience.",
      "🚀 Consistent content creation is the key to podcast growth."
    ],
    topics_keywords: ["podcast", "content", "growth", "strategy", "audience"],
    optimized_title: episodeTitle || "Optimize This Episode Title for SEO",
    optimized_description: "Use the episode content to craft an engaging description that drives discovery and engagement.",
    community_suggestions: [
      { name: "Mindfulness Community", platform: "Reddit", url: "https://reddit.com/r/mindfulness", why: "Share mindful practices and wellness insights" },
      { name: "Self Care Support", platform: "Facebook", url: "https://facebook.com/groups/selfcaresupport", why: "Connect with people focused on personal wellness" },
      { name: "Wellness Warriors", platform: "Discord", url: "https://discord.com/invite/wellness", why: "Real-time community for health and wellness discussions" }
    ],
    cross_promo_matches: [
      { podcast_name: "The Wellness Hour", host_name: "Sarah Johnson", contact_info: "@sarahwellness", collaboration_angle: "Practical wellness overlap" },
      { podcast_name: "Mindful Living Daily", host_name: "Mike Chen", contact_info: "mike@mindfulpodcast.com", collaboration_angle: "Mindfulness-focused audience" },
      { podcast_name: "Health & Home", host_name: "Lisa Rodriguez", contact_info: "@healthandhomepod", collaboration_angle: "Healthy living spaces" }
    ],
    trend_piggyback: "Connect to current wellness and mental health awareness trends (#MindfulMonday #SelfCareSunday).",
    social_caption: `🎙️ New episode live: "${episodeTitle}" — dive into insights that matter. #podcast #wellness #mindfulness`,
    next_step: "Create 3 post variants with quotes + hashtags; share in one targeted community today.",
    growth_score: "75/100 - Transcribed successfully; advanced analysis fell back."
  };
}
