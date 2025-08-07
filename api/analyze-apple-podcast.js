import { setCorsHeaders } from '../lib/cors.js';
import FormData from 'form-data';

const APP_CONFIG = {
  GROQ: {
    API_URL: 'https://api.groq.com/openai/v1/audio/transcriptions',
    MODEL: 'whisper-large-v3-turbo',
    RESPONSE_FORMAT: 'text',
  },
  OPENAI: {
    CHAT_URL: 'https://api.openai.com/v1/chat/completions',
    ANALYSIS_MODEL: 'gpt-4o-mini',
  }
};

export default async function handler(req, res) {
  setCorsHeaders(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startTime = Date.now();
  const debugLog = [];

  try {
    const { appleUrl, title } = req.body;
    if (!appleUrl) return res.status(400).json({ error: 'Apple Podcast URL is required' });

    debugLog.push(`🚀 Starting Apple Podcast analysis for: ${appleUrl}`);
    console.log('🚀 Starting Apple Podcast analysis for:', appleUrl);

    // STEP 1: Metadata
    debugLog.push('📞 Getting episode metadata...');
    console.log('📞 Getting episode metadata...');

    const metadataResponse = await fetch('https://podcast-api-amber.vercel.app/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: appleUrl, metadataOnly: true })
    });

    if (!metadataResponse.ok) {
      debugLog.push('⚠️ Metadata service unavailable, extracting basic info...');
      console.log('⚠️ Metadata service unavailable, extracting basic info...');
      const basicMetadata = extractBasicMetadataFromUrl(appleUrl);
      return await processWithBasicMetadata(basicMetadata, debugLog, startTime, res);
    }

    const responseText = await metadataResponse.text();
    debugLog.push(`📥 Got metadata response, length: ${responseText.length}`);
    console.log('📥 Got metadata response, length:', responseText.length);

    const lines = responseText.trim().split('\n').filter(Boolean);
    let episodeMetadata = null;

    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'success' || parsed.title) {
          episodeMetadata = parsed;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!episodeMetadata) {
      debugLog.push('⚠️ No metadata found, extracting from URL...');
      console.log('⚠️ No metadata found, extracting from URL...');
      const basicMetadata = extractBasicMetadataFromUrl(appleUrl);
      return await processWithBasicMetadata(basicMetadata, debugLog, startTime, res);
    }

    debugLog.push(`🎉 Metadata extracted: "${episodeMetadata.title}"`);
    console.log('🎉 Metadata extracted:', episodeMetadata.title);

    // STEP 2: Download MP3
    debugLog.push('📥 Downloading MP3 file through our infrastructure...');
    console.log('📥 Downloading MP3 file through our infrastructure...');

    let audioBuffer;
    let audioUrl = episodeMetadata.audio_url || episodeMetadata.audioUrl;

    if (!audioUrl) {
      const possibleAudioFields = ['audio_url', 'audioUrl', 'enclosure_url', 'mp3_url'];
      for (const field of possibleAudioFields) {
        if (episodeMetadata[field]) {
          audioUrl = episodeMetadata[field];
          break;
        }
      }
    }
    if (!audioUrl) throw new Error('No audio URL found in episode metadata');

    debugLog.push(`🎵 Audio URL found: ${String(audioUrl).substring(0, 100)}...`);
    console.log('🎵 Audio URL found:', String(audioUrl).substring(0, 100));

    try {
      const { default: fetch } = await import('node-fetch');
      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) throw new Error(`Failed to download audio: ${audioResponse.statusText}`);

      const audioArrayBuffer = await audioResponse.arrayBuffer();
      audioBuffer = Buffer.from(audioArrayBuffer);

      debugLog.push(`📁 Downloaded ${audioBuffer.length} bytes of audio`);
      console.log(`📁 Downloaded ${audioBuffer.length} bytes of audio`);
    } catch (downloadError) {
      debugLog.push(`❌ Audio download failed: ${downloadError.message}`);
      console.error('❌ Audio download failed:', downloadError);
      throw new Error(`Could not download audio file: ${downloadError.message}`);
    }

    // STEP 3: Transcribe
    debugLog.push('⚡ Starting transcription using our proven system...');
    console.log('⚡ Starting transcription using our proven system...');
    const transcriptionResult = await transcribeWithGroq(audioBuffer, episodeMetadata.title || 'Episode');
    debugLog.push(`✅ Transcription complete, length: ${transcriptionResult.transcript.length}`);
    console.log('✅ Transcription complete, length:', transcriptionResult.transcript.length);

    // STEP 4: Enhanced TROOP Analysis
    debugLog.push('🧠 Starting Enhanced TROOP analysis...');
    console.log('🧠 Starting Enhanced TROOP analysis...');

    const analysisRaw = await analyzeWithEnhancedTROOP(
      transcriptionResult.transcript,
      episodeMetadata.title || title || 'Episode Analysis',
      episodeMetadata.podcast_title || episodeMetadata.podcastTitle || 'Podcast Analysis'
    );

    const analysis = normalizeAnalysis(analysisRaw, debugLog);

    debugLog.push('✅ Enhanced TROOP analysis completed successfully');
    console.log('✅ Enhanced TROOP analysis completed successfully');

    // STEP 5: Return
    const processingTime = Date.now() - startTime;

    return res.status(200).json({
      success: true,
      source: 'Apple URL + Our MP3 Pipeline + Enhanced TROOP',
      metadata: {
        title: episodeMetadata.title || title || 'Episode Analysis',
        duration: episodeMetadata.duration || transcriptionResult.metrics.durationSeconds,
        podcastTitle: episodeMetadata.podcast_title || episodeMetadata.podcastTitle || 'Podcast',
        originalUrl: appleUrl,
        searchTerm: episodeMetadata.search_term,
        listenNotesId: episodeMetadata.listennotes_id,
        audioUrl: audioUrl,
        transcriptionSource: transcriptionResult.metrics.source,
        audio_metrics: transcriptionResult.metrics,
        processing_time_ms: processingTime,
        processed_at: new Date().toISOString(),
        api_version: '4.0-unified-pipeline'
      },
      transcript: transcriptionResult.transcript,
      description: episodeMetadata.description,
      keywords: episodeMetadata.keywords || [],
      analysis,
      debug: debugLog
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('💥 Apple Podcast analysis error:', error);
    debugLog.push(`💥 Final error: ${error.message}`);

    return res.status(500).json({
      error: 'Analysis failed',
      details: error.message,
      debug: debugLog,
      processing_time_ms: processingTime,
      step: 'Check debug array for detailed step-by-step information'
    });
  }
}

