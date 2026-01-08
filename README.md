# Chase Roleplay Streams & Clips

A website that aggregates live Twitch streams and top clips from Chase Roleplay (ChaseRP) GTA V servers. Features automated clip collection from 9,000+ known ChaseRP streamers.

## Features

- **Live Streams**: Real-time display of currently live ChaseRP streams
- **Top Clips**: Curated clips from verified ChaseRP streams
- **Smart Validation**: Only includes clips from streams with "ChaseRP" in the title
- **Auto-Collection**: Cron job collects new clips every 10 minutes
- **Time Filters**: Past 24 hours, Past Week, Past Month, All Time
- **Pagination**: Load more clips as you scroll

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Frontend      │────▶│  Vercel API     │────▶│    Supabase     │
│  (HTML/JS)      │     │  (Serverless)   │     │   (Database)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │   Twitch API    │
                        │  (Clips/VODs)   │
                        └─────────────────┘
```

### Frontend
- `index.html` - Live streams page
- `clips.html` - Top clips with pagination and filtering

### API Endpoints (Vercel Serverless)
| Endpoint | Description |
|----------|-------------|
| `GET /api/clips` | Fetch clips from database with filtering |
| `GET /api/collect` | Cron job - collects clips from 500 streamers |
| `GET /api/bulk-scan` | Manual bulk scan with pagination |
| `POST /api/import-streamers` | Import streamers from JSON to database |

### Database (Supabase)
- `streamers` - 9,000+ known ChaseRP streamer IDs
- `clips` - Validated ChaseRP clips
- `collection_logs` - Cron job execution history

## ChaseRP Validation

Clips are only saved if the **VOD title** or **clip title** contains:
- `chaserp`
- `chase rp`
- `chase roleplay`
- `chase role play`
- `chaserpg`
- `chase-rp`
- `#chaserp`

This ensures only actual ChaseRP content is included, not random GTA clips.

## Setup

### 1. Environment Variables

Set these in your Vercel project settings:

```env
# Twitch API (https://dev.twitch.tv/console/apps)
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret

# Supabase (Project Settings → API)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Optional: Auth for cron/manual triggers
CRON_SECRET=your_secret_here
```

### 2. Database Setup

Create these tables in Supabase:

```sql
-- Streamers table
CREATE TABLE streamers (
    id SERIAL PRIMARY KEY,
    twitch_id TEXT UNIQUE NOT NULL,
    twitch_login TEXT,
    twitch_name TEXT,
    is_active BOOLEAN DEFAULT true,
    last_clip_check TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Clips table
CREATE TABLE clips (
    id SERIAL PRIMARY KEY,
    clip_id TEXT NOT NULL,
    platform TEXT DEFAULT 'twitch',
    title TEXT,
    thumbnail_url TEXT,
    embed_url TEXT,
    url TEXT,
    view_count INTEGER DEFAULT 0,
    duration REAL,
    broadcaster_id TEXT,
    broadcaster_name TEXT,
    broadcaster_login TEXT,
    profile_image_url TEXT,
    creator_id TEXT,
    creator_name TEXT,
    game_id TEXT,
    video_id TEXT,
    vod_title TEXT,
    created_at TIMESTAMPTZ,
    is_valid BOOLEAN DEFAULT true,
    is_chaserp BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(platform, clip_id)
);

-- Collection logs
CREATE TABLE collection_logs (
    id SERIAL PRIMARY KEY,
    trigger_source TEXT,
    status TEXT,
    streamers_checked INTEGER,
    clips_found INTEGER,
    clips_new INTEGER,
    clips_updated INTEGER,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_clips_created_at ON clips(created_at DESC);
CREATE INDEX idx_clips_view_count ON clips(view_count DESC);
CREATE INDEX idx_clips_is_valid ON clips(is_valid);
CREATE INDEX idx_streamers_last_check ON streamers(last_clip_check);
```

### 3. Import Streamers

```bash
# Deploy first
vercel --prod

# Then import the streamer list
curl -X POST https://your-app.vercel.app/api/import-streamers \
  -H "Authorization: Bearer YOUR_IMPORT_SECRET"
```

### 4. Initial Clip Scan

Use the Python script to do a bulk scan of all streamers:

```bash
# Create .env file
echo "TWITCH_CLIENT_ID=xxx
TWITCH_CLIENT_SECRET=xxx
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxx" > .env

# Run bulk import
python3 scripts/bulk-import.py --days 90
```

## Cron Job

The cron runs automatically every 10 minutes (configured in `vercel.json`):

```json
{
  "crons": [
    {
      "path": "/api/collect?source=cron",
      "schedule": "*/10 * * * *"
    }
  ]
}
```

Each run:
1. Processes 500 streamers (prioritizing those not checked recently)
2. Fetches their GTA V clips from the last 7 days
3. Validates clips have ChaseRP in VOD/clip title
4. Saves valid clips to database

With 9,000+ streamers, full coverage happens every ~3 hours.

## Local Development

```bash
# Install dependencies
npm install

# Login to Vercel (required for dev server)
npx vercel login

# Run local dev server
npx vercel dev

# Site available at http://localhost:3000
```

## Scripts

### `scripts/bulk-import.py`

Standalone Python script for bulk importing clips directly to Supabase.

```bash
# Standard import (ChaseRP validated)
python3 scripts/bulk-import.py --days 90

# Test a specific streamer
python3 scripts/bulk-import.py --test STREAMER_NAME --days 90

# Import from specific streamer
python3 scripts/bulk-import.py --import-user STREAMER_NAME --days 90

# Resume from offset
python3 scripts/bulk-import.py --start 2000 --days 90
```

## API Reference

### GET /api/clips

Fetch clips from the database.

**Parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| `limit` | 100 | Clips per page (max 500) |
| `offset` | 0 | Pagination offset |
| `period` | 7d | Time filter: `24h`, `7d`, `30d`, `90d`, `all` |
| `sort` | views | Sort by: `views` or `recent` |
| `streamer` | - | Filter by broadcaster ID or name |
| `search` | - | Search in clip titles |

**Response:**
```json
{
  "success": true,
  "data": [...clips],
  "pagination": {
    "total": 1234,
    "limit": 100,
    "offset": 0,
    "hasMore": true
  }
}
```

### GET /api/collect

Triggered by cron job to collect new clips.

**Response:**
```json
{
  "success": true,
  "duration_ms": 45000,
  "streamers_checked": 500,
  "clips_found": 150,
  "clips_saved": 42
}
```

### GET /api/bulk-scan

Manual bulk scan with pagination for initial import.

**Parameters:**
| Param | Default | Description |
|-------|---------|-------------|
| `offset` | 0 | Starting streamer index |
| `limit` | 50 | Streamers per batch |
| `days` | 30 | Days to look back |
| `max_pages` | 2 | Clip pages per streamer |

## Vercel Configuration

The `vercel.json` configures function timeouts and cron:

```json
{
  "version": 2,
  "functions": {
    "api/bulk-scan.js": { "maxDuration": 300 },
    "api/collect.js": { "maxDuration": 300 }
  },
  "crons": [
    {
      "path": "/api/collect?source=cron",
      "schedule": "*/10 * * * *"
    }
  ]
}
```

**Note:** 300s (5 min) timeout requires Vercel Pro plan.

## Credits

- Powered by [Twitch API](https://dev.twitch.tv/)
- Database by [Supabase](https://supabase.com/)
- Hosted on [Vercel](https://vercel.com/)
- Not affiliated with Rockstar Games or Chase RP

## License

MIT
