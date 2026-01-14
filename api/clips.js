// /api/clips.js
// Serves clips from Supabase database

const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY // Use anon key for read-only access
);

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
            period = '7d',       // '24h', '7d', '30d', 'all'
            streamer,            // Filter by broadcaster_id or broadcaster_name
            search               // Search in title
        } = req.query;

        // Build query
        let query = supabase
            .from('clips')
            .select('*')
            .eq('is_valid', true);

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
            
            query = query.gte('created_at', startDate.toISOString());
        }

        // Apply streamer filter
        if (streamer) {
            query = query.or(`broadcaster_id.eq.${streamer},broadcaster_name.ilike.%${streamer}%`);
        }

        // Apply search filter
        if (search) {
            query = query.ilike('title', `%${search}%`);
        }

        // Apply sorting
        if (sort === 'views') {
            query = query.order('view_count', { ascending: false });
        } else {
            query = query.order('created_at', { ascending: false });
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

        // Get total count for pagination
        const { count: totalCount } = await supabase
            .from('clips')
            .select('*', { count: 'exact', head: true })
            .eq('is_valid', true);

        // Set cache headers
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

        return res.status(200).json({
            success: true,
            data: clips,
            pagination: {
                total: totalCount,
                limit: limitNum,
                offset: offsetNum,
                hasMore: offsetNum + clips.length < totalCount
            },
            filters: {
                period,
                sort,
                streamer: streamer || null,
                search: search || null
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
