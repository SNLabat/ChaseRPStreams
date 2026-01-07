// Vercel Serverless Function to serve Chase RP streamer IDs
// This keeps the large JSON on the server and only sends IDs to the client

const fs = require('fs');
const path = require('path');

// Cache the streamer data in memory (persists across warm function calls)
let cachedStreamerIds = null;
let cacheTimestamp = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

module.exports = async function handler(req, res) {
  try {
    // Check if we have a valid cache
    const now = Date.now();
    if (cachedStreamerIds && cacheTimestamp && (now - cacheTimestamp) < CACHE_DURATION) {
      console.log('Serving from cache');
      return res.status(200).json({
        success: true,
        data: cachedStreamerIds,
        cached: true,
        count: cachedStreamerIds.length
      });
    }

    // Load the JSON file from the root directory
    const filePath = path.join(process.cwd(), 'streamer_ids.json');
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const streamers = JSON.parse(fileContent);

    // Extract only the IDs (much smaller payload)
    cachedStreamerIds = streamers.map(s => s.id).filter(Boolean);
    cacheTimestamp = now;

    console.log(`Loaded ${cachedStreamerIds.length} streamer IDs`);

    // Set cache headers for CDN and browser caching
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

    return res.status(200).json({
      success: true,
      data: cachedStreamerIds,
      cached: false,
      count: cachedStreamerIds.length
    });

  } catch (error) {
    console.error('Error loading streamer IDs:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to load streamer data',
      message: error.message
    });
  }
};