// ---------- Helpers ----------

function extractBasicMetadataFromUrl(appleUrl) {
  const urlParts = String(appleUrl).split('/');
  const titlePart = urlParts.find(part => part.includes('-') && !part.includes('id'));
  return {
    title: titlePart ? titlePart.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Episode Analysis',
    podcast_title: 'Podcast Analysis',
    description: 'Episode analysis from Apple Podcast URL',
    duration: 0
  };
}

async function processWithBasicMetadata(metadata, debugLog, startTime, res) {
  debugLog.push('🔄 Processing with basic metadata only...');
  console.log('🔄 Processing with basic metadata only...');

  const analysis = normalizeAnalysis(createFallbackAnalysis('Transcript not available - analysis based on metadata', metadata.title), debugLog);
  const processingTime = Date.now() - startTime;

  return res.status(200).json({
    success: true,
    source: 'Apple URL + Basic Metadata Analysis',
    metadata: {
      title: metadata.title,
      duration: metadata.duration,
      podcastTitle: metadata.podcast_title,
      processing_time_ms: processingTime,
      processed_at: new Date().toISOString(),
      api_version: '4.0-basic-fallback'
    },
    transcript: 'Transcript not available - analysis based on metadata',
    description: metadata.description,
    keywords: [],
    analysis,
    debug: debugLog
  });
}

