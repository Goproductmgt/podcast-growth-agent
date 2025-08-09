// api/analyze-apple-podcast.js
// Apple URL → get real MP3 (race: metadata service OR iTunes+RSS) → /tmp → Vercel Blob → Groq → TROOP

import { setCorsHeaders } from '../lib/cors.js';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const APP_CONFIG = {
  // We TRY metadata service for quick titles/descriptions, but we never block on it.
  METADATA_URL: 'https://podcast-api-amber.vercel.app/api/transcribe',
  ITUNES_LOOKUP_URL: 'https://itunes.apple.com/lookup',
  ITUNES_COUNTRY: process.env.ITUNES_COUNTRY || 'US',

  GROQ: {
    API_URL: 'https://api.groq.com/openai/v1/audio/transcriptions',
    MODEL: 'whisper-large-v3-turbo',
    RESPONSE_FORMAT: 'text',
  },
  OPENAI: {
    CHAT_URL: 'https://api.openai.com/v1/chat/completions',
    ANALYSIS_MODEL: 'gpt-4o-mini',
  },

  // We’ll upload to Vercel Blob with an access token (create in Vercel → Storage → Tokens)
  BLOB_TOKEN: process.env.BLOB_READ_WRITE_TOKEN, // required
  BLOB_BUCKET_PREFIX: 'apple-url/',

  HARD_SIZE_LIMIT_BYTES: 1024 * 1024 * 300, // 300 MB
  META_TIMEOUT_MS: 7000,
  FETCH_TIMEOUT_MS: 60000,
  OPENAI_TIMEOUT_MS: 90000,
  GROQ_TIMEOUT_MS: 180000,
  MAX_RETRIES: 2,
};

export default async function handler(req, res) {
  setCorsHeaders(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const started = Date.now();
  const debug = [];

  try {
    const { appleUrl, title } = await readJsonBody(req);
    if (!appleUrl) return res.status(400).json({ error: 'Apple Podcast URL is required' });
    debug.push(`🚀 Start Apple URL flow: ${appleUrl}`);

    // 1) Get real MP3 URL (race: metadata service vs iTunes+RSS)
    const { episodeTitle, podcastTitle, audioUrl, description, keywords, metaPath } =
      await getAudioUrlFast(appleUrl, title, debug);
    if (!audioUrl) throw new Error('Failed to resolve audio URL');
    debug.push(`🥇 Metadata winner: ${metaPath}`);
    debug.push(`🎵 MP3: ${String(audioUrl).slice(0, 140)}…`);

    // 2) Guard: absurdly large files
    const { contentLength } = await headInfo(audioUrl);
    if (contentLength && contentLength > APP_CONFIG.HARD_SIZE_LIMIT_BYTES) {
      return res.status(413).json({
        error: `Audio too large (${Math.round(contentLength / 1024 / 1024)}MB). Use the MP3 upload path.`,
        debug,
      });
    }

    // 3) Download MP3 → /tmp
    const tmpInfo = await downloadToTmpWithRetries(audioUrl, APP_CONFIG.MAX_RETRIES, APP_CONFIG.FETCH_TIMEOUT_MS);
    debug.push(`📁 Downloaded to /tmp: ~${Math.round(tmpInfo.sizeBytes / 1024 / 1024)}MB`);

    // 4) **Upload /tmp → Vercel Blob** (same as your working MP3 flow)
    const blobInfo = await uploadTmpToVercelBlob(tmpInfo.tmpPath, `${APP_CONFIG.BLOB_BUCKET_PREFIX}${Date.now()}.mp3`);
    debug.push(`🟧 Uploaded to Vercel Blob: ${blobInfo.url}`);

    // 5) Transcribe **from Blob URL** (same pattern as analyze-from-blob.js)
    const transcription = await transcribeFromBlobWithGroq(blobInfo.url, episodeTitle);
    debug.push(`✅ Transcribed (${transcription.transcript.length} chars)`);

    // 6) TROOP analysis (JSON-forced)
    const analysis = await analyzeWithTROOP(transcription.transcript, episodeTitle, podcastTitle);
    debug.push('✅ TROOP analysis ok');

    const processingTime = Date.now() - started;
    return res.status(200).json({
      success: true,
      source: 'Apple URL + Vercel Blob + Groq Whisper + TROOP',
      metadata: {
        title: episodeTitle,
        podcastTitle,
        description,
        keywords: keywords || [],
        originalUrl: appleUrl,
        audioUrl,
        blobUrl: blobInfo.url,
        transcriptionSource: transcription.metrics.source,
        duration: transcription.metrics.durationSeconds,
        processing_time_ms: processingTime,
        processed_at: new Date().toISOString(),
        api_version: '4.6-apple-url-blob',
      },
      transcript: transcription.transcript,
      analysis,
      debug,
    });
  } catch (err) {
    const processingTime = Date.now() - started;
    return res.status(500).json({
      error: 'Analysis failed',
      details: err.message,
      processing_time_ms: processingTime,
      debug,
    });
  }
}

/* ---------------- Apple → MP3 resolution (race) ---------------- */

async function getAudioUrlFast(appleUrl, title, debug) {
  const metaPromise = getFromMetadataService(appleUrl, title, debug);
  const rssPromise  = getFromItunesRss(appleUrl, title, debug);

  const winner = await Promise.race([
    metaPromise,
    rssPromise,
    (async () => { await wait(APP_CONFIG.META_TIMEOUT_MS); return rssPromise; })(),
  ]);

  if (winner?.audioUrl) return winner;

  const settled = await Promise.allSettled([metaPromise, rssPromise]);
  const ok = settled.find(s => s.status === 'fulfilled' && s.value?.audioUrl);
  if (ok) return ok.value;

  throw new Error('Could not resolve audio URL from metadata service or RSS');
}

async function getFromMetadataService(appleUrl, title, debug) {
  try {
    const r = await fetchWithTimeout(
      APP_CONFIG.METADATA_URL,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: appleUrl, metadataOnly: true }) },
      APP_CONFIG.META_TIMEOUT_MS
    );
    const text = await r.text();
    const lines = text.trim().split('\n').filter(Boolean);
    let meta = {};
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'success' || parsed.title) { meta = parsed; break; }
      } catch {}
    }
    const episodeTitle = meta.title || title || 'Episode';
    const podcastTitle = meta.podcast_title || meta.podcastTitle || 'Podcast';
    const audioUrl = pickAudioUrl(meta);
    if (!audioUrl) {
      debug.push('⚠️ Metadata service lacked audio URL');
      return { episodeTitle, podcastTitle, audioUrl: null, description: meta.description, keywords: meta.keywords, metaPath: 'metadata-service(no-audio)' };
    }
    return { episodeTitle, podcastTitle, audioUrl, description: meta.description, keywords: meta.keywords, metaPath: 'metadata-service' };
  } catch (e) {
    debug.push(`⚠️ Metadata service failed: ${e.message}`);
    return { episodeTitle: title || 'Episode', podcastTitle: 'Podcast', audioUrl: null, metaPath: 'metadata-service-failed' };
  }
}

