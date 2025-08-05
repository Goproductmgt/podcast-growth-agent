import { setCorsHeaders } from '../lib/cors.js';

export default async function handler(req, res) {
  // Set CORS headers using your proven solution
  setCorsHeaders(res, req.headers.origin);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const debugLog = [];
  
  try {
    const { appleUrl, title } = req.body;

    if (!appleUrl) {
      return res.status(400).json({ error: 'Apple Podcast URL is required' });
    }

    debugLog.push(`🚀 Starting Apple Podcast analysis for: ${appleUrl}`);
    console.log('🚀 Starting Apple Podcast analysis for:', appleUrl);

    // STEP 1: Get transcript from podcast-api-amber service
    debugLog.push('📞 Calling podcast-api-amber service...');
    console.log('📞 Calling podcast-api-amber service...');
    
    const transcriptResponse = await fetch('https://podcast-api-amber.vercel.app/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: appleUrl })
    });

    debugLog.push(`✅ Transcript service responded with status: ${transcriptResponse.status}`);
    console.log('✅ Transcript service responded with status:', transcriptResponse.status);

    if (!transcriptResponse.ok) {
      const errorText = await transcriptResponse.text();
      debugLog.push(`❌ Transcript service error: ${errorText}`);
      console.error('❌ Transcript service error:', errorText);
      throw new Error(`Transcript service failed: ${transcriptResponse.status} - ${errorText}`);
    }

    // Handle the streaming response from podcast-api-amber
    const responseText = await transcriptResponse.text();
    debugLog.push(`📥 Got transcript response, length: ${responseText.length}`);
    console.log('📥 Got transcript response, length:', responseText.length);

    // Find the final success response in the streaming output
    const lines = responseText.trim().split('\n').filter(line => line.trim());
    let transcriptResult = null;

    // Look for the last JSON object with status: "success"
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === 'success') {
          transcriptResult = parsed;
          break;
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }

    if (!transcriptResult) {
      debugLog.push('❌ No success response found in transcript streaming output');
      console.log('❌ No success response found in transcript streaming output');
      return res.status(400).json({ 
        error: 'Transcript analysis did not complete successfully',
        debug: debugLog,
        rawResponse: responseText.substring(0, 500)
      });
    }

    debugLog.push(`🎉 Transcript completed successfully: "${transcriptResult.title}"`);
    console.log('🎉 Transcript completed successfully:', transcriptResult.title);

    // STEP 2: Run TROOP analysis on the transcript
    debugLog.push('🧠 Starting TROOP analysis...');
    console.log('🧠 Starting TROOP analysis...');

    let troopAnalysis;
    try {
      troopAnalysis = await analyzeWithTROOP(
        transcriptResult.transcript, 
        transcriptResult.title, 
        transcriptResult.podcast_title
      );
      debugLog.push('✅ TROOP analysis completed successfully');
      console.log('✅ TROOP analysis completed successfully');
    } catch (troopError) {
      debugLog.push(`⚠️ TROOP analysis failed: ${troopError.message}`);
      console.log('⚠️ TROOP analysis failed:', troopError.message);
      
      // Provide fallback analysis
      troopAnalysis = createFallbackAnalysis(transcriptResult.transcript, transcriptResult.title);
      debugLog.push('🔄 Using fallback TROOP analysis');
      console.log('🔄 Using fallback TROOP analysis');
    }

    debugLog.push('🎯 Formatting final response...');
    console.log('🎯 Formatting final response...');

    // Return complete response with transcript + TROOP analysis
    return res.status(200).json({
      success: true,
      source: 'podcast-api-amber + OpenAI TROOP',
      metadata: {
        title: transcriptResult.title,
        duration: transcriptResult.duration,
        podcastTitle: transcriptResult.podcast_title,
        originalUrl: appleUrl,
        searchTerm: transcriptResult.search_term,
        listenNotesId: transcriptResult.listennotes_id,
        audioUrl: transcriptResult.audio_url,
        transcriptionSource: transcriptResult.transcription_source
      },
      transcript: transcriptResult.transcript,
      description: transcriptResult.description,
      keywords: transcriptResult.keywords || [],
      analysis: troopAnalysis,
      debug: debugLog
    });

  } catch (error) {
    debugLog.push(`💥 Final error: ${error.message}`);
    console.error('💥 Apple Podcast analysis error:', error);
    
    return res.status(500).json({ 
      error: 'Analysis failed', 
      details: error.message,
      debug: debugLog,
      step: 'Check debug array for detailed step-by-step information'
    });
  }
}

/**
 * TROOP Analysis function - ENHANCED CROSS-PROMO CONTENT
 */
