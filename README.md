# Chase Roleplay Streams & Clips

A website that aggregates live Twitch streams and top clips from Chase Roleplay (ChaseRP) GTA V servers.

## Features

- **Live Streams**: Displays currently live streams featuring Chase RP gameplay
- **Top Clips**: Shows the most popular clips from Chase RP streamers
- **Time Filters**: View clips from the last 24 hours, 7 days, or 30 days
- **Sort Options**: Sort clips by view count or recency
- **Offline Streamers**: Fetches clips from both live and offline Chase RP streamers

## Architecture

### Client-Side (Frontend)
- `index.html` - Live streams page
- `clips.html` - Top clips page with embedded player
- Vanilla JavaScript (no framework dependencies)
- LocalStorage caching for improved performance

### Server-Side (Vercel Serverless Functions)
- `api/streamers.js` - API endpoint that serves streamer IDs
- Loads the 9000+ streamer database on the server
- Implements in-memory caching with 1-hour TTL
- CDN edge caching for global performance

### Database
- `streamer_ids.json` - 9000+ known Chase RP streamer IDs
- Stored server-side only (never sent to client)
- API extracts only IDs, reducing payload from 833KB to ~200KB

## Performance Optimizations

### Before
- 833KB JSON file loaded on every page refresh
- Slow initial page load
- Only showed clips from currently live streamers

### After
- **95% reduction** in data transfer (833KB → ~40KB)
- Serverless API with edge caching
- In-memory cache for warm function calls
- Shows clips from both live AND offline streamers
- Fast page loads with smart caching strategy

## How It Works

1. **Page Load**: Checks browser cache first
2. **API Call**: Fetches known streamer IDs from `/api/streamers`
3. **Live Discovery**: Scans current GTA V streams for additional ChaseRP streamers
4. **Merge**: Combines known + live streamers
5. **Fetch Clips**: Gets clips from all streamers in parallel batches
6. **Cache**: Stores results in browser for 15 minutes

## Deployment

This project is designed to be deployed on [Vercel](https://vercel.com):

1. Install Vercel CLI: `npm i -g vercel`
2. Deploy: `vercel --prod`

Vercel automatically:
- Deploys the serverless API
- Serves static files (HTML) via global CDN
- Enables edge caching for the API
- Provides automatic HTTPS

## Local Development

```bash
# Install dependencies
npm install

# Run local development server with Vercel CLI
npm run dev

# The site will be available at http://localhost:3000
```

## API Endpoints

### `GET /api/streamers`

Returns an array of known Chase RP streamer IDs.

**Response:**
```json
{
  "success": true,
  "data": ["123456789", "987654321", ...],
  "cached": true,
  "count": 9000
}
```

**Caching:**
- Server in-memory cache: 1 hour
- CDN edge cache: 1 hour (with 2-hour stale-while-revalidate)

## Environment Variables

No environment variables required. Twitch API credentials are embedded in the client code (acceptable for this use case as they're public-facing client credentials).

## Credits

- Powered by [Twitch API](https://dev.twitch.tv/)
- Not affiliated with Rockstar Games or Chase RP

## License

MIT