async function getFromItunesRss(appleUrl, title, debug) {
  const { showId, episodeId } = extractIdsFromAppleUrl(appleUrl);
  if (!showId) throw new Error('Could not parse show id from Apple URL');

  const feedUrl = await lookupFeedUrl(showId, debug);
  if (!feedUrl) throw new Error('Could not resolve RSS feed URL via iTunes lookup');

  const rss = await fetchWithTimeout(feedUrl, { method: 'GET' }, 15000);
  const rssXml = await rss.text();

  const match = findEpisodeInRss(rssXml, { episodeId, expectedTitle: title });
  if (!match || !match.enclosureUrl) throw new Error('Could not locate episode enclosure in RSS');

  return {
    episodeTitle: match.title || title || 'Episode',
    podcastTitle: match.podcastTitle || 'Podcast',
    audioUrl: match.enclosureUrl,
    description: null,
    keywords: [],
    metaPath: 'itunes+rss',
  };
}

/* ---------------- Download → /tmp → Blob ---------------- */

async function downloadToTmpWithRetries(audioUrl, maxRetries, timeoutMs) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try { return await downloadAudioToTmp(audioUrl, timeoutMs); }
    catch (e) { lastErr = e; if (attempt <= maxRetries) await wait(600 * attempt); }
  }
  throw lastErr;
}

async function downloadAudioToTmp(audioUrl, timeoutMs) {
  const res = await fetchWithTimeout(audioUrl, { method: 'GET' }, timeoutMs);
  if (!res.ok || !res.body) throw new Error(`Download failed ${res.status} ${res.statusText}`);
  const tmpPath = path.join('/tmp', `episode-${Date.now()}.mp3`);
  await pipeline(res.body, fs.createWriteStream(tmpPath));
  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) { try { fs.unlinkSync(tmpPath); } catch {}; throw new Error('Downloaded audio empty/truncated'); }
  return { tmpPath, sizeBytes: stat.size };
}