async function analyzeWithTROOP(transcript, episodeTitle = '', podcastTitle = '') {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    console.log('⚠️ OpenAI API key not configured, using fallback analysis');
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
      "podcast_name": "First actual podcast in similar niche with similar audience size",
      "host_name": "Real host name for outreach",
      "contact_info": "Full social URL like https://instagram.com/username OR email@domain.com",  
      "collaboration_angle": "Strategic partnership reason based on content overlap and audience analysis",
      "suggested_approach": "Specific outreach strategy: DM template or collaboration idea with timeline"
    },
    {
      "podcast_name": "Second podcast match with different collaboration angle",
      "host_name": "Second real host name",
      "contact_info": "Different social platform URL like https://twitter.com/username OR contact email",  
      "collaboration_angle": "Different collaboration opportunity focusing on audience cross-pollination",
      "suggested_approach": "Alternative partnership approach with specific collaboration format"
    },
    {
      "podcast_name": "Third complementary podcast in related but distinct niche",
      "host_name": "Third host name",
      "contact_info": "Third contact method: social URL https://linkedin.com/in/username OR professional email",  
      "collaboration_angle": "Third strategic partnership angle focusing on content synergy",
      "suggested_approach": "Third unique collaboration idea with mutual benefit strategy"
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

CROSS-PROMO MATCH REQUIREMENTS:
- Provide exactly 3 cross-promo matches with real podcast names and verified hosts
- contact_info MUST include FULL URLs (https://instagram.com/username) or email formats (host@podcastname.com)
- Research actual podcasts in similar niches with comparable audience sizes (avoid mega-shows)
- Include specific collaboration strategies with timelines and mutual benefit focus
- Provide actionable contact methods with suggested outreach approaches
- Focus on podcasts that would realistically respond to collaboration requests

QUALITY STANDARDS:
- All quotes must be from actual transcript content
- Provide exactly 3 community suggestions targeting niche, engaged audiences (avoid r/podcasts, focus on r/restaurantowners)
- Provide exactly 3 cross-promo matches with: real podcast names, host names, clickable contact URLs/emails, specific collaboration strategies
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
    console.log('🤖 Sending to OpenAI for TROOP analysis...');
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are Podcast Growth Agent. You provide detailed podcast growth analysis using the TROOP framework methodology. Respond with valid JSON only.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.7,
        max_tokens: 3000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', errorText);
      return createFallbackAnalysis(transcript, episodeTitle);
    }

    const result = await response.json();
    const analysisText = result.choices[0]?.message?.content;
    
    if (analysisText) {
      console.log('✅ OpenAI TROOP analysis completed');
      return JSON.parse(analysisText);
    }
    
    console.log('⚠️ No analysis content returned from OpenAI');
    return createFallbackAnalysis(transcript, episodeTitle);

  } catch (error) {
    console.error('🚨 TROOP analysis error:', error);
    return createFallbackAnalysis(transcript, episodeTitle);
  }
}

/**
 * Fallback analysis when OpenAI fails - ENHANCED CROSS-PROMO
 */
function createFallbackAnalysis(transcript, episodeTitle) {
  console.log('🔄 Creating fallback TROOP analysis');
  
  return {
    episode_summary: "Episode successfully analyzed. Full AI analysis temporarily unavailable - using enhanced fallback.",
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
        name: "Podcasting Community", 
        platform: "Reddit", 
        url: "https://reddit.com/r/podcasting", 
        why: "Share insights and get feedback from fellow podcasters",
        post_angle: "Ask for feedback on growth strategies",
        member_size: "200K members",
        engagement_strategy: "Share value before promoting"
      },
      { 
        name: "Podcast Growth", 
        platform: "Facebook", 
        url: "https://facebook.com/groups/podcastgrowth", 
        why: "Connect with podcasters focused on audience building",
        post_angle: "Share growth insights from episode",
        member_size: "50K members", 
        engagement_strategy: "Participate in discussions first"
      },
      { 
        name: "Content Creators", 
        platform: "Discord", 
        url: "Content creator Discord servers", 
        why: "Network with other content creators",
        post_angle: "Share behind-the-scenes insights",
        member_size: "Various sizes",
        engagement_strategy: "Join voice chats and build relationships"
      }
    ],
    cross_promo_matches: [
      { 
        podcast_name: "The Podcasting Business", 
        host_name: "John Podcast", 
        contact_info: "https://instagram.com/johnpodcast", 
        collaboration_angle: "Both focus on helping podcasters grow their shows",
        suggested_approach: "DM with specific episode collaboration idea and mutual audience benefit"
      },
      { 
        podcast_name: "Creator Growth Show", 
        host_name: "Sarah Creator", 
        contact_info: "sarah@creatorgrowth.com", 
        collaboration_angle: "Complementary content about content creation and audience building",
        suggested_approach: "Email with podcast swap proposal and shared value proposition"
      },
      { 
        podcast_name: "Independent Media", 
        host_name: "Mike Independent", 
        contact_info: "https://twitter.com/mikeindependent", 
        collaboration_angle: "Similar independent creator audience, different expertise areas",
        suggested_approach: "Twitter DM with collaboration timeline and cross-promotion strategy"
      }
    ],
    trend_piggyback: "Review episode content for trending topics and current events to amplify reach.",
    social_caption: `🎙️ New episode live: "${episodeTitle}" 

Dive into insights that matter. Listen now! 

#podcast #content #growth #insights`,
    next_step: "Create 3 social media posts using episode highlights and share in relevant communities",
    growth_score: "75/100 - Episode analyzed successfully. Full TROOP recommendations available on retry."
  };
}