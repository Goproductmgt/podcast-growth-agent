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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  try {
    const { blobUrl, filename, title } = req.body;

    if (!blobUrl) {
      return res.status(400).json({ error: 'Blob URL is required' });
    }

    console.log(`📥 Processing from blob: ${filename}`);

    res.write(JSON.stringify({
      status: 'processing',
      progress: 10,
      message: `📁 Downloading from blob: ${filename}`,
      next_step: 'Starting transcription...'
    }) + '\n');

    const { default: fetch } = await import('node-fetch');
    const fileResponse = await fetch(blobUrl);
    
    if (!fileResponse.ok) {
      throw new Error(`Failed to download from blob: ${fileResponse.statusText}`);
    }

    const fileBuffer = await fileResponse.buffer();
    console.log(`📁 Downloaded ${fileBuffer.length} bytes from blob`);

    res.write(JSON.stringify({
      status: 'processing',
      progress: 30,
      message: '⚡ Starting Groq transcription...',
      file_size: fileBuffer.length
    }) + '\n');

    const transcriptionResult = await transcribeWithGroq(fileBuffer, filename);

    res.write(JSON.stringify({
      status: 'processing',
      progress: 70,
      message: '✅ Transcription complete, analyzing...',
      transcript_length: transcriptionResult.transcript.length
    }) + '\n');

    const analysis = await analyzeWithTROOP(transcriptionResult.transcript, title, filename);

    res.write(JSON.stringify({
      status: 'processing',
      progress: 90,
      message: '🧠 Finalizing results...'
    }) + '\n');

    const processingTime = Date.now() - startTime;
    const finalResponse = {
      status: 'success',
      filename,
      title: title || filename,
      transcript: transcriptionResult.transcript,
      analysis,
      metadata: {
        audio_metrics: transcriptionResult.metrics,
        processing_time_ms: processingTime,
        source: 'Vercel Blob + Groq + GPT',
        processed_at: new Date().toISOString(),
        api_version: '4.0-blob',
        blob_url: blobUrl
      }
    };

    res.write(JSON.stringify(finalResponse) + '\n');
    res.end();

    console.log(`✅ Blob analysis completed in ${processingTime}ms`);

  } catch (error) {
    console.error('❌ Blob analysis failed:', error);
    
    const processingTime = Date.now() - startTime;
    res.write(JSON.stringify({
      status: 'error',
      error: error.message,
      processing_time_ms: processingTime,
      suggestions: ['Check that the blob URL is accessible', 'Ensure file is a valid audio format']
    }) + '\n');
    res.end();
  }
}

