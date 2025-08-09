// api/analyze-apple-podcast.js
// Apple Podcasts URL → metadata → stream MP3 → Vercel Blob (public) → Groq Whisper
// If file too large (or Groq returns 413) → fallback to podcast-api-amber with the Blob URL
// Includes hardened TROOP JSON parsing.

import { setCorsHeaders } from '../lib/cors.js';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { put } from '@vercel/blob';

const APP_CONFIG = {
  METADATA_URL: 'https://podcast-api-amber.vercel.app/api/transcribe', // supports metadataOnly + full transcription
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
  GROQ_SOFT_LIMIT_BYTES: 24 * 1024 * 1024,  // ~24MB → use helper for larger files
  BLOB_ACCESS: 'public',
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

    // 1) Metadata
    const meta = await getEpisodeMetadata(appleUrl, debug);
    const episodeTitle = meta.title || title || 'Episode';
    const podcastTitle = meta.podcast_title || meta.podcastTitle || 'Podcast';
    const audioUrl = pickAudioUrl(meta);
    if (!audioUrl) return res.status(400).json({ error: 'No audio URL found in episode metadata.', debug });
    debug.push(`🎵 MP3 source: ${String(audioUrl).slice(0, 140)}…`);

    // 2) HEAD size gate
    const { contentLength } = await headInfo(audioUrl);
    if (contentLength && contentLength > APP_CONFIG.HARD_SIZE_LIMIT_BYTES) {
      return res.status(413).json({ error: `Audio too large (${Math.round(contentLength/1024/1024)}MB)`, debug });
    }

    // 3) Download → /tmp
    debug.push('📥 Downloading to /tmp…');
    const tmpInfo = await downloadAudioToTmp(audioUrl);
    debug.push(`📁 /tmp size ≈ ${Math.round(tmpInfo.sizeBytes/1024/1024)}MB`);

    // 4) Upload /tmp → Blob (public) (we’ll use this for the 413 fallback path)
    debug.push('🫧 Uploading to Vercel Blob…');
    const blobUrl = await uploadTmpToBlob(tmpInfo.tmpPath, `${safeSlug(episodeTitle)}.mp3`);
    debug.push(`🫧 Blob URL: ${blobUrl}`);

    // 5) Transcribe (Groq if small; else helper)
    let transcription;
    const shouldUseHelper = tmpInfo.sizeBytes > APP_CONFIG.GROQ_SOFT_LIMIT_BYTES;

    if (shouldUseHelper) {
      debug.push('📏 Large file → using helper service for transcription');
      transcription = await transcribeViaHelper(blobUrl, episodeTitle, debug);
    } else {
      try {
        debug.push('⚡ Transcribing with Groq (direct upload)…');
        transcription = await transcribeWithGroqFromTmp(tmpInfo.tmpPath, episodeTitle);
      } catch (e) {
        const msg = String(e?.message || e);
        if (/413/.test(msg) || /too large/i.test(msg)) {
          debug.push(`🛟 Groq 413 → fallback to helper with Blob URL`);
          transcription = await transcribeViaHelper(blobUrl, episodeTitle, debug);
        } else {
          throw e;
        }
      }
    }

    debug.push(`✅ Transcript chars: ${transcription.transcript.length}`);

    // 6) Enhanced TROOP (hardened JSON)
    debug.push('🧠 Running Enhanced TROOP…');
    const analysis = await analyzeWithEnhancedTROOP(
      transcription.transcript,
      episodeTitle,
      podcastTitle,
      debug
    );
    debug.push('✅ TROOP complete');

    return res.status(200).json({
      success: true,
      source: shouldUseHelper ? 'Apple URL → Blob → Helper → TROOP' : 'Apple URL → Blob → Groq → TROOP',
      metadata: {
        title: episodeTitle,
        podcastTitle,
        originalUrl: appleUrl,
        audioUrl,
        blobUrl,
        duration: meta.duration || transcription.metrics.durationSeconds,
        transcriptionSource: transcription.metrics.source,
        audio_metrics: transcription.metrics,
        processing_time_ms: Date.now() - started,
        processed_at: new Date().toISOString(),
        api_version: '4.4-apple-blob-groq-or-helper',
      },
      transcript: transcription.transcript,
      description: meta.description,
      keywords: meta.keywords || [],
      analysis,
      debug,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Analysis failed',
      details: String(err?.message || err),
      processing_time_ms: Date.now() - started,
    });
  }
}

