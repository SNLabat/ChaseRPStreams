// /api/trending.js
// Fetches trending clips from HasRoot API

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
        const {
            range = '7d',        // '1d', '7d', '30d'
            page = '0',
            minViews = '100',    // Minimum view threshold
            sort = 'top'         // 'top' or 'recent'
        } = req.query;

        // Build HasRoot API URL
        // Note: You may need to adjust the server parameter based on ChaseRP's server ID
        const hasRootUrl = `https://chaserp.hasroot.com/clips.json.php?range=${range}&page=${page}&json=true&sort=${sort}`;
        
        console.log('Fetching from HasRoot:', hasRootUrl);

        const response = await fetch(hasRootUrl);
        
        if (!response.ok) {
            throw new Error(`HasRoot API returned ${response.status}`);
        }

        const data = await response.json();
        const clips = data.clips || [];

        // Filter clips by view threshold
        const minViewsNum = parseInt(minViews);
        const filteredClips = clips.filter(clip => 
            (clip.views || 0) >= minViewsNum
        );

        // Transform HasRoot format to match our internal format
        const transformedClips = filteredClips.map(clip => ({
            clip_id: clip.slug || clip.id,
            title: clip.title || '',
            url: clip.url || '',
            thumbnail_url: clip.thumbnail || clip.thumbnailUrl || '',
            view_count: clip.views || 0,
            duration: clip.duration || 0,
            created_at: clip.created_at || clip.createdAt || new Date().toISOString(),
            broadcaster_name: clip.broadcaster_displayName || clip.streamer || '',
            broadcaster_id: clip.broadcaster_id || '',
            profile_image_url: clip.broadcaster_profilePicture || '',
            // HasRoot specific fields
            hasroot_slug: clip.slug,
            source: 'hasroot'
        }));

        // Cache for 5 minutes
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

        return res.status(200).json({
            success: true,
            data: transformedClips,
            pagination: {
                total: transformedClips.length,
                page: parseInt(page),
                hasMore: clips.length >= 225, // HasRoot returns max 225 per page
                nextPage: clips.length >= 225 ? parseInt(page) + 1 : null
            },
            filters: {
                range,
                sort,
                minViews: minViewsNum
            },
            source: 'hasroot'
        });

    } catch (error) {
        console.error('Error fetching from HasRoot:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch from HasRoot',
            message: error.message
        });
    }
};
