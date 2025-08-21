// api/analyze-apple-podcast.js
// Apple URL → /tmp download → Vercel Blob → GROQ URL (100MB limit) → Enhanced TROOP
// FIXED: Now tries Groq URL parameter first (Developer Plan supports 100MB via URL)
// Fallback to chunking only if URL method fails

import { setCorsHeaders } from '../lib/cors.js';
import { put } from '@vercel/blob';
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
  MAX_CHUNK_BYTES: Number(process.env.MAX_CHUNK_MB || 18) * 1024 * 1024,
  MIN_CHUNK_BYTES: 8 * 1024 * 1024,
  GROQ_RETRY_COUNT: 4,
  GROQ_RETRY_BASE_DELAY_MS: 700,
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

    debug.push('⚡ Transcribing with Groq (URL-first, then chunked fallback)…');
    const transcription = await transcribeWithGroqFromBlobChunked(blob.url, blobFilename, debug);
    debug.push(`✅ Transcribed (${transcription.transcript.length} chars) via ${transcription.chunks} chunk(s) using ${transcription.metrics.source}`);

    debug.push('🧠 Running Enhanced TROOP analysis…');
    let analysis = await analyzeWithTROOP(transcription.transcript, episodeTitle, podcastTitle);

    // If model returned keyword objects, keep them and also flatten for compatibility.
    if (Array.isArray(analysis?.topics_keywords) && typeof analysis.topics_keywords[0] === 'object') {
      const plan = analysis.topics_keywords;
      analysis.keyword_plan = plan;
      const flat = [];
      for (const k of plan) {
        if (k?.primary_intent) flat.push(String(k.primary_intent));
        if (Array.isArray(k?.semantic_neighbors)) for (const n of k.semantic_neighbors) flat.push(String(n));
      }
      analysis.topics_keywords = Array.from(new Set(flat)).slice(0, 15);
    }

    // If model added quotes_candidates_debug, ensure tweetable_quotes are top 3 w/ hashtags,
    // otherwise keep what it produced.
    if ((!analysis.tweetable_quotes || analysis.tweetable_quotes.length !== 3) &&
        Array.isArray(analysis.quotes_candidates_debug)) {
      const sorted = [...analysis.quotes_candidates_debug]
        .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
        .slice(0, 3)
        .map(q => typeof q?.text === 'string' ? q.text : '');
      analysis.tweetable_quotes = sorted.filter(Boolean);
    }

    debug.push('✅ TROOP analysis complete');

    const processingTime = Date.now() - startTime;
    return res.status(200).json({
      success: true,
      source: 'Apple URL → /tmp → Blob → Groq (URL-first) → Enhanced TROOP',
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
        api_version: '5.5-apple-url-groq-url-fix',
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
      debug,
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
  return { title, podcast_title: 'Podcast', description: 'Episode analysis from Apple Podcast URL', duration: 0 };
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

/* ---------- GROQ TRANSCRIPTION WITH URL-FIRST APPROACH ---------- */

async function transcribeWithGroqFromBlobChunked(blobUrl, filename, debug = []) {
  const { default: fetch } = await import('node-fetch');
  const groqApiKey = process.env.GROQ_API_KEY;

  // FIRST: Try URL-based transcription (Developer Plan supports up to 100MB via URL)
  debug.push('🎯 Trying Groq URL-based transcription first (up to 100MB)...');
  
  try {
    const response = await fetch(APP_CONFIG.GROQ.API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: APP_CONFIG.GROQ.MODEL,
        url: blobUrl,  // Use the blob URL directly
        response_format: APP_CONFIG.GROQ.RESPONSE_FORMAT,
      }),
    });

    if (response.ok) {
      const transcript = await response.text();
      const durationEstimate = transcript.length / 8;
      
      debug.push('✅ Groq URL transcription successful!');
      return {
        transcript,
        chunks: 1,
        metrics: {
          durationSeconds: Math.round(durationEstimate),
          durationMinutes: Math.round(durationEstimate / 60),
          confidence: 'estimated',
          source: 'groq-url',
        },
      };
    } else {
      const errorText = await response.text();
      debug.push(`⚠️ Groq URL failed: ${response.status} ${errorText}`);
      
      // If it's a file size error, fall back to chunking
      if (response.status === 413 || (errorText.includes('file') && errorText.includes('large'))) {
        debug.push('🔄 File too large for URL method, falling back to chunking...');
      } else {
        // For other errors, still try chunking as fallback
        debug.push('🔄 URL method failed, trying chunking fallback...');
      }
    }
  } catch (urlError) {
    debug.push(`⚠️ Groq URL error: ${urlError.message}`);
    debug.push('🔄 Falling back to chunking method...');
  }

  // FALLBACK: Use chunking logic (existing code)
  debug.push('📦 Starting chunked transcription...');
  
  // Get blob size for chunking
  const head = await fetch(blobUrl, { method: 'HEAD' });
  if (!head.ok) throw new Error(`Blob HEAD failed: ${head.status} ${head.statusText}`);
  
  const totalBytes = Number(head.headers.get('content-length') || 0);
  if (!totalBytes) {
    // If no content-length, download entire file and use direct upload
    debug.push('📥 No content-length header, downloading entire file...');
    const fileRes = await fetch(blobUrl);
    if (!fileRes.ok) throw new Error(`Blob download failed: ${fileRes.status} ${fileRes.statusText}`);
    const arr = await fileRes.arrayBuffer();
    return await groqDirectUpload(Buffer.from(arr), filename, debug);
  }

  // Chunking logic
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
      const tr = await groqDirectUpload(buf, `${filename}.part${part}.mp3`, debug);
      parts.push(tr.transcript);
      debug.push(`🧩 Groq OK for chunk ${part} (${buf.length} bytes)`);
      offset = end + 1;
      part += 1;
    } catch (e) {
      const msg = String(e.message || e);

      // Handle 413 errors by reducing chunk size
      if (/413/.test(msg) && chunkSize > APP_CONFIG.MIN_CHUNK_BYTES) {
        chunkSize = Math.max(APP_CONFIG.MIN_CHUNK_BYTES, Math.floor(chunkSize / 2));
        debug.push(`↘️ 413 from Groq, reducing chunk size to ~${Math.round(chunkSize / 1024 / 1024)}MB and retrying`);
        continue;
      }

      // Handle 5xx errors with retries
      if (/(500|502|503|504)/.test(msg)) {
        let recovered = false;
        for (let i = 0; i < APP_CONFIG.GROQ_RETRY_COUNT; i++) {
          const delay = APP_CONFIG.GROQ_RETRY_BASE_DELAY_MS * Math.pow(1.6, i) + Math.floor(Math.random() * 200);
          await new Promise(r => setTimeout(r, delay));
          try {
            const tr2 = await groqDirectUpload(buf, `${filename}.part${part}.mp3`, debug);
            parts.push(tr2.transcript);
            debug.push(`🔁 Groq ${/5\d\d/.exec(msg)?.[0] || '5xx'} recovered on retry ${i + 1} for chunk ${part}`);
            offset = end + 1;
            part += 1;
            recovered = true;
            break;
          } catch (e2) {
            if (i === APP_CONFIG.GROQ_RETRY_COUNT - 1) {
              if (chunkSize > APP_CONFIG.MIN_CHUNK_BYTES) {
                chunkSize = Math.max(APP_CONFIG.MIN_CHUNK_BYTES, Math.floor(chunkSize / 2));
                debug.push(`🪓 Persistent 5xx. Halving chunk to ~${Math.round(chunkSize / 1024 / 1024)}MB and retrying`);
                recovered = true;
              } else {
                throw e2;
              }
            }
          }
        }
        if (recovered) continue;
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
}

// Helper function for direct file upload (same as your working MP3 path)
async function groqDirectUpload(fileBuffer, filename, debug = []) {
  const { default: fetch } = await import('node-fetch');
  const groqApiKey = process.env.GROQ_API_KEY;
  
  const formData = new FormData();
  formData.append('file', fileBuffer, { filename, contentType: 'audio/mpeg' });
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
  return { transcript: text, metrics: { durationSeconds: Math.round(dur) } };
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
    'Maintain the episode's tone/voice across title, description, captions, first_post, outreach_dm.'
  ].join(' ');

  const enhancedTROOPPrompt = buildTroopPrompt(transcript, episodeTitle, podcastTitle);

  async function callOpenAI(prompt) {
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
        response_format: { type: 'json_object' },
        temperature: 0.75,
        max_tokens: 4000,
        messages: [{ role: 'system', content: baseSystem }, { role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(90_000),
    });

    const status = resp.status;
    const text = await resp.text();
    if (status < 200 || status >= 300) return { ok: false, status, errorText: `HTTP ${status} ${text.slice(0, 400)}` };

    let data; try { data = JSON.parse(text); } catch (e) {
      return { ok: false, status, errorText: `JSON parse error: ${e.message} | raw=${text.slice(0, 300)}...` };
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { ok: false, status, errorText: 'No content in response' };

    try { return { ok: true, json: JSON.parse(content) }; }
    catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) { try { return { ok: true, json: JSON.parse(match[0]) }; } catch {} }
      return { ok: false, status, errorText: 'Model content not valid JSON' };
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

  return { ...createFallbackAnalysis(transcript, episodeTitle), _debug_troop_fail: attempt.errorText || 'unknown' };
}

function buildTroopPrompt(transcript, episodeTitle, podcastTitle) {
  const safeTranscript =
    transcript.length > 15000 ? transcript.slice(0, 15000) + '\n\n[Transcript truncated for processing]' : transcript;

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
- EXACTLY 3 tweetable quotes (verbatim or lightly edited for clarity) with 1–2 relevant hashtags
- EXACTLY 3 community suggestions (niche, 1K–100K; no generic communities)
- EXACTLY 3 cross-promo matches (complementary shows, similar audience size)
- All data must be transcript-grounded
- For each keyword/topic set, include 1 primary intent term + 3–5 semantic neighbors
- Each community_suggestions item MUST include first_post (≤220 chars, value-first, no link)
- Each cross_promo_matches item MUST include outreach_dm (≤420 chars, friendly, specific swap ask)

Section 3.1: Quote Extraction & Scoring (INTERNAL)
Before producing final tweetable_quotes:
- Extract 8–12 candidate quotes from transcript (<=240 chars each).
- For each, compute scores: insight(0–5), emotion(0–5), clarity(0–5), novelty(0–5), virality(0–5).
- Add 1–2 smart hashtags from the keyword plan (primary intent + semantic neighbors).
- Select top 3 (highest total) respecting 280-char limit. Use those as tweetable_quotes.
- Also include quotes_candidates_debug (array of objects: {text, hashtags, scores:{...}, score}) for QA.

Section 4: JSON Output Format 📋 CORE STRUCTURE
Return only valid JSON (no prose). Do not include keys not listed below.

{
  "episode_summary": "2–3 sentences in the guest/show's voice describing core promise and listener outcome.",
  "tweetable_quotes": ["Quote 1 with 1–2 hashtags", "Quote 2 with hashtags", "Quote 3 with hashtags"],
  "topics_keywords": [
    { "primary_intent": "Main searchable term", "semantic_neighbors": ["rel1","rel2","rel3","rel4","rel5"] },
    { "primary_intent": "...", "semantic_neighbors": ["..."] },
    { "primary_intent": "...", "semantic_neighbors": ["..."] }
  ],
  "optimized_title": "≤70 chars; must contain one primary intent term; keep episode voice.",
  "optimized_description": "150–200 words; weave ≥3 primary intents + 3–5 neighbors; single CTA.",
  "community_suggestions": [
    {"name":"...","platform":"...","url":"...","member_size":"...","why":"...","post_angle":"...","engagement_strategy":"...","conversion_potential":"...","first_post":"<=220 chars, includes 1 transcript phrase","confidence":"high|medium"},
    {"name":"...","platform":"...","url":"...","member_size":"...","why":"...","post_angle":"...","engagement_strategy":"...","conversion_potential":"...","first_post":"...","confidence":"..."},
    {"name":"...","platform":"...","url":"...","member_size":"...","why":"...","post_angle":"...","engagement_strategy":"...","conversion_potential":"...","first_post":"...","confidence":"..."}
  ],
  "cross_promo_matches": [
    {"podcast_name":"...","why_match":"...","audience_overlap":"...","collaboration_value":"...","outreach_timing":"...","outreach_dm":"<=420 chars, includes 1 transcript phrase","confidence":"high|medium"},
    {"podcast_name":"...","why_match":"...","audience_overlap":"...","collaboration_value":"...","outreach_timing":"...","outreach_dm":"...","confidence":"..."},
    {"podcast_name":"...","why_match":"...","audience_overlap":"...","collaboration_value":"...","outreach_timing":"...","outreach_dm":"...","confidence":"..."}
  ],
  "trend_piggyback": "One durable conversation; specify angle + why it fits.",
  "social_caption": "1–2 platform-native sentences; include 1 primary intent + 1 neighbor.",
  "next_step": "One concrete action a solo creator can do in ≤20 minutes.",
  "growth_score": "0–100 (rubric-based)",
  "quotes_candidates_debug": [{"text":"...","hashtags":["#x","#y"],"scores":{"insight":5,"emotion":4,"clarity":5,"novelty":4,"virality":5},"score":23}]
}

Section 5: Business Objective
**OBJECTIVE:** Help solo podcasters get more plays per episode with immediately actionable steps.

Section 6: Perspective/Voice
**PERSPECTIVE:** Supportive, clear, practical; match the episode's tone/voice.

Section 7: Methodology 🧠
1) Transcript Foundation → 2) Semantic Expansion → 3) Conversation Insertion → 4) Niche Discovery
→ 5) Copy Calibration → 6) Action Readiness → 7) Effort/Impact Awareness

Section 7.1: Voice Profile (Derive From Transcript)
Use this voice consistently in title, description, captions, first_post, outreach_dm.

Section 8: Context
Episode Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

TRANSCRIPT:
${safeTranscript}

Section 9: Community Examples
- Wellness: mindfulness habit groups, sleep optimization circles
- Business: SaaS founder micro-forums, indie-hacker threads
- Creative: discipline-specific craft groups

Section 10: Final Enforcement
- No generic podcast communities
- Arrays = exactly 3 items
- Output = exactly the JSON structure above
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
      `🎙️ New episode: "${episodeTitle}" — big insights inside! #podcast`,
      "📈 Every episode is a chance to earn a new listener. #podcastgrowth",
      "🚀 Consistency compounds your podcast growth. #creatoreconomy"
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