/* ---------------------------
   Helpers: request + metadata
----------------------------*/
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(raw);
}
async function getEpisodeMetadata(appleUrl, debug) {
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(APP_CONFIG.METADATA_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: appleUrl, metadataOnly: true }),
  });
  if (!r.ok) { debug.push('⚠️ Metadata helper unavailable; fallback to URL parse'); return extractBasicMetadataFromUrl(appleUrl); }
  const text = await r.text();
  const lines = text.trim().split('\n').filter(Boolean);
  for (const line of lines.reverse()) {
    try { const j = JSON.parse(line); if (j.status === 'success' || j.title) return j; } catch {}
  }
  return extractBasicMetadataFromUrl(appleUrl);
}
function pickAudioUrl(meta) {
  return meta.audio_url || meta.audioUrl || meta.enclosure_url || meta.mp3_url || null;
}
function extractBasicMetadataFromUrl(appleUrl) {
  const parts = appleUrl.split('/');
  const titlePart = parts.find((p) => p.includes('-') && !p.includes('id'));
  const title = titlePart ? titlePart.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Episode';
  return { title, podcast_title: 'Podcast', description: 'Episode analysis', duration: 0 };
}
async function headInfo(url) {
  const { default: fetch } = await import('node-fetch');
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!r.ok) return { contentLength: 0, contentType: '' };
    return { contentLength: Number(r.headers.get('content-length') || 0), contentType: r.headers.get('content-type') || '' };
  } catch { return { contentLength: 0, contentType: '' }; }
}

/* ---------------------------
   Download → /tmp
----------------------------*/
async function downloadAudioToTmp(audioUrl) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(audioUrl, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Failed to download audio: ${res.status} ${res.statusText}`);
  const tmpPath = path.join('/tmp', `episode-${Date.now()}.mp3`);
  await pipeline(res.body, fs.createWriteStream(tmpPath));
  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) { try { fs.unlinkSync(tmpPath); } catch {} throw new Error('Downloaded audio appears empty'); }
  return { tmpPath, sizeBytes: stat.size };
}

/* ---------------------------
   Blob upload
----------------------------*/
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
  return String(s || 'episode').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/* ---------------------------
   Transcription: Groq
----------------------------*/
async function transcribeWithGroqFromTmp(tmpPath, filenameBase = 'Episode') {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error('Groq API key not configured');

  const { default: fetch } = await import('node-fetch');
  const formData = new FormData();
  formData.append('file', fs.createReadStream(tmpPath), { filename: `${filenameBase}.mp3`, contentType: 'audio/mpeg' });
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

/* ---------------------------
   Transcription: Helper fallback (Blob URL)
----------------------------*/
async function transcribeViaHelper(blobUrl, episodeTitle, debug) {
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(APP_CONFIG.METADATA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Tell helper to transcribe from blob URL (NOT metadataOnly)
    body: JSON.stringify({ url: blobUrl, metadataOnly: false }),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Helper transcription failed: ${r.status} ${text.slice(0, 300)}`);

  // helper returns NDJSON; find last valid JSON with transcript
  const lines = text.trim().split('\n').filter(Boolean);
  let payload = {};
  for (const line of lines.reverse()) {
    try { payload = JSON.parse(line); if (payload.transcript) break; } catch {}
  }
  if (!payload.transcript) throw new Error(`Helper transcription missing transcript: ${text.slice(0, 300)}`);

  const transcript = payload.transcript;
  const durationEstimate = transcript.length / 8;
  debug.push('✅ Helper transcription complete');

  return {
    transcript,
    metrics: {
      durationSeconds: Math.round(durationEstimate),
      durationMinutes: Math.round(durationEstimate / 60),
      confidence: 'estimated',
      source: 'helper',
    },
  };
}