async function uploadTmpToVercelBlob(tmpPath, blobKey) {
  if (!APP_CONFIG.BLOB_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN not set');

  // Use Blob REST API (no SDK dependency). We’ll PUT the bytes to the signed URL.
  const { default: fetch } = await import('node-fetch');

  // 1) Create upload URL
  const createRes = await fetch('https://api.vercel.com/v2/blobs', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${APP_CONFIG.BLOB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      pathname: blobKey,
      addRandomSuffix: false,
      mimeType: 'audio/mpeg',
      access: 'public',
    }),
  });
  if (!createRes.ok) throw new Error(`Blob create failed: ${createRes.status} ${await createRes.text()}`);
  const createJson = await createRes.json();
  const { uploadUrl, url } = createJson;

  // 2) Upload file bytes via PUT (stream)
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/mpeg' },
    body: fs.createReadStream(tmpPath),
  });
  if (!putRes.ok) throw new Error(`Blob upload failed: ${putRes.status} ${await putRes.text()}`);

  try { fs.unlinkSync(tmpPath); } catch {}
  return { url };
}

/* ---------------- Transcribe (from Blob URL) ---------------- */

async function transcribeFromBlobWithGroq(blobUrl, filenameBase = 'Episode') {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error('GROQ_API_KEY not set');

  // Download blob bytes to buffer (same approach as your analyze-from-blob.js)
  const fileResponse = await fetchWithTimeout(blobUrl, { method: 'GET' }, APP_CONFIG.GROQ_TIMEOUT_MS);
  if (!fileResponse.ok) throw new Error(`Blob fetch failed: ${fileResponse.status} ${fileResponse.statusText}`);
  const fileArrayBuffer = await fileResponse.arrayBuffer();
  const fileBuffer = Buffer.from(fileArrayBuffer);

  const formData = new FormData();
  formData.append('file', fileBuffer, { filename: `${filenameBase}.mp3`, contentType: 'audio/mpeg' });
  formData.append('model', APP_CONFIG.GROQ.MODEL);
  formData.append('response_format', APP_CONFIG.GROQ.RESPONSE_FORMAT);

  const r = await fetchWithTimeout(
    APP_CONFIG.GROQ.API_URL,
    { method: 'POST', headers: { Authorization: `Bearer ${groqApiKey}`, ...formData.getHeaders() }, body: formData },
    APP_CONFIG.GROQ_TIMEOUT_MS
  );
  if (!r.ok) { const t = await r.text().catch(()=>''); throw new Error(`Groq ${r.status} ${t}`); }
  const transcript = await r.text();
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

/* ---------------- TROOP analysis (JSON-forced; your prompt) ---------------- */

async function analyzeWithTROOP(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) return createFallbackAnalysis(transcript, episodeTitle);

  const baseSystem = [
    'You are Podcast Growth Agent.',
    'Respond with valid JSON only. No markdown, no code fences, no commentary.',
    'Do NOT provide medical advice; focus on marketing/SEO/community.',
    'Arrays MUST contain exactly 3 items for tweetable_quotes, community_suggestions, cross_promo_matches.'
  ].join(' ');

  const prompt = buildTroopPrompt(transcript, episodeTitle, podcastTitle);

  const r = await fetchWithTimeout(
    APP_CONFIG.OPENAI.CHAT_URL,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
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
    },
    APP_CONFIG.OPENAI_TIMEOUT_MS
  );

  const status = r.status;
  const raw = await r.text();

  if (status < 200 || status >= 300) return createFallbackAnalysis(transcript, episodeTitle);

  try {
    const data = JSON.parse(raw);
    const content = data.choices?.[0]?.message?.content;
    if (!content) return createFallbackAnalysis(transcript, episodeTitle);
    try { return JSON.parse(content); }
    catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      return createFallbackAnalysis(transcript, episodeTitle);
    }
  } catch {
    return createFallbackAnalysis(transcript, episodeTitle);
  }
}

