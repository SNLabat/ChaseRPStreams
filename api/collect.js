// /api/collect.js
// Collects clips from Twitch for known ChaseRP streamers and stores in Supabase
// This should be triggered by a cron job (e.g., every 15-30 minutes)

const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase with service role key for write access
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Twitch API configuration
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const GTA_V_GAME_ID = '32982';

// ChaseRP search terms for validation
const CHASERP_TERMS = ['chaserp', 'chase rp', 'chase roleplay', 'chaserpg'];

let accessToken = null;
let tokenExpiry = 0;

// Get Twitch access token
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
    tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000; // Refresh 1 min early
    return accessToken;
}

// Fetch clips for a broadcaster
async function fetchBroadcasterClips(broadcasterId, startedAt, token) {
    const clips = [];
    let cursor = null;

    for (let page = 0; page < 3; page++) { // Max 3 pages (300 clips) per streamer
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
            console.error(`Failed to fetch clips for ${broadcasterId}: ${response.status}`);
            break;
        }

        const data = await response.json();
        
        // Only include GTA V clips
        for (const clip of (data.data || [])) {
            if (clip.game_id === GTA_V_GAME_ID) {
                clips.push(clip);
            }
        }

        cursor = data.pagination?.cursor;
        if (!cursor || data.data.length < 100) break;
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    return clips;
}

// Get VOD titles to validate ChaseRP content
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

        await new Promise(resolve => setTimeout(resolve, 50));
    }

    return vodTitles;
}

// Check if text contains ChaseRP keywords
function isChaseRPContent(clipTitle, vodTitle) {
    const combined = `${clipTitle || ''} ${vodTitle || ''}`.toLowerCase();
    return CHASERP_TERMS.some(term => combined.includes(term));
}

// Get user profiles for clips
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

        await new Promise(resolve => setTimeout(resolve, 50));
    }

    return profiles;
}

// Upsert clips to database
async function saveClips(clips, vodTitles, profiles) {
    const validClips = clips.filter(clip => {
        const vodTitle = clip.video_id ? vodTitles[clip.video_id] : null;
        return isChaseRPContent(clip.title, vodTitle);
    });

    if (validClips.length === 0) {
        return { inserted: 0, updated: 0 };
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

    // Upsert in batches
    let inserted = 0;
    let updated = 0;

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
            // Count new vs updated (simplified - counts all as inserted)
            inserted += data?.length || 0;
        }
    }

    return { inserted, updated };
}

// Main collection handler
module.exports = async function handler(req, res) {
    // Verify this is a legitimate cron request (add your own auth)
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;
    
    // Simple auth check - you can make this more robust
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        // Allow manual triggers in development
        if (process.env.NODE_ENV === 'production') {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }

    const startTime = Date.now();
    
    try {
        // Create log entry
        const { data: logEntry } = await supabase
            .from('collection_logs')
            .insert({
                trigger_source: req.query.source || 'api',
                status: 'running'
            })
            .select()
            .single();

        const logId = logEntry?.id;

        // Get Twitch token
        const token = await getTwitchToken();

        // Calculate date range (last 7 days for regular runs)
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        const startedAt = startDate.toISOString();

        // Get streamers to check (prioritize those not checked recently)
        const { data: streamers, error: streamerError } = await supabase
            .from('streamers')
            .select('twitch_id')
            .eq('is_active', true)
            .order('last_clip_check', { ascending: true, nullsFirst: true })
            .limit(100); // Process 100 streamers per run

        if (streamerError || !streamers?.length) {
            console.log('No streamers to check or error:', streamerError);
            
            // If no streamers in DB yet, discover from live streams
            if (!streamers?.length) {
                console.log('No streamers in database - run import first');
            }
            
            return res.status(200).json({
                success: true,
                message: 'No streamers to process',
                streamers_checked: 0
            });
        }

        console.log(`Processing ${streamers.length} streamers...`);

        // Collect clips from each streamer
        let allClips = [];
        const seenClipIds = new Set();
        let streamersChecked = 0;

        for (const streamer of streamers) {
            try {
                const clips = await fetchBroadcasterClips(streamer.twitch_id, startedAt, token);
                
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
                    .update({ last_clip_check: new Date().toISOString() })
                    .eq('twitch_id', streamer.twitch_id);

                // Avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (e) {
                console.error(`Error processing streamer ${streamer.twitch_id}:`, e);
            }
        }

        console.log(`Found ${allClips.length} clips from ${streamersChecked} streamers`);

        // Get VOD titles for validation
        const videoIds = allClips.map(c => c.video_id).filter(Boolean);
        const vodTitles = await getVODTitles(videoIds, token);

        // Get user profiles
        const userIds = allClips.map(c => c.broadcaster_id);
        const profiles = await getUserProfiles(userIds, token);

        // Save valid clips
        const { inserted, updated } = await saveClips(allClips, vodTitles, profiles);

        const duration = Date.now() - startTime;

        // Update log entry
        if (logId) {
            await supabase
                .from('collection_logs')
                .update({
                    completed_at: new Date().toISOString(),
                    streamers_checked: streamersChecked,
                    clips_found: allClips.length,
                    clips_new: inserted,
                    clips_updated: updated,
                    status: 'completed'
                })
                .eq('id', logId);
        }

        return res.status(200).json({
            success: true,
            duration_ms: duration,
            streamers_checked: streamersChecked,
            clips_found: allClips.length,
            clips_saved: inserted,
            clips_updated: updated
        });

    } catch (error) {
        console.error('Collection error:', error);
        
        return res.status(500).json({
            success: false,
            error: error.message,
            duration_ms: Date.now() - startTime
        });
    }
};
