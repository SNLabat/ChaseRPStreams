// /api/bulk-scan.js
// Bulk scan endpoint for initial import of ChaseRP clips from all streamers
// Call multiple times with offset parameter to process all streamers

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const GTA_V_GAME_ID = '32982';
const CHASERP_TERMS = ['chaserp', 'chase rp', 'chase roleplay', 'chaserpg'];

let accessToken = null;
let tokenExpiry = 0;

async function getTwitchToken() {
    if (accessToken && Date.now() < tokenExpiry) {
        return accessToken;
    }

    const response = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: TWITCH_CLIENT_ID,
            client_secret: TWITCH_CLIENT_SECRET,
            grant_type: 'client_credentials'
        })
    });

    const data = await response.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
    return accessToken;
}

// Fetch ALL clips for a broadcaster (more pages than normal collect)
async function fetchBroadcasterClips(broadcasterId, startedAt, token, maxPages = 5) {
    const clips = [];
    let cursor = null;

    for (let page = 0; page < maxPages; page++) {
        const url = new URL('https://api.twitch.tv/helix/clips');
        url.searchParams.set('broadcaster_id', broadcasterId);
        url.searchParams.set('started_at', startedAt);
        url.searchParams.set('first', '100');
        if (cursor) {
            url.searchParams.set('after', cursor);
        }

        const response = await fetch(url, {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            if (response.status === 429) {
                // Rate limited - wait and retry
                console.log('Rate limited, waiting...');
                await new Promise(resolve => setTimeout(resolve, 2000));
                page--; // Retry this page
                continue;
            }
            console.error(`Failed to fetch clips for ${broadcasterId}: ${response.status}`);
            break;
        }

        const data = await response.json();
        
        for (const clip of (data.data || [])) {
            if (clip.game_id === GTA_V_GAME_ID) {
                clips.push(clip);
            }
        }

        cursor = data.pagination?.cursor;
        if (!cursor || data.data.length < 100) break;
        
        await new Promise(resolve => setTimeout(resolve, 30));
    }

    return clips;
}

async function getVODTitles(videoIds, token) {
    const vodTitles = {};
    const uniqueIds = [...new Set(videoIds)].filter(Boolean);

    if (uniqueIds.length === 0) return vodTitles;

    for (let i = 0; i < uniqueIds.length; i += 100) {
        const batch = uniqueIds.slice(i, i + 100);
        const params = batch.map(id => `id=${id}`).join('&');

        try {
            const response = await fetch(
                `https://api.twitch.tv/helix/videos?${params}`,
                {
                    headers: {
                        'Client-ID': TWITCH_CLIENT_ID,
                        'Authorization': `Bearer ${token}`
                    }
                }
            );

            if (response.ok) {
                const data = await response.json();
                (data.data || []).forEach(video => {
                    vodTitles[video.id] = video.title;
                });
            }
        } catch (e) {
            console.error('Error fetching VOD titles:', e);
        }

        await new Promise(resolve => setTimeout(resolve, 30));
    }

    return vodTitles;
}

function isChaseRPContent(clipTitle, vodTitle) {
    const combined = `${clipTitle || ''} ${vodTitle || ''}`.toLowerCase();
    return CHASERP_TERMS.some(term => combined.includes(term));
}

async function getUserProfiles(userIds, token) {
    const profiles = {};
    const uniqueIds = [...new Set(userIds)];

    for (let i = 0; i < uniqueIds.length; i += 100) {
        const batch = uniqueIds.slice(i, i + 100);
        const params = batch.map(id => `id=${id}`).join('&');

        const response = await fetch(
            `https://api.twitch.tv/helix/users?${params}`,
            {
                headers: {
                    'Client-ID': TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        if (response.ok) {
            const data = await response.json();
            (data.data || []).forEach(user => {
                profiles[user.id] = user.profile_image_url;
            });
        }

        await new Promise(resolve => setTimeout(resolve, 30));
    }

    return profiles;
}

async function saveClips(clips, vodTitles, profiles) {
    const validClips = clips.filter(clip => {
        const vodTitle = clip.video_id ? vodTitles[clip.video_id] : null;
        return isChaseRPContent(clip.title, vodTitle);
    });

    if (validClips.length === 0) {
        return { inserted: 0, total_valid: 0 };
    }

    const records = validClips.map(clip => ({
        clip_id: clip.id,
        platform: 'twitch',
        title: clip.title,
        thumbnail_url: clip.thumbnail_url,
        embed_url: clip.embed_url,
        url: clip.url,
        view_count: clip.view_count,
        duration: clip.duration,
        broadcaster_id: clip.broadcaster_id,
        broadcaster_name: clip.broadcaster_name,
        broadcaster_login: clip.broadcaster_name?.toLowerCase(),
        profile_image_url: profiles[clip.broadcaster_id] || null,
        creator_id: clip.creator_id,
        creator_name: clip.creator_name,
        game_id: clip.game_id,
        video_id: clip.video_id,
        vod_title: clip.video_id ? vodTitles[clip.video_id] : null,
        created_at: clip.created_at,
        is_valid: true,
        is_chaserp: true
    }));

    let inserted = 0;

    for (let i = 0; i < records.length; i += 100) {
        const batch = records.slice(i, i + 100);
        
        const { data, error } = await supabase
            .from('clips')
            .upsert(batch, {
                onConflict: 'platform,clip_id',
                ignoreDuplicates: false
            })
            .select();

        if (error) {
            console.error('Error upserting clips:', error);
        } else {
            inserted += data?.length || 0;
        }
    }

    return { inserted, total_valid: validClips.length };
}

module.exports = async function handler(req, res) {
    // Auth check
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;
    
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        if (process.env.NODE_ENV === 'production') {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }

    const startTime = Date.now();
    
    // Parse query parameters
    const {
        offset = '0',           // Starting streamer index
        limit = '200',          // Streamers per batch (higher for bulk scan)
        days = '30',            // How far back to look (default 30 days)
        max_pages = '5'         // Max clip pages per streamer (5 = 500 clips max)
    } = req.query;

    const offsetNum = parseInt(offset);
    const limitNum = Math.min(parseInt(limit), 500); // Cap at 500 per request
    const daysNum = Math.min(parseInt(days), 365); // Cap at 1 year
    const maxPagesNum = Math.min(parseInt(max_pages), 10);

    try {
        const token = await getTwitchToken();

        // Calculate date range
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - daysNum * 24 * 60 * 60 * 1000);
        const startedAt = startDate.toISOString();

        // Get total streamer count for progress tracking
        const { count: totalStreamers } = await supabase
            .from('streamers')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true);

        // Get batch of streamers (by ID order for consistent pagination)
        const { data: streamers, error: streamerError } = await supabase
            .from('streamers')
            .select('twitch_id, twitch_login')
            .eq('is_active', true)
            .order('twitch_id', { ascending: true })
            .range(offsetNum, offsetNum + limitNum - 1);

        if (streamerError || !streamers?.length) {
            return res.status(200).json({
                success: true,
                message: 'No more streamers to process',
                progress: {
                    offset: offsetNum,
                    total_streamers: totalStreamers,
                    completed: true
                }
            });
        }

        console.log(`Bulk scan: Processing streamers ${offsetNum} to ${offsetNum + streamers.length} of ${totalStreamers}`);

        let allClips = [];
        const seenClipIds = new Set();
        let streamersChecked = 0;
        let streamersWithClips = 0;

        for (const streamer of streamers) {
            try {
                const clips = await fetchBroadcasterClips(streamer.twitch_id, startedAt, token, maxPagesNum);
                
                if (clips.length > 0) {
                    streamersWithClips++;
                }

                for (const clip of clips) {
                    if (!seenClipIds.has(clip.id)) {
                        seenClipIds.add(clip.id);
                        allClips.push(clip);
                    }
                }

                streamersChecked++;

                // Update last_clip_check
                await supabase
                    .from('streamers')
                    .update({ 
                        last_clip_check: new Date().toISOString(),
                        last_bulk_scan: new Date().toISOString()
                    })
                    .eq('twitch_id', streamer.twitch_id);

                // Log progress every 50 streamers
                if (streamersChecked % 50 === 0) {
                    console.log(`Progress: ${streamersChecked}/${streamers.length} streamers, ${allClips.length} clips found`);
                }

                await new Promise(resolve => setTimeout(resolve, 50));

            } catch (e) {
                console.error(`Error processing ${streamer.twitch_login || streamer.twitch_id}:`, e.message);
            }
        }

        console.log(`Found ${allClips.length} GTA V clips from ${streamersChecked} streamers`);

        // Get VOD titles for ChaseRP validation
        const videoIds = allClips.map(c => c.video_id).filter(Boolean);
        const vodTitles = await getVODTitles(videoIds, token);

        // Get user profiles
        const userIds = allClips.map(c => c.broadcaster_id);
        const profiles = await getUserProfiles(userIds, token);

        // Save valid ChaseRP clips
        const { inserted, total_valid } = await saveClips(allClips, vodTitles, profiles);

        const duration = Date.now() - startTime;
        const nextOffset = offsetNum + streamers.length;
        const isComplete = nextOffset >= totalStreamers;

        return res.status(200).json({
            success: true,
            duration_ms: duration,
            batch: {
                offset: offsetNum,
                limit: limitNum,
                streamers_in_batch: streamers.length,
                streamers_checked: streamersChecked,
                streamers_with_clips: streamersWithClips
            },
            clips: {
                gta_clips_found: allClips.length,
                chaserp_clips_valid: total_valid,
                clips_saved: inserted
            },
            progress: {
                total_streamers: totalStreamers,
                processed_so_far: nextOffset,
                remaining: Math.max(0, totalStreamers - nextOffset),
                percent_complete: Math.round((nextOffset / totalStreamers) * 100),
                completed: isComplete
            },
            next: isComplete ? null : {
                offset: nextOffset,
                url: `/api/bulk-scan?offset=${nextOffset}&limit=${limitNum}&days=${daysNum}&max_pages=${maxPagesNum}`
            },
            settings: {
                days_back: daysNum,
                max_pages_per_streamer: maxPagesNum
            }
        });

    } catch (error) {
        console.error('Bulk scan error:', error);
        
        return res.status(500).json({
            success: false,
            error: error.message,
            duration_ms: Date.now() - startTime
        });
    }
};