function buildTroopPrompt(transcript, episodeTitle, podcastTitle) {
  return `**TASK:**
Analyze the provided podcast episode transcript and generate a comprehensive 10-section growth strategy that helps podcasters expand their audience reach. Extract semantic meaning from the actual transcript content and create actionable marketing recommendations.

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
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

**TRANSCRIPT:**
${transcript.length > 15000 ? transcript.slice(0, 15000) + '\n[Truncated]' : transcript}

Respond ONLY with valid JSON.`;
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
    optimized_description: "Craft a value-forward description with primary and related keywords.",
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

/* ---------------- tiny utils ---------------- */

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(raw);
}
function pickAudioUrl(meta) { return meta.audio_url || meta.audioUrl || meta.enclosure_url || meta.mp3_url || null; }
function extractIdsFromAppleUrl(u) {
  const showId = (u.match(/\/id(\d+)/) || [])[1] || null;
  const episodeId = (u.match(/[?&]i=(\d+)/) || [])[1] || null;
  return { showId, episodeId };
}
async function lookupFeedUrl(showId, debug) {
  const url = `${APP_CONFIG.ITUNES_LOOKUP_URL}?id=${encodeURIComponent(showId)}&country=${encodeURIComponent(APP_CONFIG.ITUNES_COUNTRY)}`;
  const r = await fetchWithTimeout(url, { method: 'GET' }, 15000);
  const data = await r.json().catch(() => ({}));
  const feedUrl = data?.results?.[0]?.feedUrl || null;
  if (!feedUrl) debug.push('⚠️ iTunes lookup missing feedUrl');
  return feedUrl;
}
function findEpisodeInRss(rssXml, { episodeId, expectedTitle }) {
  if (episodeId) {
    const byGuid = new RegExp(`<guid[^>]*>\\s*${episodeId}\\s*<\\/guid>`, 'i');
    const byItunesGuid = new RegExp(`<itunes:episodeGuid[^>]*>\\s*${episodeId}\\s*<\\/itunes:episodeGuid>`, 'i');
    const byLink = new RegExp(`<link[^>]*>[^<]*\\?i=${episodeId}[^<]*<\\/link>`, 'i');
    for (const re of [byGuid, byItunesGuid, byLink]) {
      const idx = rssXml.search(re);
      if (idx !== -1) {
        const block = sliceItemBlock(rssXml, idx);
        const enclosureUrl = extractEnclosure(block);
        const title = extractTag(block, 'title');
        const podcastTitle = extractTag(rssXml, 'title');
        if (enclosureUrl) return { enclosureUrl, title, podcastTitle };
      }
    }
  }
  if (expectedTitle) {
    const titleNorm = expectedTitle.toLowerCase().replace(/\s+/g, ' ').slice(0, 70);
    const itemRe = /<item[\s\S]*?<\/item>/gi;
    let m;
    while ((m = itemRe.exec(rssXml))) {
      const block = m[0];
      const t = (extractTag(block, 'title') || '').toLowerCase().replace(/\s+/g, ' ');
      if (t && (t.includes(titleNorm) || titleNorm.includes(t))) {
        const enclosureUrl = extractEnclosure(block);
        if (enclosureUrl) return { enclosureUrl, title: extractTag(block, 'title'), podcastTitle: extractTag(rssXml, 'title') };
      }
    }
  }
  const firstItem = /<item[\s\S]*?<\/item>/i.exec(rssXml)?.[0] || '';
  const enclosureUrl = extractEnclosure(firstItem);
  if (enclosureUrl) return { enclosureUrl, title: extractTag(firstItem, 'title'), podcastTitle: extractTag(rssXml, 'title') };
  return null;
}
function sliceItemBlock(xml, indexNear) {
  const before = xml.lastIndexOf('<item', indexNear);
  const after = xml.indexOf('</item>', indexNear);
  if (before === -1 || after === -1) return '';
  return xml.slice(before, after + '</item>'.length);
}
function extractEnclosure(itemXml) { const m = itemXml.match(/<enclosure[^>]*url="([^"]+)"/i); return m ? m[1] : null; }
function extractTag(xml, tag) { const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')); return m ? decodeHtml(m[1]).trim() : null; }
function decodeHtml(s) { return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"'); }
async function headInfo(url) {
  try { const r = await fetchWithTimeout(url, { method: 'HEAD' }, 15000); if (!r.ok) return { contentLength: 0, contentType: '' };
    return { contentLength: Number(r.headers.get('content-length') || 0), contentType: r.headers.get('content-type') || '' };
  } catch { return { contentLength: 0, contentType: '' }; }
}
async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  const { default: fetch } = await import('node-fetch');
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }
