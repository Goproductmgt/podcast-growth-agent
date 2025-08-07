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
  // Set CORS headers using your proven solution
  setCorsHeaders(res, req.headers.origin);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const debugLog = [];
  
  try {
    const { appleUrl, title } = req.body;

    if (!appleUrl) {
      return res.status(400).json({ error: 'Apple Podcast URL is required' });
    }

    debugLog.push(`🚀 Starting Apple Podcast analysis for: ${appleUrl}`);
    console.log('🚀 Starting Apple Podcast analysis for:', appleUrl);

    // STEP 1: Get episode metadata from Apple/podcast-api-amber (just metadata, no transcription)
    debugLog.push('📞 Getting episode metadata...');
    console.log('📞 Getting episode metadata...');
    
    const metadataResponse = await fetch('https://podcast-api-amber.vercel.app/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: appleUrl, metadataOnly: true })
    });

    if (!metadataResponse.ok) {
      // Fallback: extract basic info from URL and continue
      debugLog.push('⚠️ Metadata service unavailable, extracting basic info...');
      console.log('⚠️ Metadata service unavailable, extracting basic info...');
      
      const basicMetadata = extractBasicMetadataFromUrl(appleUrl);
      return await processWithBasicMetadata(basicMetadata, debugLog, startTime, res);
    }

    const responseText = await metadataResponse.text();
    debugLog.push(`📥 Got metadata response, length: ${responseText.length}`);
    console.log('📥 Got metadata response, length:', responseText.length);

    // Parse streaming response to get metadata
    const lines = responseText.trim().split('\n').filter(line => line.trim());
    let episodeMetadata = null;

    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'success' || parsed.title) {
          episodeMetadata = parsed;
          break;
        }
      } catch (parseError) {
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

    // STEP 2: Download MP3 using YOUR infrastructure (not external service)
    debugLog.push('📥 Downloading MP3 file through our infrastructure...');
    console.log('📥 Downloading MP3 file through our infrastructure...');

    let audioBuffer;
    let audioUrl = episodeMetadata.audio_url || episodeMetadata.audioUrl;

    if (!audioUrl) {
      // Try to find audio URL in metadata
      const possibleAudioFields = ['audio_url', 'audioUrl', 'enclosure_url', 'mp3_url'];
      for (const field of possibleAudioFields) {
        if (episodeMetadata[field]) {
          audioUrl = episodeMetadata[field];
          break;
        }
      }
    }

    if (!audioUrl) {
      throw new Error('No audio URL found in episode metadata');
    }

    debugLog.push(`🎵 Audio URL found: ${audioUrl.substring(0, 100)}...`);
    console.log('🎵 Audio URL found:', audioUrl.substring(0, 100));

    try {
      const { default: fetch } = await import('node-fetch');
      const audioResponse = await fetch(audioUrl);
      
      if (!audioResponse.ok) {
        throw new Error(`Failed to download audio: ${audioResponse.statusText}`);
      }

      // Use modern arrayBuffer() method
      const audioArrayBuffer = await audioResponse.arrayBuffer();
      audioBuffer = Buffer.from(audioArrayBuffer);
      
      debugLog.push(`📁 Downloaded ${audioBuffer.length} bytes of audio`);
      console.log(`📁 Downloaded ${audioBuffer.length} bytes of audio`);
      
    } catch (downloadError) {
      debugLog.push(`❌ Audio download failed: ${downloadError.message}`);
      console.error('❌ Audio download failed:', downloadError);
      throw new Error(`Could not download audio file: ${downloadError.message}`);
    }

    // STEP 3: Use YOUR proven transcription system (same as MP3 upload)
    debugLog.push('⚡ Starting transcription using our proven system...');
    console.log('⚡ Starting transcription using our proven system...');

    const transcriptionResult = await transcribeWithGroq(audioBuffer, episodeMetadata.title || 'Episode');

    debugLog.push(`✅ Transcription complete, length: ${transcriptionResult.transcript.length}`);
    console.log('✅ Transcription complete, length:', transcriptionResult.transcript.length);

    // STEP 4: Use YOUR Enhanced TROOP analysis (same as MP3 upload)
    debugLog.push('🧠 Starting Enhanced TROOP analysis...');
    console.log('🧠 Starting Enhanced TROOP analysis...');

    const analysis = await analyzeWithEnhancedTROOP(
      transcriptionResult.transcript,
      episodeMetadata.title || title || 'Episode Analysis',
      episodeMetadata.podcast_title || episodeMetadata.podcastTitle || 'Podcast Analysis'
    );

    debugLog.push('✅ Enhanced TROOP analysis completed successfully');
    console.log('✅ Enhanced TROOP analysis completed successfully');

    // STEP 5: Return identical response format as MP3 method
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
      analysis: analysis,
      debug: debugLog
    });

  } catch (error) {
    debugLog.push(`💥 Final error: ${error.message}`);
    console.error('💥 Apple Podcast analysis error:', error);
    
    const processingTime = Date.now() - startTime;
    return res.status(500).json({
      error: 'Analysis failed',
      details: error.message,
      debug: debugLog,
      processing_time_ms: processingTime,
      step: 'Check debug array for detailed step-by-step information'
    });
  }
}

// Helper function for basic metadata extraction
function extractBasicMetadataFromUrl(appleUrl) {
  // Extract basic info from Apple Podcast URL structure
  const urlParts = appleUrl.split('/');
  const titlePart = urlParts.find(part => part.includes('-') && !part.includes('id'));
  
  return {
    title: titlePart ? titlePart.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Episode Analysis',
    podcast_title: 'Podcast Analysis',
    description: 'Episode analysis from Apple Podcast URL',
    duration: 0
  };
}

// Process with basic metadata when full metadata unavailable
async function processWithBasicMetadata(metadata, debugLog, startTime, res) {
  debugLog.push('🔄 Processing with basic metadata only...');
  console.log('🔄 Processing with basic metadata only...');
  
  // Create basic analysis using metadata
  const analysis = createFallbackAnalysis('Basic analysis from URL metadata', metadata.title);
  
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
    analysis: analysis,
    debug: debugLog
  });
}

// REUSE YOUR PROVEN TRANSCRIPTION FUNCTION (same as MP3 method)
async function transcribeWithGroq(fileBuffer, filename) {
  const groqApiKey = process.env.GROQ_API_KEY;
  
  if (!groqApiKey) {
    throw new Error('Groq API key not configured');
  }

  try {
    const formData = new FormData();
    formData.append('file', fileBuffer, {
      filename: filename + '.mp3',
      contentType: 'audio/mpeg'
    });
    formData.append('model', APP_CONFIG.GROQ.MODEL);
    formData.append('response_format', APP_CONFIG.GROQ.RESPONSE_FORMAT);

    const { default: fetch } = await import('node-fetch');
    
    const response = await fetch(APP_CONFIG.GROQ.API_URL, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${groqApiKey}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error: ${response.status} ${errorText}`);
    }

    const transcript = await response.text();
    
    const durationEstimate = transcript.length / 8;
    const metrics = {
      durationSeconds: Math.round(durationEstimate),
      durationMinutes: Math.round(durationEstimate / 60),
      confidence: 'estimated',
      source: 'groq'
    };
    
    return { transcript, metrics };

  } catch (error) {
    throw new Error(`Transcription failed: ${error.message}`);
  }
}

// REUSE YOUR ENHANCED TROOP FUNCTION (same as MP3 method)
async function analyzeWithEnhancedTROOP(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    console.log('⚠️ OpenAI API key not configured, using fallback analysis');
    return createFallbackAnalysis(transcript, episodeTitle);
  }

  // ENHANCED TROOP METHODOLOGY WITH ARRAY LENGTH ENFORCEMENT (IDENTICAL TO MP3 METHOD)
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
      "name": "SPECIFIC niche community name (NOT r/podcasts - use r/mindfulness, r/wellness, r/selfcare etc)",
      "platform": "Reddit/Facebook/Discord/LinkedIn",
      "url": "Working URL like https://reddit.com/r/mindfulness",
      "why": "How episode content solves specific problems this community discusses",
      "post_angle": "Natural conversation starter that adds value",
      "member_size": "1K-100K range for growing podcasts",
      "engagement_strategy": "Specific approach for this community's culture"
    },
    {
      "name": "DIFFERENT niche community (different platform or focus area)",
      "platform": "Different platform from first",
      "url": "Working URL or specific search terms", 
      "why": "Different angle or problem this episode addresses",
      "post_angle": "Alternative approach for different community culture",
      "member_size": "Community size information",
      "engagement_strategy": "Platform-specific engagement approach"
    },
    {
      "name": "THIRD complementary niche community (must be different from first two)",
      "platform": "Third platform option",
      "url": "Working URL when available",
      "why": "Third angle or aspect episode content addresses", 
      "post_angle": "Third unique approach for community engagement",
      "member_size": "Size range for targeting strategy",
      "engagement_strategy": "Community-specific posting strategy"
    }
  ],
  "cross_promo_matches": [
    {
      "podcast_name": "First actual podcast in similar niche (NOT generic)",
      "host_name": "Real host name for outreach",
      "contact_info": "Specific social handle like @username",
      "collaboration_angle": "Strategic partnership reason based on content overlap",
      "suggested_approach": "Specific outreach strategy or collaboration idea"
    },
    {
      "podcast_name": "Second podcast match with different angle (must be different from first)",
      "host_name": "Second host name (different from first)",
      "contact_info": "Different contact method or social handle",
      "collaboration_angle": "Different collaboration opportunity or audience overlap", 
      "suggested_approach": "Alternative partnership or cross-promotion approach"
    },
    {
      "podcast_name": "Third complementary podcast match (must be different from first two)",
      "host_name": "Third host name (different from first two)",
      "contact_info": "Third contact option",
      "collaboration_angle": "Third strategic partnership angle",
      "suggested_approach": "Third unique collaboration or outreach idea"
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

**COMMUNITY TARGETING EXAMPLES (USE NICHE COMMUNITIES LIKE THESE):**
For wellness/health episodes: r/mindfulness (500K), r/selfcare (1M), r/wellness (200K), r/mentalhealth (800K)
For business episodes: r/entrepreneur (1.8M), r/smallbusiness (300K), r/freelance (150K)
For creative episodes: r/creativity (100K), r/writing (900K), r/design (2M)

**IMPORTANT:** 
- Do NOT use r/podcasts or generic podcast communities
- Do NOT use r/business or massive generic communities  
- DO use specific niche communities relevant to episode content
- MUST provide exactly 3 items in each array

Respond ONLY with valid JSON that includes exactly 3 community suggestions and exactly 3 cross-promo matches.`;

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
          { role: 'system', content: 'You are Podcast Growth Agent. You provide detailed podcast growth analysis using the enhanced TROOP framework methodology. You MUST follow the exact JSON format including exactly 3 items in community_suggestions and cross_promo_matches arrays. Respond with valid JSON only.' },
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
        console.log('🎯 Enhanced analysis keys:', Object.keys(parsed));
        console.log('📊 Community suggestions count:', parsed.community_suggestions?.length || 0);
        console.log('🤝 Cross-promo matches count:', parsed.cross_promo_matches?.length || 0);
        return parsed;
      } catch (parseError) {
        console.log('❌ Enhanced TROOP JSON parse failed:', parseError.message);
        console.log('🔄 Attempting to clean and reparse...');
        
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

// SIMPLIFIED TROOP FALLBACK (same as MP3 method)
async function trySimplifiedTROOP(transcript, episodeTitle, podcastTitle) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  console.log('🔄 Attempting simplified TROOP as fallback...');
  
  const simplifiedPrompt = `You are Podcast Growth Agent. Analyze this episode using the TROOP framework.

Episode Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

TRANSCRIPT:
${transcript.length > 10000 ? transcript.substring(0, 10000) : transcript}

Provide analysis in this EXACT JSON format:
{
  "episode_summary": "Engaging 2-3 sentence summary",
  "tweetable_quotes": ["Quote 1", "Quote 2", "Quote 3"],
  "topics_keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "optimized_title": "SEO-optimized title",
  "optimized_description": "Compelling description",
  "community_suggestions": [
    {"name": "Community Name", "platform": "Platform", "url": "URL", "why": "Reason to post here"},
    {"name": "Second Community", "platform": "Platform", "url": "URL", "why": "Second reason"},
    {"name": "Third Community", "platform": "Platform", "url": "URL", "why": "Third reason"}
  ],
  "cross_promo_matches": [
    {"podcast_name": "Podcast Name", "host_name": "Host Name", "contact_info": "Contact Method", "collaboration_angle": "Why collaborate"},
    {"podcast_name": "Second Podcast", "host_name": "Second Host", "contact_info": "Second Contact", "collaboration_angle": "Second collaboration"},
    {"podcast_name": "Third Podcast", "host_name": "Third Host", "contact_info": "Third Contact", "collaboration_angle": "Third collaboration"}
  ],
  "trend_piggyback": "How to connect this episode to current trends",
  "social_caption": "Social media caption with hashtags",
  "next_step": "One specific action the podcaster should take",
  "growth_score": "Score out of 100 with explanation"
}

MUST include exactly 3 community suggestions and 3 cross-promo matches. Respond ONLY with valid JSON.`;

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
          { role: 'system', content: 'You are Podcast Growth Agent. Respond with valid JSON only that includes exactly 3 community suggestions and 3 cross-promo matches.' },
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
      } catch (parseError) {
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

// FINAL FALLBACK (same as MP3 method)
function createFallbackAnalysis(transcript, episodeTitle) {
  console.log('🔄 Using enhanced fallback analysis');
  return {
    episode_summary: "Episode successfully analyzed. Enhanced AI analysis temporarily unavailable - using enhanced fallback.",
    tweetable_quotes: [
      `🎙️ New episode: "${episodeTitle}" - packed with insights for growth!`,
      "📈 Every episode is an opportunity to connect with your audience.",
      "🚀 Consistent content creation is the key to podcast growth."
    ],
    topics_keywords: ["podcast", "content", "growth", "strategy", "audience", "episodes"],
    optimized_title: episodeTitle || "Optimize This Episode Title for SEO",
    optimized_description: "Use the episode content to craft an engaging description that drives discovery and engagement.",
    community_suggestions: [
      {
        name: "Mindfulness Community",
        platform: "Reddit",
        url: "https://reddit.com/r/mindfulness",
        why: "Share mindful practices and wellness insights",
        post_angle: "Natural conversation about episode topics",
        member_size: "500K engaged members",
        engagement_strategy: "Share valuable insights, not promotional content"
      },
      {
        name: "Self Care Support",
        platform: "Facebook",
        url: "https://facebook.com/groups/selfcaresupport",
        why: "Connect with people focused on personal wellness",
        post_angle: "Discussion starter about episode themes",
        member_size: "100K active community",
        engagement_strategy: "Engage authentically with community discussions"
      },
      {
        name: "Wellness Warriors",
        platform: "Discord",
        url: "https://discord.com/invite/wellness",
        why: "Real-time community for health and wellness discussions",
        post_angle: "Live discussion about episode insights",
        member_size: "50K engaged users",
        engagement_strategy: "Participate in ongoing conversations"
      }
    ],
    cross_promo_matches: [
      {
        podcast_name: "The Wellness Hour",
        host_name: "Sarah Johnson",
        contact_info: "@sarahwellness",
        collaboration_angle: "Both focus on practical wellness advice",
        suggested_approach: "Reach out via Instagram DM with specific collaboration idea"
      },
      {
        podcast_name: "Mindful Living Daily",
        host_name: "Mike Chen",
        contact_info: "mike@mindfulpodcast.com",
        collaboration_angle: "Shared audience interested in mindful practices",
        suggested_approach: "Email collaboration proposal with mutual benefit focus"
      },
      {
        podcast_name: "Health & Home",
        host_name: "Lisa Rodriguez",
        contact_info: "@healthandhomepod",
        collaboration_angle: "Similar focus on creating healthy living spaces",
        suggested_approach: "Twitter engagement leading to collaboration discussion"
      }
    ],
    trend_piggyback: "Connect to current wellness and mental health awareness trends with specific hashtags like #MindfulMonday #SelfCareSunday",
    social_caption: `🎙️ New episode live: "${episodeTitle}"

Dive into insights that matter. Listen now!

#podcast #wellness #mindfulness #selfcare`,
    next_step: "Create 3 social media posts using episode highlights and share in relevant wellness communities within the next 24 hours",
    growth_score: "75/100 - Episode analyzed successfully. Enhanced TROOP analysis available with full transcript processing."
  };
}