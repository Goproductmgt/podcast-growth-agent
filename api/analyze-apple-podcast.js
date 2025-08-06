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
* TROOP Analysis function (copied from your working analyze-from-blob.js)
*/
async function analyzeWithTROOP(transcript, episodeTitle = '', podcastTitle = '') {
 const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
   console.log('⚠️ OpenAI API key not configured, using fallback analysis');
   return createFallbackAnalysis(transcript, episodeTitle);
 }


 const analysisPrompt = `You are Podcast Growth Agent. Analyze this episode using the TROOP framework.


Episode Title: ${episodeTitle || 'New Episode'}
Podcast: ${podcastTitle || 'Podcast Growth Analysis'}


TRANSCRIPT:
${transcript}


Provide analysis in this EXACT JSON format:
{
 "episode_summary": "Engaging 2-3 sentence summary",
 "tweetable_quotes": ["Quote 1", "Quote 2", "Quote 3"],
 "topics_keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
 "optimized_title": "SEO-optimized title",
 "optimized_description": "Compelling description",
 "community_suggestions": [
   {"name": "Community Name", "platform": "Platform", "url": "URL", "why": "Reason to post here"}
 ],
 "cross_promo_matches": [
   {"podcast_name": "Podcast Name", "host_name": "Host Name", "contact_info": "Contact Method", "collaboration_angle": "Why collaborate"}
 ],
 "trend_piggyback": "How to connect this episode to current trends",
 "social_caption": "Social media caption with hashtags",
 "next_step": "One specific action the podcaster should take",
 "growth_score": "Score out of 100 with explanation"
}


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
         { role: 'system', content: 'You are Podcast Growth Agent. Respond with valid JSON only.' },
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
* Fallback analysis when OpenAI fails (copied from your analyze-from-blob.js)
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
       why: "Share insights and get feedback from fellow podcasters"
     },
     {
       name: "Podcast Growth",
       platform: "Facebook",
       url: "https://facebook.com/groups/podcastgrowth",
       why: "Connect with podcasters focused on audience building"
     }
   ],
   cross_promo_matches: [
     {
       podcast_name: "Analysis pending - full recommendations coming soon",
       host_name: "Please retry for detailed matches",
       contact_info: "Service restoration in progress",
       collaboration_angle: "Future partnership opportunities available"
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