async function transcribeWithGroq(fileBuffer, filename) {
  const groqApiKey = process.env.GROQ_API_KEY;
  
  if (!groqApiKey) {
    throw new Error('Groq API key not configured');
  }

  try {
    const formData = new FormData();
    formData.append('file', fileBuffer, {
      filename: filename,
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

async function analyzeWithTROOP(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    return createFallbackAnalysis(transcript, episodeTitle);
  }

  const analysisPrompt = `
**TASK:**
Analyze the provided podcast episode transcript and generate a comprehensive 10-section growth strategy that helps podcasters expand their audience reach. Extract semantic meaning from the actual transcript content and create actionable marketing recommendations that connect the episode to niche communities and growth opportunities.

**ROLE:**
You are Podcast Growth Agent, an expert podcast growth strategist, SEO specialist, and marketing analyst with 10+ years of experience helping independent podcasters grow their shows. You combine deep transcript analysis with advanced SEO strategy, community targeting expertise, and semantic understanding of audience psychology. You think like a seasoned marketing strategist and SEO expert who specializes in long-tail growth for smaller podcasts competing against established shows across all podcast platforms (Apple Podcasts, Spotify, Google Podcasts, YouTube, web search).

**OUTPUT:**
Generate analysis in this EXACT JSON format:

{
  "episode_summary": "2-3 engaging sentences that capture both explicit content and underlying themes, using searchable language while preserving authentic voice",
  
  "tweetable_quotes": [
    "Direct quote from transcript, lightly edited for social media clarity, under 280 characters",
    "Second actual quote that captures key insight or emotional moment",
    "Third memorable line from episode content, optimized for shareability"
  ],
  
  "topics_keywords": [
    "High-intent longtail keywords from transcript (3-5 words, search volume 100-1000/month)",
    "Question-based keywords people search ('how to', 'what is', 'why does')",
    "Problem-solution keywords that match episode content",
    "Semantic SEO terms that weren't explicitly mentioned but align with episode meaning",
    "Platform-specific keywords for Apple Podcasts, Spotify, YouTube discovery",
    "Local/niche modifiers when relevant (e.g., 'for beginners', 'in 2024', 'without equipment')"
  ],
  
  "optimized_title": "SEO-optimized title with primary keyword front-loaded, emotional hook, and clear benefit (under 60 characters for full display)",
  
  "optimized_description": "150-200 word SEO-optimized description that includes: primary keyword in first 125 characters, 2-3 related keywords naturally woven in, emotional hooks, clear value proposition, and call-to-action. Optimized for Apple Podcasts, Spotify, and Google search discovery.",
  
  "community_suggestions": [
    {
      "name": "First specific niche community name (1K-100K members preferred)",
      "platform": "Reddit/Facebook/Discord/LinkedIn/Specialized platforms",
      "url": "Working URL like https://reddit.com/r/restaurantowners",
      "why": "How episode content solves specific problems this community discusses",
      "post_angle": "Natural conversation starter that adds value before mentioning podcast",
      "member_size": "Optimal 1K-100K range for growing podcasts",
      "engagement_strategy": "Specific approach for this community's culture"
    },
    {
      "name": "Second niche community in different platform/angle",
      "platform": "Different platform from first suggestion",
      "url": "Working URL or specific search terms",
      "why": "Different angle or problem this episode addresses",
      "post_angle": "Alternative approach for different community culture",
      "member_size": "Community size information",
      "engagement_strategy": "Platform-specific engagement approach"
    },
    {
      "name": "Third complementary niche community",
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
      "podcast_name": "First actual podcast in similar niche",
      "host_name": "Real host name for outreach",
      "contact_info": "Specific social handle like @username",  
      "collaboration_angle": "Strategic partnership reason based on content overlap",
      "suggested_approach": "Specific outreach strategy or collaboration idea"
    },
    {
      "podcast_name": "Second podcast match with different angle",
      "host_name": "Second host name",
      "contact_info": "Different contact method or social handle",  
      "collaboration_angle": "Different collaboration opportunity or audience overlap",
      "suggested_approach": "Alternative partnership or cross-promotion approach"
    },
    {
      "podcast_name": "Third complementary podcast match",
      "host_name": "Third host name",
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
Help independent podcasters who are overwhelmed by marketing and don't know how to grow their audience. They need immediate, actionable steps they can take today to get more listeners without requiring a marketing team or technical knowledge. Focus on turning one episode into multiple growth opportunities through strategic niche community targeting and authentic audience extension.

**PERSPECTIVE:**
Approach this analysis from the mindset of a supportive growth partner who:
- Understands the creator is likely solo, motivated, but overwhelmed by marketing options
- Knows they want practical advice, not theory or corporate jargon  
- Recognizes they need encouragement along with strategy
- Assumes they have limited time and resources
- Believes every podcast has potential if marketed to the right niche audiences
- Prioritizes long-tail growth strategy over competing in oversaturated broad communities
- Uses actual episode content as semantic foundation for strategic reach extension
- Makes recommendations copy-pasteable and immediately actionable
- Stays encouraging and avoids intimidating marketing jargon

SEMANTIC ANALYSIS METHODOLOGY:
1. TRANSCRIPT FOUNDATION: Use the exact transcript text to establish deep semantic understanding of themes, emotions, and implicit meanings present in the content.

2. STRATEGIC REACH EXTENSION: Based on that semantic understanding, identify niche audience segments, specific communities (1K-100K members), and expanded keyword opportunities that connect to the core themes.

3. NICHE COMMUNITY STRATEGY: Prioritize smaller, engaged communities over massive generic ones. Growing podcasts succeed by winning in specific niches rather than competing in oversaturated broad communities.

4. SEO-DRIVEN AMPLIFICATION: Apply advanced SEO principles including keyword optimization, search intent matching, and multi-platform discoverability strategy for Apple Podcasts, Spotify, Google Podcasts, YouTube, and web search.

5. AUTHENTIC AMPLIFICATION: Extend the episode's reach while preserving the authentic voice and core message - amplifying impact without changing identity.

EPISODE INFORMATION:
Episode Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}

TRANSCRIPT:
${transcript}

SEO OPTIMIZATION STRATEGY:
- Front-load primary keywords in titles and descriptions for platform algorithms
- Target question-based keywords people actually search ("how to", "what is", "why does")
- Include semantic SEO terms that expand discoverability beyond exact keywords
- Optimize for multiple platforms: Apple Podcasts, Spotify, Google Podcasts, YouTube
- Use longtail keywords (3-5 words) with moderate search volume (100-1000/month)
- Include problem-solution keyword pairs that match listener search intent
- Add temporal and skill-level modifiers when relevant ("2024", "beginners", "advanced")

COMMUNITY TARGETING STRATEGY:
- Prioritize niche communities (1K-100K members) over massive generic ones
- Target problem-specific communities where episode content solves actual challenges  
- Focus on engaged, specialized audiences rather than broad, oversaturated spaces
- Consider specialized platforms beyond Reddit: Discord servers, Facebook groups, professional networks
- Use community directory knowledge as inspiration, not limitation - discover new communities that align with content

QUALITY STANDARDS:
- All quotes must be from actual transcript content
- Provide exactly 3 community suggestions targeting niche, engaged audiences (avoid r/podcasts, focus on r/restaurantowners)
- Provide exactly 3 cross-promo matches with actual podcasts and findable hosts in similar niches
- SEO keywords must be based on actual episode content with strategic search intent matching
- Titles and descriptions must balance keyword optimization with authentic voice
- All recommendations must enhance discoverability across podcast platforms and web search
- Maintain encouraging, expert-level marketing guidance throughout
- Focus on long-tail SEO and growth strategies for smaller podcasts competing against established shows

COMMUNITY TARGETING PRINCIPLES:
- Choose r/EtsySellers (95K) over r/Entrepreneur (1.8M) 
- Target r/restaurantowners (15K) over r/business (2.8M)
- Suggest specialized Discord servers over generic Facebook groups
- Prioritize problem-specific communities over demographic-broad ones

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
          { role: 'system', content: 'You are Podcast Growth Agent. You provide detailed podcast growth analysis using the TROOP framework methodology. Respond with valid JSON only.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.7,
        max_tokens: 3000
      })
    });

    if (!response.ok) {
      return createFallbackAnalysis(transcript, episodeTitle);
    }

    const result = await response.json();
    const analysisText = result.choices[0]?.message?.content;
    
    if (analysisText) {
      return JSON.parse(analysisText);
    }
    
    return createFallbackAnalysis(transcript, episodeTitle);

  } catch (error) {
    return createFallbackAnalysis(transcript, episodeTitle);
  }
}

function createFallbackAnalysis(transcript, episodeTitle) {
  return {
    episode_summary: "Episode successfully transcribed. AI analysis temporarily unavailable.",
    tweetable_quotes: ["🎙️ New episode transcribed and ready for optimization!"],
    topics_keywords: ["podcast", "content", "growth", "strategy"],
    optimized_title: episodeTitle || "Optimize This Episode Title",
    optimized_description: "Use the transcript to craft an engaging description.",
    community_suggestions: [{ name: "Podcasting", platform: "Reddit", url: "https://reddit.com/r/podcasting", why: "Community feedback" }],
    cross_promo_matches: [{ podcast_name: "Analysis pending", host_name: "Please try again", contact_info: "Service restoration in progress", collaboration_angle: "Future partnership opportunities" }],
    trend_piggyback: "Review transcript for trending topics.",
    social_caption: "🎙️ New episode ready! #podcast #content",
    next_step: "Review transcript and create social media posts",
    growth_score: "Transcript ready - manual analysis recommended"
  };
}