// /api/clips.js
// Updated to work with new twitch_clips table schema
// Compatible with both old and new table structures

const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Determine which table to use based on environment variable
// Set USE_NEW_SCHEMA=true to use twitch_clips table
const USE_NEW_SCHEMA = process.env.USE_NEW_SCHEMA === 'true';
const TABLE_NAME = USE_NEW_SCHEMA ? 'twitch_clips' : 'clips';

module.exports = async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Parse query parameters
        const {
            limit = '100',
            offset = '0',
            sort = 'views',      // 'views' or 'recent'
            period = '7d',       // '24h', '7d', '30d', '90d', 'all'
            streamer,            // Filter by streamer username
            search,              // Search in title
            server = 'chaserp'   // Filter by server (new schema only)
        } = req.query;

        // Build base query
        let query = supabase
            .from(TABLE_NAME)
            .select('*', { count: 'exact' })
            .eq('is_valid', true);

        // Apply server filter (new schema only)
        if (USE_NEW_SCHEMA && server) {
            query = query.eq('serverId', server);
        }

        // Apply time filter
        if (period !== 'all') {
            const now = new Date();
            let startDate;
            
            switch (period) {
                case '24h':
                    startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    break;
                case '7d':
                    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    break;
                case '30d':
                    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    break;
                case '90d':
                    startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
                    break;
                default:
                    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            }
            
            const dateColumn = USE_NEW_SCHEMA ? 'twitch_created_at' : 'created_at';
            query = query.gte(dateColumn, startDate.toISOString());
        }

        // Apply streamer filter
        if (streamer) {
            if (USE_NEW_SCHEMA) {
                // New schema: use streamer_username
                query = query.eq('streamer_username', streamer.toLowerCase());
            } else {
                // Old schema: use broadcaster_login or broadcaster_name
                query = query.or(`broadcaster_id.eq.${streamer},broadcaster_name.ilike.%${streamer}%`);
            }
        }

        // Apply search filter
        if (search) {
            const titleColumn = USE_NEW_SCHEMA ? 'clip_title' : 'title';
            query = query.ilike(titleColumn, `%${search}%`);
        }

        // Apply sorting
        if (sort === 'views') {
            query = query.order('view_count', { ascending: false });
        } else {
            const dateColumn = USE_NEW_SCHEMA ? 'twitch_created_at' : 'created_at';
            query = query.order(dateColumn, { ascending: false });
        }

        // Apply pagination
        const limitNum = Math.min(parseInt(limit), 500);
        const offsetNum = parseInt(offset);
        query = query.range(offsetNum, offsetNum + limitNum - 1);

        // Execute query
        const { data: clips, error, count } = await query;

        if (error) {
            console.error('Supabase error:', error);
            return res.status(500).json({
                success: false,
                error: 'Database error',
                message: error.message
            });
        }

        // Transform data if using new schema (for backward compatibility)
        const transformedClips = USE_NEW_SCHEMA ? clips.map(clip => ({
            ...clip,
            // Add aliases for old column names
            title: clip.clip_title,
            broadcaster_login: clip.streamer_username,
            broadcaster_name: clip.streamer_username,
            created_at: clip.twitch_created_at,
            duration: clip.duration_seconds
        })) : clips;

        // Set cache headers
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

        return res.status(200).json({
            success: true,
            data: transformedClips,
            pagination: {
                total: count,
                limit: limitNum,
                offset: offsetNum,
                hasMore: offsetNum + clips.length < count
            },
            filters: {
                period,
                sort,
                streamer: streamer || null,
                search: search || null,
                server: USE_NEW_SCHEMA ? (server || null) : null
            },
            meta: {
                table: TABLE_NAME,
                schema_version: USE_NEW_SCHEMA ? 'v2' : 'v1'
            }
        });

    } catch (error) {
        console.error('Error fetching clips:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
};
