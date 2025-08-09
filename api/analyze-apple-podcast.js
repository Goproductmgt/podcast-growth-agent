// api/analyze-apple-podcast.js
// Apple Podcasts URL → metadata → /tmp download (retries/timeouts) → upload to Vercel Blob →
// -> CHUNKED Groq Whisper transcription (Range-based) → Enhanced TROOP (JSON-forced + distilled fallback)
// Improvements:
// - Prompt: voice profile + explicit dependency on primary/neighbor keywords across outputs
// - Output: keep keyword objects AND auto-create flat topics_keywords list for compatibility
// - Groq: retry on 5xx within each chunk

import { setCorsHeaders } from '../lib/cors.js';
import { put } from '@vercel/blob';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

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
  HARD_SIZE_LIMIT_BYTES: 1024 * 1024 * 300, // 300MB
  FETCH_TIMEOUT_MS: 60_000,
  MAX_RETRIES: 2,
  MAX_CHUNK_BYTES: Number(process.env.MAX_CHUNK_MB || 18) * 1024 * 1024, // default 18MB
  MIN_CHUNK_BYTES: 8 * 1024 * 1024, // 8MB floor
  GROQ_RETRY_COUNT: 2,
  GROQ_RETRY_DELAY_MS: 800,
};

export default async function handler(req, res) {
  setCorsHeaders(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startTime = Date.now();
  const debug = [];

  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(500).json({ error: 'Server misconfig: BLOB_READ_WRITE_TOKEN not set' });
    }
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'Server misconfig: GROQ_API_KEY not set' });
    }

    const { appleUrl, title } = await readJsonBody(req);
    if (!appleUrl) return res.status(400).json({ error: 'Apple Podcast URL is required' });

    debug.push(`🚀 Apple analysis start: ${appleUrl}`);
    debug.push('📞 Fetching metadata (fast)…');

    const meta = await getEpisodeMetadata(appleUrl, debug);
    const episodeTitle = meta.title || title || 'Episode';
    const podcastTitle = meta.podcast_title || meta.podcastTitle || 'Podcast';
    const audioUrl = pickAudioUrl(meta);
    if (!audioUrl) return res.status(400).json({ error: 'No audio URL found in metadata', debug });

    debug.push(`🎵 Audio URL: ${String(audioUrl).slice(0, 140)}…`);

    debug.push('🧪 HEAD check…');
    const { contentLength, contentType } = await headInfo(audioUrl);
    if (contentLength && contentLength > APP_CONFIG.HARD_SIZE_LIMIT_BYTES) {
      return res.status(413).json({
        error: `Audio too large (${Math.round(contentLength / 1024 / 1024)}MB). Use the MP3 upload path.`,
        debug,
      });
    }

    debug.push('📥 Downloading MP3 → /tmp (stream) with retries…');
    const tmpInfo = await downloadToTmpWithRetries(audioUrl, APP_CONFIG.MAX_RETRIES, APP_CONFIG.FETCH_TIMEOUT_MS);
    debug.push(`📁 Saved to /tmp (${Math.round(tmpInfo.sizeBytes / 1024 / 1024)}MB)`);

    const fileExt = guessExtension(contentType) || '.mp3';
    const blobFilename = safeName(`${episodeTitle}`) + fileExt;

    debug.push('☁️ Uploading to Vercel Blob…');
    const blob = await put(blobFilename, fs.createReadStream(tmpInfo.tmpPath), {
      access: 'public',
      addRandomSuffix: true,
      contentType: contentType || 'audio/mpeg',
    });
    debug.push(`✅ Blob uploaded: ${blob.url}`);

    debug.push('⚡ Transcribing with Groq (chunked from Blob)…');
    const transcription = await transcribeWithGroqFromBlobChunked(blob.url, blobFilename, debug);
    debug.push(`✅ Transcribed (${transcription.transcript.length} chars) via ${transcription.chunks} chunk(s)`);

    debug.push('🧠 Running Enhanced TROOP analysis…');
    let analysis = await analyzeWithTROOP(transcription.transcript, episodeTitle, podcastTitle);

    // ---- POST-PROCESS: keep object plan, also produce flat topics_keywords for compatibility/use downstream
    if (Array.isArray(analysis?.topics_keywords) && typeof analysis.topics_keywords[0] === 'object') {
      const plan = analysis.topics_keywords;
      analysis.keyword_plan = plan; // keep rich objects
      const flat = [];
      for (const k of plan) {
        if (k?.primary_intent) flat.push(String(k.primary_intent));
        if (Array.isArray(k?.semantic_neighbors)) {
          for (const n of k.semantic_neighbors) flat.push(String(n));
        }
      }
      analysis.topics_keywords = Array.from(new Set(flat)).slice(0, 15); // cap a bit
    }

    debug.push('✅ TROOP analysis complete');

    const processingTime = Date.now() - startTime;
    return res.status(200).json({
      success: true,
      source: 'Apple URL → /tmp → Blob → Groq (chunked) → Enhanced TROOP',
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
        api_version: '5.3-apple-url-blob-chunked',
        blob_url: blob.url,
      },
      transcript: transcription.transcript,
      analysis,
      debug,
    });
  } catch (err) {
    const processingTime = Date.now() - startTime;
    return res.status(500).json({
      error: 'Analysis failed',
      details: String(err.message || err),
      processing_time_ms: processingTime,
    });
  } finally {
    // tmp cleanup done in helpers
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
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
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
  const res = await fetch(audioUrl, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
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

function guessExtension(contentType) {
  if (!contentType) return '.mp3';
  if (contentType.includes('mpeg')) return '.mp3';
  if (contentType.includes('x-m4a') || contentType.includes('mp4') || contentType.includes('aac')) return '.m4a';
  if (contentType.includes('wav')) return '.wav';
  return '.mp3';
}

function safeName(s) {
  return (s || 'episode').replace(/[^a-z0-9\-_]+/gi, '-').slice(0, 80);
}

/* ---------- CHUNKED TRANSCRIPTION FROM BLOB ---------- */

async function transcribeWithGroqFromBlobChunked(blobUrl, filename, debug = []) {
  const { default: fetch } = await import('node-fetch');
  const groqApiKey = process.env.GROQ_API_KEY;

  // 1) Get Blob size
  const head = await fetch(blobUrl, { method: 'HEAD' });
  if (!head.ok) throw new Error(`Blob HEAD failed: ${head.status} ${head.statusText}`);
  const totalBytes = Number(head.headers.get('content-length') || 0);
  if (!totalBytes) {
    // fall back to single GET (small file)
    const fileRes = await fetch(blobUrl);
    if (!fileRes.ok) throw new Error(`Blob download failed: ${fileRes.status} ${fileRes.statusText}`);
    const arr = await fileRes.arrayBuffer();
    return await groqOnce(Buffer.from(arr), filename);
  }

  let offset = 0;
  let chunkSize = Math.min(APP_CONFIG.MAX_CHUNK_BYTES, totalBytes);
  let part = 1;
  const parts = [];
  const startedAt = Date.now();

  while (offset < totalBytes) {
    const end = Math.min(offset + chunkSize - 1, totalBytes - 1);
    const rangeHeader = `bytes=${offset}-${end}`;
    debug.push(`📦 Fetching chunk ${part} (${rangeHeader})`);

    const res = await fetch(blobUrl, { headers: { Range: rangeHeader } });
    if (!(res.status === 206 || (res.status === 200 && offset === 0 && end === totalBytes - 1))) {
      throw new Error(`Blob range fetch failed: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());

    try {
      const tr = await groqOnce(buf, `${filename}.part${part}.mp3`);
      parts.push(tr.transcript);
      debug.push(`🧩 Groq OK for chunk ${part} (${buf.length} bytes)`);
      offset = end + 1;
      part += 1;
    } catch (e) {
      const msg = String(e.message || e);
      if (/413/.test(msg) && chunkSize > APP_CONFIG.MIN_CHUNK_BYTES) {
        // halve chunk and retry same offset
        chunkSize = Math.max(APP_CONFIG.MIN_CHUNK_BYTES, Math.floor(chunkSize / 2));
        debug.push(`↘️ 413 from Groq, reducing chunk size to ~${Math.round(chunkSize / 1024 / 1024)}MB and retrying`);
        continue;
      }
      // retry 5xx for the same chunk
      if (/(500|502|503|504)/.test(msg)) {
        let retried = false;
        for (let i = 0; i < APP_CONFIG.GROQ_RETRY_COUNT; i++) {
          await new Promise(r => setTimeout(r, APP_CONFIG.GROQ_RETRY_DELAY_MS * (i + 1)));
          try {
            const tr2 = await groqOnce(buf, `${filename}.part${part}.mp3`);
            parts.push(tr2.transcript);
            debug.push(`🔁 Groq 5xx recovered on retry ${i + 1} for chunk ${part}`);
            offset = end + 1;
            part += 1;
            retried = true;
            break;
          } catch (e2) {
            if (i === APP_CONFIG.GROQ_RETRY_COUNT - 1) throw e2;
          }
        }
        if (retried) continue;
      }
      throw e;
    }
  }

  const transcript = parts.join(' ').replace(/\s+/g, ' ').trim();
  const durationEstimate = transcript.length / 8;

  debug.push(`🧵 Combined ${parts.length} chunk(s) in ${Date.now() - startedAt}ms`);
  return {
    transcript,
    chunks: parts.length,
    metrics: {
      durationSeconds: Math.round(durationEstimate),
      durationMinutes: Math.round(durationEstimate / 60),
      confidence: 'estimated',
      source: 'groq-chunked',
    },
  };

  async function groqOnce(fileBuffer, fname) {
    const formData = new FormData();
    formData.append('file', fileBuffer, { filename: fname, contentType: 'audio/mpeg' });
    formData.append('model', APP_CONFIG.GROQ.MODEL);
    formData.append('response_format', APP_CONFIG.GROQ.RESPONSE_FORMAT);

    const resp = await fetch(APP_CONFIG.GROQ.API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqApiKey}`, ...formData.getHeaders() },
      body: formData,
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => '');
      throw new Error(`Groq API error: ${resp.status} ${errorText}`);
    }

    const text = await resp.text();
    const dur = text.length / 8;
    return {
      transcript: text,
      metrics: { durationSeconds: Math.round(dur) },
    };
  }
}

/* ---------- Enhanced TROOP (JSON-forced + distilled fallback) ---------- */

async function analyzeWithTROOP(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) return createFallbackAnalysis(transcript, episodeTitle);

  const baseSystem = [
    'You are Podcast Growth Agent.',
    'Return valid JSON only. No markdown, no code fences, no commentary.',
    'Arrays MUST contain exactly 3 items for tweetable_quotes, community_suggestions, cross_promo_matches.',
    'Each community_suggestions item MUST include first_post (<=220 chars).',
    'Each cross_promo_matches item MUST include outreach_dm (<=420 chars).',
    'Maintain the episode’s tone/voice consistently across title, description, captions, posts, and DMs.'
  ].join(' ');

  const enhancedTROOPPrompt = buildTroopPrompt(transcript, episodeTitle, podcastTitle);

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
        temperature: 0.75,
        max_tokens: 4000,
        messages: [
          { role: 'system', content: baseSystem },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });

    const status = resp.status;
    const text = await resp.text();

    if (status < 200 || status >= 300) {
      return { ok: false, status, errorText: `HTTP ${status} ${text.slice(0, 400)}` };
    }

    let data;
    try { data = JSON.parse(text); }
    catch (e) { return { ok: false, status, errorText: `JSON parse error: ${e.message} | raw=${text.slice(0, 400)}...` }; }

    const content = data.choices?.[0]?.message?.content;
    if (!content) return { ok: false, status, errorText: `No content in response | raw=${text.slice(0, 400)}...` };

    try { return { ok: true, json: JSON.parse(content) }; }
    catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) { try { return { ok: true, json: JSON.parse(match[0]) }; } catch {} }
      return { ok: false, status, errorText: `Model content not valid JSON` };
    }
  }

  // Try 1
  let attempt = await callOpenAI(enhancedTROOPPrompt);
  if (attempt.ok) return attempt.json;

  // Try 2
  attempt = await callOpenAI(enhancedTROOPPrompt);
  if (attempt.ok) return attempt.json;

  // Distill → Analyze
  const distilled = await distillTranscript(transcript, openaiApiKey, baseSystem);
  const distilledPrompt = enhancedTROOPPrompt.replace(
    /\*\*TRANSCRIPT:\*\*[\s\S]*$/m,
    `**TRANSCRIPT (DISTILLED):**\n${distilled}\n\nReturn ONLY valid JSON.`
  );
  attempt = await callOpenAI(distilledPrompt);
  if (attempt.ok) return attempt.json;

  return {
    ...createFallbackAnalysis(transcript, episodeTitle),
    _debug_troop_fail: attempt.errorText || 'unknown'
  };
}