// ---------- Transcription ----------

async function transcribeWithGroq(fileBuffer, filename) {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error('Groq API key not configured');

  try {
    const formData = new FormData();
    formData.append('file', fileBuffer, { filename: filename + '.mp3', contentType: 'audio/mpeg' });
    formData.append('model', APP_CONFIG.GROQ.MODEL);
    formData.append('response_format', APP_CONFIG.GROQ.RESPONSE_FORMAT);

    const { default: fetch } = await import('node-fetch');

    const response = await fetch(APP_CONFIG.GROQ.API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqApiKey}`, ...formData.getHeaders() },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
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
  } catch (error) {
    throw new Error(`Transcription failed: ${error.message}`);
  }
}

// ---------- Analysis (Enhanced) ----------

async function analyzeWithEnhancedTROOP(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    console.log('⚠️ OpenAI API key not configured, using fallback analysis');
    return createFallbackAnalysis(transcript, episodeTitle);
  }

  const safeTranscript = transcript.length > 15000
    ? transcript.substring(0, 15000) + '\n\n[Transcript truncated for processing - full analysis based on episode themes]'
    : transcript;

  // === Upgraded TROOP Prompt (creator-first, directory-aware, non-limiting, back-compat) ===
  const enhancedTROOPPrompt = `# TROOP: Podcast Growth Agent (v2.0)

## T – TASK
Analyze the podcast transcript and deliver a complete, 10-section Growth Plan that helps the **podcaster** reach more listeners for this specific episode.
- Use exact transcript text for deep semantic understanding (themes, tone, implicit meanings).
- Apply the **Multilayer Semantic Growth Engine**.
- Use the **Podcast Growth Community Directory** as a starting point only; always propose **additional, newly discovered** niche communities (1K–100K).
- All recommendations must be practical for a solo creator with limited time.

## R – ROLE
You are **Podcast Growth Agent** — a growth strategist with 10+ years serving independent podcasters. Blend:
- Deep transcript analysis (key quotes, tonal shifts, narrative arcs)
- Advanced SEO (long-tail, intent matching, trend piggyback)
- Community targeting (platform norms, timing, value-first engagement)
- Effort-to-impact prioritization for time-strapped creators

## O – OUTPUT (JSON ONLY)
Return **valid JSON only**. If a URL is uncertain, set **"url": null** and include **"discovery_query"**. Arrays must have **exactly 3 items**.

{
  "version": "troop-2.0",
  "episode_summary": "2-3 engaging sentences for potential listeners.",
  "tweetable_quotes": [
    "Memorable direct quote from transcript...",
    "Second high-impact quote...",
    "Third thought-provoking quote..."
  ],
  "topics_keywords": ["Primary long-tail keyword", "Secondary variation", "Semantic cluster 1", "Semantic cluster 2", "Question-based keyword"],
  "optimized_title": "SEO-optimized, curiosity-driven title (<=60 chars).",
  "optimized_description": "150-200 word SEO description weaving primary + related keywords, clear value and CTA.",
  "community_suggestions": [
    {
      "name": "Specific niche community (1K–100K)",
      "platform": "Reddit/Facebook/Discord/LinkedIn/Forum",
      "url": "Direct link or null if unsure",
      "discovery_query": "Query if url is null",
      "member_size": "Exact or best estimate within 1K–100K",
      "source": "PG Directory or Newly Discovered",
      "why": "Episode-to-community fit with pain points this solves",
      "post_angle": "Value-first conversation starter drawn from transcript",
      "engagement_strategy": "Timing + format per platform culture",
      "conversion_potential": "Why this is likely to create listeners"
    },
    {},
    {}
  ],
  "cross_promo_matches": [
    {
      "podcast_name": "Specific complementary podcast",
      "host_name": "Real host name",
      "contact_info": "Handle or email",
      "audience_overlap": "Estimated %",
      "collaboration_value": "Mutual benefit",
      "community_synergy": ["Relevant communities both touch"],
      "outreach_timing": "Best timing window"
    },
    {},
    {}
  ],
  "trend_piggyback": "Concise text summary of relevant trend + platform + why it aligns (string for backward compatibility).",
  "trend_piggyback_detail": {
    "trend": "Name of trend",
    "platform": "Best platform",
    "related_directory_communities": ["Optional list"],
    "reason": "Why it matches this episode"
  },
  "social_caption": "Platform-ready caption with authentic voice and CTA.",
  "next_step": "One specific action they can do today in 30–60 minutes.",
  "growth_score": "Score out of 100 with brief rationale.",
  "community_activation_plan": [
    { "week": 1, "action": "Observe & note top threads", "goal": "Collect 3 recurring pain points" },
    { "week": 2, "action": "Post value-first thread", "goal": "Earn replies without self-promo" },
    { "week": 3, "action": "Share episode clip addressing a pain point", "goal": "Convert interest to listens" }
  ]
}

## O – OBJECTIVE
Give the creator **clear, high-ROI steps** to find and connect with the right audiences now, without a team or ad spend.

## P – PERSPECTIVE
Supportive, pragmatic partner. Prefer long-tail and niche communities over broad, low-conversion spaces. Preserve authentic voice.

## Multilayer Semantic Growth Engine
1) Transcript Intelligence 2) Semantic Expansion 3) Market Signals 4) Audience & Community (Directory as foundation, plus discovery)
5) Competitive Differentiation 6) Amplification 7) Impact Prioritization

## Directory Guidance (Important)
- Use the directory as **inspiration**. If a listed example exceeds 100K members, suggest a **comparable 1K–100K** alternative.
- If a working URL is uncertain, set "url": null and add "discovery_query".
- Never suggest r/podcasts or generic mega-communities.

## EPISODE
Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

TRANSCRIPT:
${safeTranscript}
`;

  try {
    const { default: fetch } = await import('node-fetch');
    console.log('🚀 Starting Enhanced TROOP analysis with array enforcement...');
    console.log('📏 Enhanced prompt length:', enhancedTROOPPrompt.length);
    console.log('📄 Transcript length:', transcript.length);

    const response = await fetch(APP_CONFIG.OPENAI.CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: APP_CONFIG.OPENAI.ANALYSIS_MODEL,
        messages: [
          { role: 'system', content: 'You are Podcast Growth Agent. Return valid JSON only. Arrays must have exactly 3 items for tweetable_quotes, community_suggestions, and cross_promo_matches.' },
          { role: 'user', content: enhancedTROOPPrompt }
        ],
        temperature: 0.7,
        max_tokens: 4000
      })
    });

    console.log('📡 OpenAI Enhanced TROOP response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Enhanced TROOP API error:', errorText);
      console.log('🔄 Falling back to simplified TROOP...');
      return await trySimplifiedTROOP(transcript, episodeTitle, podcastTitle);
    }

    const result = await response.json();
    const analysisText = result.choices[0]?.message?.content;

    console.log('🔍 Enhanced TROOP raw response length:', analysisText ? analysisText.length : 'null');
    console.log('🔍 First 300 chars:', analysisText ? analysisText.substring(0, 300) : 'null');

    if (analysisText) {
      try {
        const cleanedText = analysisText.trim();
        const parsed = JSON.parse(cleanedText);
        console.log('✅ Enhanced TROOP JSON parsed successfully');
        return parsed;
      } catch (parseError) {
        console.log('❌ Enhanced TROOP JSON parse failed:', parseError.message);
        console.log('🔄 Attempting to extract JSON substring and reparse...');
        const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            console.log('✅ Enhanced TROOP JSON extracted and parsed successfully');
            return parsed;
          } catch (secondParseError) {
            console.log('❌ JSON extraction also failed:', secondParseError.message);
          }
        }
        console.log('🔄 Enhanced TROOP failed, trying simplified approach...');
        return await trySimplifiedTROOP(transcript, episodeTitle, podcastTitle);
      }
    }

    console.log('⚠️ No Enhanced TROOP content returned, trying simplified...');
    return await trySimplifiedTROOP(transcript, episodeTitle, podcastTitle);

  } catch (error) {
    console.error('🚨 Enhanced TROOP analysis error:', error);
    console.log('🔄 Falling back to simplified TROOP...');
    return await trySimplifiedTROOP(transcript, episodeTitle, podcastTitle);
  }
}

// ---------- Analysis (Simplified Fallback, same shape) ----------

async function trySimplifiedTROOP(transcript, episodeTitle, podcastTitle) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  console.log('🔄 Attempting simplified TROOP as fallback...');

  const safeTranscript = transcript.length > 10000 ? transcript.substring(0, 10000) : transcript;

  const simplifiedPrompt = `Return valid JSON only in the EXACT shape below (arrays exactly 3 items). If a URL is uncertain, set "url": null and include a "discovery_query". Preserve the creator's authentic voice.

{
  "version": "troop-2.0",
  "episode_summary": "Engaging 2-3 sentence summary",
  "tweetable_quotes": ["Quote 1", "Quote 2", "Quote 3"],
  "topics_keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "optimized_title": "SEO-optimized title (<=60 chars)",
  "optimized_description": "Compelling 150-200 word description",
  "community_suggestions": [
    {"name": "Community Name", "platform": "Platform", "url": null, "discovery_query": "search term", "member_size": "5K", "source": "Newly Discovered", "why": "Reason to post here", "post_angle": "Value-first angle", "engagement_strategy": "Timing/format", "conversion_potential": "Why likely to convert"},
    {"name": "Second Community", "platform": "Platform", "url": null, "discovery_query": "search term", "member_size": "8K", "source": "PG Directory", "why": "Second reason", "post_angle": "Angle 2", "engagement_strategy": "Approach 2", "conversion_potential": "Conversion why 2"},
    {"name": "Third Community", "platform": "Platform", "url": null, "discovery_query": "search term", "member_size": "12K", "source": "Newly Discovered", "why": "Third reason", "post_angle": "Angle 3", "engagement_strategy": "Approach 3", "conversion_potential": "Conversion why 3"}
  ],
  "cross_promo_matches": [
    {"podcast_name": "Podcast 1", "host_name": "Host 1", "contact_info": "@handle1", "audience_overlap": "60%", "collaboration_value": "Mutual benefit", "community_synergy": ["community A"], "outreach_timing": "Next 2 weeks"},
    {"podcast_name": "Podcast 2", "host_name": "Host 2", "contact_info": "@handle2", "audience_overlap": "55%", "collaboration_value": "Different angle", "community_synergy": ["community B"], "outreach_timing": "Before next season drop"},
    {"podcast_name": "Podcast 3", "host_name": "Host 3", "contact_info": "@handle3", "audience_overlap": "50%", "collaboration_value": "Complementary topic", "community_synergy": ["community C"], "outreach_timing": "After milestone episode"}
  ],
  "trend_piggyback": "Concise trend + platform + why (string).",
  "trend_piggyback_detail": { "trend": "Trend", "platform": "Platform", "related_directory_communities": [], "reason": "Why this fits" },
  "social_caption": "Caption with CTA",
  "next_step": "One clear action in 30-60 minutes",
  "growth_score": "75/100 - brief rationale",
  "community_activation_plan": [
    { "week": 1, "action": "Observe", "goal": "Identify pain points" },
    { "week": 2, "action": "Post value-first", "goal": "Earn replies" },
    { "week": 3, "action": "Share clip", "goal": "Convert listens" }
  ]
}

