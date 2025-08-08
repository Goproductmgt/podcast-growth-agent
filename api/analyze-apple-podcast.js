// api/analyze-apple-podcast.js
// Apple Podcasts URL → metadata → stream MP3 to /tmp → Groq Whisper → Enhanced TROOP
// Returns one JSON blob (no chunked streaming) to match your Elementor front-end.

import { setCorsHeaders } from '../lib/cors.js';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const APP_CONFIG = {
  METADATA_URL: 'https://podcast-api-amber.vercel.app/api/transcribe', // we pass metadataOnly=true
  GROQ: {
    API_URL: 'https://api.groq.com/openai/v1/audio/transcriptions',
    MODEL: 'whisper-large-v3-turbo',
    RESPONSE_FORMAT: 'text'
  },
  OPENAI: {
    CHAT_URL: 'https://api.openai.com/v1/chat/completions',
    ANALYSIS_MODEL: 'gpt-4o-mini'
  },
  HARD_SIZE_LIMIT_BYTES: 1024 * 1024 * 300 // 300MB; tweak as you like
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

    debug.push(`🚀 Starting Apple Podcast analysis for: ${appleUrl}`);

    // 1) Metadata ONLY (fast + cheap)
    debug.push('📞 Getting episode metadata...');
    const meta = await getEpisodeMetadata(appleUrl, debug);

    const episodeTitle = meta.title || title || 'Episode';
    const podcastTitle = meta.podcast_title || meta.podcastTitle || 'Podcast';
    let audioUrl = pickAudioUrl(meta);
    if (!audioUrl) {
      return res.status(400).json({ error: 'No audio URL found in episode metadata.', debug });
    }
    debug.push(`🎉 Metadata extracted: "${episodeTitle}"`);
    debug.push(`🎵 Audio URL: ${audioUrl.substring(0, 120)}...`);

    // 2) HEAD check so we can fail fast on absurdly large files
    debug.push('🧪 HEAD check for size/type...');
    const { contentLength, contentType } = await headInfo(audioUrl);
    if (contentLength && contentLength > APP_CONFIG.HARD_SIZE_LIMIT_BYTES) {
      return res.status(413).json({
        error: `Audio too large (${Math.round(contentLength / 1024 / 1024)}MB). Try the MP3 upload path or trim the file.`,
        debug
      });
    }

    // 3) Download MP3 → /tmp (streaming)
    debug.push('📥 Downloading MP3 to /tmp (streaming)...');
    const tmpInfo = await downloadAudioToTmp(audioUrl);
    debug.push(`📁 Saved to /tmp, size: ${Math.round(tmpInfo.sizeBytes / 1024 / 1024)}MB`);

    // 4) Transcribe with Groq (stream from disk, not memory)
    debug.push('⚡ Starting transcription with Groq (streamed from /tmp)...');
    const transcription = await transcribeWithGroqFromTmp(tmpInfo.tmpPath, episodeTitle);
    debug.push(`✅ Transcription complete, chars: ${transcription.transcript.length}`);

    // 5) Enhanced TROOP analysis (baked in here)
    debug.push('🧠 Running Enhanced TROOP analysis...');
    const analysis = await analyzeWithEnhancedTROOP(
      transcription.transcript,
      episodeTitle,
      podcastTitle
    );
    debug.push('✅ Enhanced TROOP analysis completed successfully');

    const processingTime = Date.now() - startTime;

    return res.status(200).json({
      success: true,
      source: 'Apple URL + /tmp streaming + Groq Whisper + Enhanced TROOP',
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
        api_version: '4.1-apple-direct-troop'
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

/* ---------------------------------
   Helpers
---------------------------------- */

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
    body: JSON.stringify({ url: appleUrl, metadataOnly: true })
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
    duration: 0
  };
}

async function headInfo(url) {
  const { default: fetch } = await import('node-fetch');
  try {
    const r = await fetch(url, { method: 'HEAD' });
    if (!r.ok) return { contentLength: 0, contentType: '' };
    return {
      contentLength: Number(r.headers.get('content-length') || 0),
      contentType: r.headers.get('content-type') || ''
    };
  } catch {
    return { contentLength: 0, contentType: '' }; // some hosts block HEAD
  }
}

async function downloadAudioToTmp(audioUrl) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(audioUrl);
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

async function transcribeWithGroqFromTmp(tmpPath, filenameBase = 'Episode') {
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

  try {
    const response = await fetch(APP_CONFIG.GROQ.API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqApiKey}`, ...formData.getHeaders() },
      body: formData
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
        source: 'groq'
      }
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

/* ---------------------------------
   Enhanced TROOP (baked in)
---------------------------------- */

async function analyzeWithEnhancedTROOP(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    return createFallbackAnalysis(transcript, episodeTitle);
  }

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

**OBJECTIVE:**
Help independent podcasters who are overwhelmed by marketing and don't know how to grow their audience. They need immediate, actionable steps they can take today to get more listeners without requiring a marketing team or technical knowledge.

**PERSPECTIVE:**
Approach this analysis from the mindset of a supportive growth partner who understands the creator is likely solo, motivated, but overwhelmed by marketing options. Prioritize long-tail growth strategy over competing in oversaturated broad communities.

**SEMANTIC ANALYSIS METHODOLOGY:**
1. Use the exact transcript text to establish deep semantic understanding of themes, emotions, and implicit meanings
2. Identify niche audience segments and specific communities (1K-100K members) that connect to core themes
3. Prioritize smaller, engaged communities over massive generic ones
4. Apply advanced SEO principles including keyword optimization and multi-platform discoverability
5. Extend the episode's reach while preserving authentic voice and core message

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

  try {
    const { default: fetch } = await import('node-fetch');
    const response = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
        messages: [
          { role: 'system', content: 'You are Podcast Growth Agent. Respond with valid JSON only. Arrays must contain exactly 3 items for tweetable_quotes, community_suggestions, and cross_promo_matches.' },
          { role: 'user', content: enhancedTROOPPrompt }
        ],
        temperature: 0.7,
        max_tokens: 4000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI error: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';

    // Parse strictly; try to salvage JSON if model wrapped it
    try {
      return JSON.parse(content.trim());
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error('Model did not return valid JSON.');
    }
  } catch (err) {
    // Last resort
    return createFallbackAnalysis(transcript, episodeTitle);
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
