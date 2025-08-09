// api/analyze-apple-podcast.js
// Apple URL -> metadata -> resolve MP3 -> upload to Vercel Blob -> call our working /api/analyze-from-blob
// Returns the SAME shape as /api/analyze-from-blob (analysis, transcript, metadata, etc.)

import { setCorsHeaders } from '../lib/cors.js';
import { put } from '@vercel/blob';
import path from 'path';

const APP_CONFIG = {
  METADATA_URL: 'https://podcast-api-amber.vercel.app/api/transcribe', // metadataOnly=true
  SELF_BASE_URL: process.env.SELF_BASE_URL || 'https://podcast-growth-agent.vercel.app',
  MAX_BLOB_SIZE: 100 * 1024 * 1024, // 100MB (matches your get-upload-url)
};

export default async function handler(req, res) {
  setCorsHeaders(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const start = Date.now();
  const debug = [];

  try {
    const { appleUrl, title } = await readJsonBody(req);
    if (!appleUrl) return res.status(400).json({ error: 'Apple Podcast URL is required' });

    debug.push(`🚀 Start Apple URL flow: ${appleUrl}`);

    // 1) Metadata only (fast)
    const meta = await getEpisodeMetadata(appleUrl, debug);
    const episodeTitle = meta.title || title || 'Episode';
    const podcastTitle = meta.podcast_title || meta.podcastTitle || 'Podcast';

    const audioUrl = pickAudioUrl(meta);
    if (!audioUrl) {
      return res.status(400).json({ error: 'No audio URL found in episode metadata', debug });
    }
    debug.push(`🎵 MP3: ${String(audioUrl).slice(0, 140)}…`);

    // 2) Stream MP3 -> Blob (public)
    const { blobUrl, sizeBytes, contentType } = await uploadToBlob(audioUrl, episodeTitle, debug);

    // 3) Call our working /api/analyze-from-blob path (server-to-server)
    const result = await callAnalyzeFromBlob({
      blobUrl,
      filename: safeSlug(`${episodeTitle}.mp3`),
      title: episodeTitle,
      debug,
    });

    // 4) Stitch in/override some metadata so the UI still shows Apple info
    const processingTime = Date.now() - start;
    const response = {
      ...result,
      metadata: {
        ...(result.metadata || {}),
        source: 'Apple URL → Blob → analyze-from-blob (Groq + TROOP)',
        podcastTitle,
        originalUrl: appleUrl,
        audioUrl,          // original mp3 source
        blob_url: blobUrl, // what we actually transcribed
        processed_at: new Date().toISOString(),
        processing_time_ms: processingTime,
        api_version: '4.3-apple-blob-proxy',
      },
      debug,
    };

    return res.status(200).json(response);

  } catch (err) {
    return res.status(500).json({
      error: 'Analysis failed',
      details: err.message,
      processing_time_ms: Date.now() - start,
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
      if (parsed.status === 'success' || parsed.title) {
        const which = parsed.which || parsed.source || 'itunes+rss';
        debug.push(`🥇 Metadata winner: ${which}`);
        return parsed;
      }
    } catch { /* ignore */ }
  }
  return extractBasicMetadataFromUrl(appleUrl);
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

function safeSlug(name = 'episode') {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function uploadToBlob(audioUrl, episodeTitle, debug) {
  const { default: fetch } = await import('node-fetch');

  // Follow redirects (many Apple feeds redirect through CDNs)
  const head = await fetch(audioUrl, { method: 'HEAD', redirect: 'follow' }).catch(() => null);

  const len = Number(head?.headers?.get('content-length') || 0);
  const type = head?.headers?.get('content-type') || 'audio/mpeg';

  if (len && len > APP_CONFIG.MAX_BLOB_SIZE) {
    // Still uploadable to Blob if your account allows >100MB, but your presigned
    // MP3 path caps at 100MB. Keep the same cap here to match that behavior.
    throw new Error(`Remote audio is too large for Blob cap (${Math.round(len / 1024 / 1024)}MB > ${Math.round(APP_CONFIG.MAX_BLOB_SIZE/1024/1024)}MB)`);
  }

  const get = await fetch(audioUrl, { method: 'GET', redirect: 'follow' });
  if (!get.ok || !get.body) {
    throw new Error(`Failed to GET audio (${get.status})`);
  }

  const base = safeSlug(episodeTitle || 'episode');
  const filename = `${base}-${Date.now()}.mp3`;

  // Stream response → Blob (no buffering in memory)
  const { url: blobUrl } = await put(filename, get.body, {
    access: 'public',
    contentType: type || 'audio/mpeg',
    token: process.env.BLOB_READ_WRITE_TOKEN, // already working in your MP3 path
    addRandomSuffix: true,
  });

  debug.push(`📦 Uploaded to Blob: ${blobUrl}`);
  return { blobUrl, sizeBytes: len || 0, contentType: type };
}

async function callAnalyzeFromBlob({ blobUrl, filename, title, debug }) {
  const { default: fetch } = await import('node-fetch');
  const endpoint = `${APP_CONFIG.SELF_BASE_URL}/api/analyze-from-blob`;

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // This is exactly the shape your working MP3 route expects
    body: JSON.stringify({ blobUrl, filename, title }),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    debug.push(`❌ analyze-from-blob failed: ${r.status} ${txt.slice(0, 300)}…`);
    throw new Error(`analyze-from-blob failed: ${r.status} ${txt}`);
  }

  const json = await r.json();
  debug.push('✅ analyze-from-blob completed successfully');
  return json;
}

// Vercel config: generous runtime; small request body; no large uploads here
export const config = {
  api: {
    bodyParser: true,
    sizeLimit: '1mb',
    externalResolver: true,
  },
  maxDuration: 300,
};
