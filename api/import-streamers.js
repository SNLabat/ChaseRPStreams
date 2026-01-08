// /api/import-streamers.js
// One-time import of streamers from streamer_ids.json to Supabase
// Run once to populate the database, then disable or delete

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
    // Security: Only allow POST and require a secret
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Use POST method' });
    }

    const importSecret = process.env.IMPORT_SECRET;
    if (importSecret && req.headers.authorization !== `Bearer ${importSecret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // Load the JSON file
        const filePath = path.join(process.cwd(), 'streamer_ids.json');
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const streamers = JSON.parse(fileContent);

        console.log(`Loaded ${streamers.length} streamers from file`);

        // Prepare records
        const records = streamers
            .filter(s => s.id) // Only include streamers with IDs
            .map(s => ({
                twitch_id: String(s.id),
                twitch_login: s.login || null,
                twitch_name: s.name || s.login || null,
                is_active: true
            }));

        console.log(`Prepared ${records.length} records for import`);

        // Import in batches
        const batchSize = 500;
        let imported = 0;
        let errors = 0;

        for (let i = 0; i < records.length; i += batchSize) {
            const batch = records.slice(i, i + batchSize);
            
            const { data, error } = await supabase
                .from('streamers')
                .upsert(batch, {
                    onConflict: 'twitch_id',
                    ignoreDuplicates: true
                });

            if (error) {
                console.error(`Batch ${i / batchSize + 1} error:`, error.message);
                errors++;
            } else {
                imported += batch.length;
                console.log(`Imported batch ${i / batchSize + 1}: ${batch.length} records`);
            }

            // Small delay between batches
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return res.status(200).json({
            success: true,
            total_in_file: streamers.length,
            records_prepared: records.length,
            imported: imported,
            batch_errors: errors,
            message: `Successfully imported ${imported} streamers`
        });

    } catch (error) {
        console.error('Import error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
};