/* ---------------------------
   TROOP (hardened JSON)
----------------------------*/
function stripCodeFences(s){if(!s)return s;return s.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```$/i,'').trim();}
function extractJsonObject(text){
  if(!text) throw new Error('Empty model response');
  try { return JSON.parse(text); } catch {}
  const unfenced = stripCodeFences(text);
  try { return JSON.parse(unfenced); } catch {}
  let start=-1, depth=0;
  for(let i=0;i<unfenced.length;i++){
    const ch=unfenced[i];
    if(ch==='{'){ if(depth===0) start=i; depth++; }
    else if(ch==='}'){ depth--; if(depth===0 && start!==-1){ const c=unfenced.slice(start,i+1); try{ return JSON.parse(c);}catch{}}}
  }
  throw new Error('Could not extract valid JSON from model output');
}
async function analyzeWithEnhancedTROOP(transcript, episodeTitle='', podcastTitle='', debugArr=[]){
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) return createFallbackAnalysis(transcript, episodeTitle);
  const baseSystem = [
    'You are Podcast Growth Agent.',
    'Respond with valid JSON only. No markdown, no code fences, no commentary.',
    'Do NOT provide medical advice; focus on marketing, SEO, audience targeting, and community strategy.',
    'Arrays MUST contain exactly 3 items for tweetable_quotes, community_suggestions, and cross_promo_matches.'
  ].join(' ');
  const prompt = `**TASK:** Analyze transcript and output the STRICT JSON schema discussed. **EPISODE:** ${episodeTitle}\n**PODCAST:** ${podcastTitle}\n**TRANSCRIPT:**\n${transcript.length>15000?transcript.slice(0,15000)+'\n\n[Transcript truncated]':transcript}\nRespond ONLY with valid JSON.`;

  async function call(modelPrompt, attempt=1){
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
      method:'POST',
      headers:{ Authorization:`Bearer ${openaiApiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({
        model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
        response_format:{type:'json_object'},
        temperature: attempt===1?0.6:0.4,
        max_tokens: 4000,
        messages:[{role:'system',content:baseSystem},{role:'user',content:modelPrompt}],
      }),
    });
    const status = resp.status; const raw = await resp.text();
    if(status<200||status>=300) return {ok:false,status,errorText:raw};
    try{
      const env = JSON.parse(raw);
      const content = env?.choices?.[0]?.message?.content;
      if(!content) throw new Error('No content');
      return {ok:true,json:extractJsonObject(content)};
    }catch{
      try{ return {ok:true,json:extractJsonObject(raw)}; }catch(e){ return {ok:false,status,errorText:`JSON parse fail: ${e.message}`}; }
    }
  }

  let a = await call(prompt,1); if(a.ok) return a.json;
  a = await call(prompt,2); if(a.ok) return a.json;

  // distilled fallback
  const distilled = transcript.slice(0,8000);
  a = await call(`Distill the following first, then produce the same JSON:\n${distilled}`,2);
  if(a.ok) return a.json;

  return {...createFallbackAnalysis(transcript,episodeTitle), _debug_troop_fail:{error:a.errorText||'Unknown'}};
}
function createFallbackAnalysis(transcript, episodeTitle){
  return {
    episode_summary:"Episode successfully transcribed. Enhanced AI analysis temporarily unavailable - using fallback.",
    tweetable_quotes:[
      `🎙️ New episode: "${episodeTitle}" - packed with insights for growth!`,
      "📈 Every episode is an opportunity to connect with your audience.",
      "🚀 Consistent content creation is the key to podcast growth.",
    ],
    topics_keywords:["podcast","content","growth","strategy","audience"],
    optimized_title: episodeTitle || "Optimize This Episode Title for SEO",
    optimized_description:"Use the episode content to craft an engaging description that drives discovery and engagement.",
    community_suggestions:[
      {name:"Mindfulness Community",platform:"Reddit",url:"https://reddit.com/r/mindfulness",why:"Share mindful practices and wellness insights"},
      {name:"Self Care Support",platform:"Facebook",url:"https://facebook.com/groups/selfcaresupport",why:"Connect with people focused on personal wellness"},
      {name:"Wellness Warriors",platform:"Discord",url:"https://discord.com/invite/wellness",why:"Real-time wellness discussions"},
    ],
    cross_promo_matches:[
      {podcast_name:"The Wellness Hour",host_name:"Sarah Johnson",contact_info:"@sarahwellness",collaboration_angle:"Practical wellness overlap"},
      {podcast_name:"Mindful Living Daily",host_name:"Mike Chen",contact_info:"mike@mindfulpodcast.com",collaboration_angle:"Mindfulness-focused audience"},
      {podcast_name:"Health & Home",host_name:"Lisa Rodriguez",contact_info:"@healthandhomepod",collaboration_angle:"Healthy living spaces"},
    ],
    trend_piggyback:"Connect to current wellness and mental health awareness trends (#MindfulMonday #SelfCareSunday).",
    social_caption:`🎙️ New episode live: "${episodeTitle}" — dive into insights that matter. #podcast #wellness #mindfulness`,
    next_step:"Create 3 post variants with quotes + hashtags; share in one targeted community today.",
    growth_score:"75/100 - Transcribed successfully; advanced analysis fell back.",
  };
}