EPISODE
Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

TRANSCRIPT:
${safeTranscript}
`;

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
          { role: 'system', content: 'You are Podcast Growth Agent. Respond with valid JSON only. Arrays must have exactly 3 items for tweetable_quotes, community_suggestions, and cross_promo_matches.' },
          { role: 'user', content: simplifiedPrompt }
        ],
        temperature: 0.7,
        max_tokens: 3000
      })
    });

    if (!response.ok) {
      console.error('❌ Simplified TROOP also failed');
      return createFallbackAnalysis(transcript, episodeTitle);
    }

    const result = await response.json();
    const analysisText = result.choices[0]?.message?.content;

    if (analysisText) {
      try {
        const parsed = JSON.parse(analysisText.trim());
        console.log('✅ Simplified TROOP succeeded as fallback');
        return parsed;
      } catch {
        console.log('❌ Simplified TROOP JSON parse also failed');
        return createFallbackAnalysis(transcript, episodeTitle);
      }
    }
    return createFallbackAnalysis(transcript, episodeTitle);
  } catch (error) {
    console.error('🚨 Simplified TROOP fallback error:', error);
    return createFallbackAnalysis(transcript, episodeTitle);
  }
}

// ---------- Normalization Layer (contract enforcement) ----------

function normalizeAnalysis(input, debugLog = []) {
  const out = { ...(input || {}) };

  // Version
  out.version = out.version || 'troop-2.0';

  // Utility to coerce exactly 3
  const coerce3 = (arr, label) => {
    let a = Array.isArray(arr) ? arr.filter(v => v != null) : [];
    if (a.length > 3) {
      debugLog.push(`✂️ Trimming ${label} from ${a.length} to 3`);
      a = a.slice(0, 3);
    }
    while (a.length < 3) a.push(null);
    return a;
  };

  out.tweetable_quotes = coerce3(out.tweetable_quotes, 'tweetable_quotes');
  out.community_suggestions = coerce3(out.community_suggestions, 'community_suggestions');
  out.cross_promo_matches = coerce3(out.cross_promo_matches, 'cross_promo_matches');

  // Ensure community_activation_plan is an array
  if (!Array.isArray(out.community_activation_plan)) out.community_activation_plan = [];

  // Back-compat for trend_piggyback
  if (typeof out.trend_piggyback !== 'string' && out.trend_piggyback) {
    out.trend_piggyback_detail = out.trend_piggyback_detail || out.trend_piggyback;
    const tp = out.trend_piggyback_detail || {};
    out.trend_piggyback = `${tp.trend || 'Relevant trend'} on ${tp.platform || 'best platform'} — ${tp.reason || 'aligns with episode themes'}`;
  } else if (!out.trend_piggyback) {
    out.trend_piggyback = 'Relevant trend on best platform — aligns with episode themes';
  }
  if (!out.trend_piggyback_detail) out.trend_piggyback_detail = null;

  // URL sanity + discovery_query
  out.community_suggestions = out.community_suggestions.map((c, i) => {
    if (!c || typeof c !== 'object') return c;
    if (!c.url || !/^https?:\/\//i.test(c.url)) {
      c.discovery_query = c.discovery_query || `find: ${c.name || 'niche community'} ${c.platform || ''}`.trim();
      c.url = null;
    }
    return c;
  });

  return out;
}

// ---------- Final Fallback (same shape as enhanced) ----------

function createFallbackAnalysis(transcript, episodeTitle) {
  console.log('🔄 Using enhanced fallback analysis (stable shape)');
  return {
    version: 'troop-2.0',
    episode_summary: "Episode analyzed with fallback. Full enhanced analysis temporarily unavailable.",
    tweetable_quotes: [
      `🎙️ New episode: "${episodeTitle}" — key insights inside!`,
      "📈 Every episode is a shot at audience growth.",
      "🚀 Consistency compounds listener trust."
    ],
    topics_keywords: ["podcast growth", "audience", "SEO for podcasts", "community targeting", "content repurposing"],
    optimized_title: episodeTitle || "Optimize This Episode Title for SEO",
    optimized_description: "Use this episode’s strongest insight to craft a compelling description that drives discovery and click-through.",
    community_suggestions: [
      {
        name: "Value-First Creators",
        platform: "Reddit",
        url: null,
        discovery_query: "site:reddit.com value-first creators community 5k",
        member_size: "5K",
        source: "Newly Discovered",
        why: "Aligns with sharing practical takeaways before promotion.",
        post_angle: "Offer 3 takeaways from the episode and ask for others' tips.",
        engagement_strategy: "Post Tues 8–10am local for visibility.",
        conversion_potential: "High—members seek actionable tips."
      },
      {
        name: "Indie Podcasters Growth",
        platform: "Facebook",
        url: null,
        discovery_query: "facebook indie podcasters growth group 10k",
        member_size: "10K",
        source: "PG Directory",
        why: "Audience matches time-strapped solo hosts.",
        post_angle: "Share a short clip demonstrating a tactic.",
        engagement_strategy: "Include a question to invite comments.",
        conversion_potential: "Medium-high—peer community."
      },
      {
        name: "Creator Ops (Discord)",
        platform: "Discord",
        url: null,
        discovery_query: "discord directory creator ops growth server 3k",
        member_size: "3K",
        source: "Newly Discovered",
        why: "Real-time Q&A fits episode topic.",
        post_angle: "Host a 15-min live AMA on one tactic.",
        engagement_strategy: "Announce day before, follow up with notes.",
        conversion_potential: "Medium—live interactions convert warmly."
      }
    ],
    cross_promo_matches: [
      {
        podcast_name: "The Sustainable Creative",
        host_name: "Alex Rivera",
        contact_info: "@sustcreative",
        audience_overlap: "60%",
        collaboration_value: "Complementary tactics for creator growth.",
        community_synergy: ["Indie Podcasters Growth FB"],
        outreach_timing: "Within 2 weeks of their next episode drop"
      },
      {
        podcast_name: "Bootstrapped Audio",
        host_name: "Priya Shah",
        contact_info: "@bootstrappedaudio",
        audience_overlap: "55%",
        collaboration_value: "Share ops systems for solo creators.",
        community_synergy: ["Creator Ops (Discord)"],
        outreach_timing: "During their listener Q&A week"
      },
      {
        podcast_name: "Signal > Noise",
        host_name: "Jordan Lee",
        contact_info: "@signalpod",
        audience_overlap: "50%",
        collaboration_value: "Focus on high-ROI tactics only.",
        community_synergy: ["Value-First Creators Reddit"],
        outreach_timing: "After their milestone episode"
      }
    ],
    trend_piggyback: "Back-to-school productivity on LinkedIn — aligns with episode’s time-saving tactics.",
    trend_piggyback_detail: {
      trend: "Back-to-school productivity",
      platform: "LinkedIn",
      related_directory_communities: [],
      reason: "Audience searches for time-saving systems this month"
    },
    social_caption: `🎧 New: "${episodeTitle}" — 3 tactics you can ship today. Listen now + tell me which one you’ll try first.`,
    next_step: "Cut 1 x 30–45s clip and post with a value-first caption into one niche community today.",
    growth_score: "75/100 — Strong shareability; more niche communities could raise conversion.",
    community_activation_plan: [
      { week: 1, action: "Observe top threads", goal: "Identify 3 recurring pain points" },
      { week: 2, action: "Post value-first thread", goal: "Earn replies without promo" },
      { week: 3, action: "Share clip tied to pain point", goal: "Convert interest to listens" }
    ]
  };
}
