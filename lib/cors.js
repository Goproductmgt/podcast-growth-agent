// lib/cors.js - ES Module CORS helper
export function setCorsHeaders(res, origin = null) {
  const allowedOrigins = [
    'https://podcastgrowthagent.com',
    'https://www.podcastgrowthagent.com',
    'http://localhost:3000', // For testing
    'http://localhost:3001'  // For testing
  ];
  
  // Determine which origin to use
  const corsOrigin = origin && allowedOrigins.includes(origin) 
    ? origin 
    : 'https://podcastgrowthagent.com';
  
  // Set all CORS headers
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control');
  res.setHeader('Access-Control-Allow-Credentials', 'false');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  
  console.log(`🌐 CORS headers set for origin: ${corsOrigin}`);
}

export function handleCorsPrelight(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res, req.headers.origin);
    console.log('🚀 CORS preflight handled');
    res.status(200).end();
    return true; // Indicates preflight was handled
  }
  return false; // Not a preflight request
}