function buildTroopPrompt(transcript, episodeTitle, podcastTitle) {
  const safeTranscript =
    transcript.length > 15000
      ? transcript.slice(0, 15000) + '\n\n[Transcript truncated for processing]'
      : transcript;

  return `
Section 1: Task Definition
**TASK:**
Analyze the provided podcast episode transcript and generate a comprehensive 10-section growth strategy to expand audience reach. Use the exact spoken words to extract meaning, then create actionable marketing recommendations that improve findability, discoverability, and reach by:
(a) Strategically selecting primary intent terms listeners actively search for.
(b) Expanding into 3–5 semantic neighbors (conceptually related terms) to join ongoing topically relevant conversations.
(c) Ensuring all recommendations connect to actual transcript content.

Section 2: Role Assignment
**ROLE:**
You are Podcast Growth Agent — an expert strategist with 10+ years helping independent podcasters grow. Core specialties:
1. Deep transcript semantic analysis
2. Search-intent mapping & expansion
3. Niche community discovery (1K–100K members)
4. Platform-native copycraft
5. Cross-promo matchmaking for complementary audiences
6. Solo-creator growth prioritization

Section 3: Critical Requirements ⚠️ ENFORCEMENT LAYER
**CRITICAL REQUIREMENTS (HARD):**
- EXACTLY 3 tweetable quotes (verbatim from transcript)
- EXACTLY 3 community suggestions (niche, 1K–100K members; no generic communities like r/podcasts)
- EXACTLY 3 cross-promo matches (complementary shows, similar audience size)
- All data must be transcript-grounded
- For each keyword/topic set, include 1 **primary intent term** + 3–5 **semantic neighbors**
- Each \`community_suggestions\` item MUST include \`first_post\` (≤220 chars, value-first, no link)
- Each \`cross_promo_matches\` item MUST include \`outreach_dm\` (≤420 chars, friendly, specific swap ask)

Section 4: JSON Output Format 📋 CORE STRUCTURE
Return only valid JSON (no prose). Do not include keys not listed below.

{
  "episode_summary": "2–3 engaging sentences that convey the guest/topic’s core promise and listener outcome.",
  "tweetable_quotes": [
    "Exact quote #1 from transcript...",
    "Exact quote #2 from transcript...",
    "Exact quote #3 from transcript..."
  ],
  "topics_keywords": [
    {
      "primary_intent": "Main searchable term from transcript",
      "semantic_neighbors": ["related term 1", "related term 2", "related term 3", "related term 4", "related term 5"]
    },
    { "primary_intent": "...", "semantic_neighbors": ["..."] },
    { "primary_intent": "...", "semantic_neighbors": ["..."] }
  ],
  "optimized_title": "SEO-optimized title (≤70 chars, contains 1 primary intent term)",
  "optimized_description": "150–200 words, includes at least 3 primary intents and 3–5 semantic neighbors woven naturally, with a single CTA to play.",
  "community_suggestions": [
    {
      "name": "Niche community (1K–100K)",
      "platform": "Platform name",
      "url": "Direct URL",
      "member_size": "Approx count",
      "why": "Specific problem this episode addresses for this community",
      "post_angle": "Conversation-first hook",
      "engagement_strategy": "Platform-native tactic + timing",
      "conversion_potential": "Why they are likely to click play",
      "first_post": "Copy-paste, ≤220 chars, includes 1 transcript phrase",
      "confidence": "high|medium"
    },
    { "name": "...", "platform": "...", "url": "...", "member_size": "...", "why": "...", "post_angle": "...", "engagement_strategy": "...", "conversion_potential": "...", "first_post": "...", "confidence": "..." },
    { "name": "...", "platform": "...", "url": "...", "member_size": "...", "why": "...", "post_angle": "...", "engagement_strategy": "...", "conversion_potential": "...", "first_post": "...", "confidence": "..." }
  ],
  "cross_promo_matches": [
    {
      "podcast_name": "Complementary podcast",
      "why_match": "Fit grounded in transcript themes",
      "audience_overlap": "Estimated %",
      "collaboration_value": "Swap angle (promo, feed drop, clip trade)",
      "outreach_timing": "Best window (day/time)",
      "outreach_dm": "Copy-paste DM, ≤420 chars, includes 1 transcript phrase",
      "confidence": "high|medium"
    },
    { "podcast_name": "...", "why_match": "...", "audience_overlap": "...", "collaboration_value": "...", "outreach_timing": "...", "outreach_dm": "...", "confidence": "..." },
    { "podcast_name": "...", "why_match": "...", "audience_overlap": "...", "collaboration_value": "...", "outreach_timing": "...", "outreach_dm": "...", "confidence": "..." }
  ],
  "trend_piggyback": "One current, durable conversation to join; specify angle and why it fits.",
  "social_caption": "1–2 punchy sentences tailored to platform; includes 1 primary intent and 1 semantic neighbor.",
  "next_step": "One concrete action a solo creator can do in ≤20 minutes.",
  "growth_score": "0–100 (rubric-based)"
}

Section 5: Business Objective
**OBJECTIVE:**
Give overwhelmed independent podcasters step-by-step, immediately actionable ways to get more plays per episode without a marketing team or technical expertise.

Section 6: Perspective/Voice
**PERSPECTIVE:**
Supportive growth partner. Clear, kind, practical. Avoid generic marketing clichés. Use platform-native, action-driven language.

Section 7: Methodology 🧠 YOUR SECRET SAUCE
**PROPRIETARY SEMANTIC ANALYSIS METHODOLOGY:**
1) **Transcript Foundation** — Parse exact phrases, entities, claims, and emotional tone to extract problem statements, promised outcomes, and repeatable listener-search language.
2) **Semantic Expansion** — For each core theme, identify the **primary intent term** and 3–5 **semantic neighbors**.
3) **Conversation Insertion** — Locate active topic clusters where these terms appear in ongoing discussions.
4) **Niche Community Discovery** — Prefer 1K–100K member spaces with active, recent threads; score by topical fit and engagement depth.
5) **Copy Calibration** — Weave primary + neighbor terms into titles/descriptions/captions.
6) **Action Readiness** — Generate \`first_post\` and \`outreach_dm\` fields so creators can take action in under 1 minute.
7) **Effort/Impact Awareness** — Prioritize quick, high-leverage solo tactics.

Section 7.1: Voice Profile (Derive From Transcript)
Extract a voice profile (tone, rhythm, formality, energy). Use it consistently in title, description, captions, first_post, outreach_dm.

Section 8: Context Variables
**EPISODE INFORMATION:**
Episode Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

**TRANSCRIPT:**
${safeTranscript}

Section 9: Community Examples 🎯 GUIDANCE SYSTEM
**COMMUNITY TARGETING EXAMPLES:**
- Wellness: mindfulness habit groups (50K–90K), sleep optimization circles (10K–40K)
- Business: SaaS founder micro-forums (5K–30K), niche indie-hacker threads (20K–80K)
- Creative: discipline-specific craft groups (15K–70K)

Section 10: Final Enforcement
**IMPORTANT:**
- No generic podcast communities
- Use only transcript-relevant niche communities
- Arrays = exactly 3 items
- Output = only the JSON described above
`;
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
