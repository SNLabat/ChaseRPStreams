import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "https://deno.land/std@0.168.0/dotenv/load.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const TWITCH_CLIENT_ID = Deno.env.get("TWITCH_CLIENT_ID");
const TWITCH_CLIENT_SECRET = Deno.env.get("TWITCH_CLIENT_SECRET");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Stream search configuration interface
 */
interface StreamSearchConfig {
  id: string;
  server_id: string;
  platform: 'twitch' | 'kick';
  search_keyword: string;
  search_type: 'title' | 'category' | 'tag';
  is_active: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

/**
 * Twitch Clips API response interface
 */
interface TwitchClip {
  id: string;
  url: string;
  embed_url: string;
  title: string;
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
  creator_id: string;
  creator_login: string;
  creator_name: string;
  video_id: string;
  game_id: string;
  language: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  is_featured: boolean;
}

/**
 * Twitch user interface for getting user ID from name
 */
interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
}

/**
 * Clip record to be inserted into database
 */
interface ClipRecord {
  clip_id: string;
  streamer_username: string;
  clip_title: string;
  view_count: number;
  duration_seconds: number;
  thumbnail_url: string;
  embed_url: string;
  serverId: string;
  twitch_created_at: string;
  is_valid: boolean;
}

/**
 * Create an AbortSignal that times out after specified milliseconds
 */
function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Get Twitch OAuth token
 */
async function getTwitchToken(): Promise<string> {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error("Twitch credentials not configured");
  }

  try {
    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
      signal: createTimeoutSignal(10000),
    });

    if (!response.ok) {
      throw new Error(`Failed to get Twitch token: ${response.status}`);
    }

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error("[Clips ETL] Error getting Twitch token:", error);
    throw error;
  }
}

/**
 * Get Twitch user ID from username
 */
async function getTwitchUserIdByName(
  username: string,
  clientId: string,
  token: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`,
      {
        headers: {
          "Client-ID": clientId,
          "Authorization": `Bearer ${token}`,
        },
        signal: createTimeoutSignal(10000),
      }
    );

    if (!response.ok) {
      console.error(`[Clips ETL] Failed to get user ID for ${username}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const user = (data.data as TwitchUser[])?.[0];
    return user?.id || null;
  } catch (error) {
    console.error(`[Clips ETL] Error fetching user ID for ${username}:`, error);
    return null;
  }
}

/**
 * Fetch clips for a broadcaster with pagination
 * Matches frontend pagination: 20 pages max (up to 2000 clips per streamer)
 * Fetches clips from the last 7 days, sorted by newest first
 */
async function fetchClipsForStreamer(
  broadcasterId: string,
  streamerUsername: string,
  clientId: string,
  token: string,
  maxPages: number = 40
): Promise<TwitchClip[]> {
  const clips: TwitchClip[] = [];
  let cursor: string | null = null;
  let pageCount = 0;

  // Calculate time range: last 7 days
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const started_at = sevenDaysAgo.toISOString();
  const ended_at = now.toISOString();

  while (pageCount < maxPages) {
    const params = new URLSearchParams({
      broadcaster_id: broadcasterId,
      first: "100",
      started_at,
      ended_at,
      sort: "time",
    });
    if (cursor) params.set("after", cursor);

    try {
      const response = await fetch(
        `https://api.twitch.tv/helix/clips?${params}`,
        {
          headers: {
            "Client-ID": clientId,
            "Authorization": `Bearer ${token}`,
          },
          signal: createTimeoutSignal(15000),
        }
      );

      if (!response.ok) {
        console.error(`[Clips ETL] Twitch API error for ${streamerUsername}: ${response.status}`);
        break;
      }

      const data = await response.json();
      const batch = (Array.isArray(data.data) ? data.data : []) as TwitchClip[];
      clips.push(...batch);

      cursor = data.pagination?.cursor || null;
      if (!cursor || batch.length === 0) break;
      pageCount++;
    } catch (error) {
      console.error(`[Clips ETL] Error fetching clips for ${streamerUsername}:`, error);
      break;
    }
  }

  return clips;
}

/**
 * Load stream search configuration from Supabase
 */
async function getStreamSearchConfigMap(): Promise<Map<string, StreamSearchConfig[]>> {
  const map = new Map<string, StreamSearchConfig[]>();

  try {
    const { data, error } = await supabase
      .from("stream_search_config")
      .select("*")
      .eq("is_active", true)
      .eq("platform", "twitch")
      .order("priority", { ascending: false });

    if (error) {
      console.error("[Clips ETL] Supabase config error:", error);
      return map;
    }

    if (!data || data.length === 0) {
      console.warn("[Clips ETL] No active Twitch config found");
      return map;
    }

    // Group configs by server_id
    for (const row of data as StreamSearchConfig[]) {
      const current = map.get(row.server_id) ?? [];
      current.push(row);
      map.set(row.server_id, current);
    }

    console.log(`[Clips ETL] Loaded config for ${map.size} servers`);
  } catch (error) {
    console.error("[Clips ETL] Error fetching config:", error);
  }

  return map;
}


/**
 * Get all streamers for a server from history table
 */
async function getStreamersForServer(serverId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("streamer_server_history")
      .select("streamer_username")
      .eq("serverId", serverId)
      .eq("platform", "twitch")
      .order("last_seen", { ascending: false });

    if (error) {
      console.error(`[Clips ETL] Error fetching streamers for ${serverId}:`, error);
      return [];
    }

    // Get unique streamer usernames
    const streamers = new Set<string>();
    if (data) {
      for (const row of data) {
        if (row.streamer_username) {
          streamers.add(row.streamer_username);
        }
      }
    }

    return Array.from(streamers);
  } catch (error) {
    console.error(`[Clips ETL] Exception fetching streamers:`, error);
    return [];
  }
}

/**
 * Insert clips into database with deduplication
 */
async function insertClips(clips: ClipRecord[]): Promise<number> {
  if (!clips.length) return 0;

  let inserted = 0;
  const batchSize = 100;

  // Process in batches
  for (let i = 0; i < clips.length; i += batchSize) {
    const batch = clips.slice(i, i + batchSize);
    try {
      const { error } = await supabase
        .from("twitch_clips")
        .upsert(batch, {
          onConflict: "clip_id",
          ignoreDuplicates: true
        });

      if (error) {
        console.error(`[Clips ETL] Supabase insert error (batch ${i}-${i + batch.length - 1}):`, error.message);
      } else {
        inserted += batch.length;
      }
    } catch (error) {
      console.error(`[Clips ETL] Error inserting batch:`, error);
    }
  }

  return inserted;
}

/**
 * Main edge function handler
 */
serve(async (req) => {
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }

  try {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
      throw new Error("Twitch credentials not configured");
    }

    // Get Twitch authentication token
    console.log("[Clips ETL] Authenticating with Twitch...");
    const token = await getTwitchToken();

    // Load stream search configuration
    console.log("[Clips ETL] Loading stream search config...");
    const configMap = await getStreamSearchConfigMap();

    if (configMap.size === 0) {
      console.warn("[Clips ETL] No stream search config found");
      return new Response("No configuration found", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    let totalClipsFetched = 0;
    let totalClipsInserted = 0;
    const results: string[] = [];

    // Process each server
    const serverIds = Array.from(configMap.keys());
    console.log(`[Clips ETL] Processing ${serverIds.length} servers`);

    for (const serverId of serverIds) {
      const config = configMap.get(serverId) || [];
      if (config.length === 0) continue;

      try {
        // Get streamers that have played on this server
        const streamers = await getStreamersForServer(serverId);
        if (streamers.length === 0) {
          console.log(`[Clips ETL] No streamer history for ${serverId}, skipping`);
          continue;
        }

        console.log(`[Clips ETL] Processing ${streamers.length} streamers for server ${serverId}`);

        const clipsToInsert: ClipRecord[] = [];

        // Fetch clips for each streamer
        for (const streamerUsername of streamers) {
          try {
            // Get broadcaster ID
            const broadcasterId = await getTwitchUserIdByName(
              streamerUsername,
              TWITCH_CLIENT_ID,
              token
            );

            if (!broadcasterId) {
              console.warn(`[Clips ETL] Could not find user ID for ${streamerUsername}`);
              continue;
            }

            // Fetch clips for this streamer
            const clips = await fetchClipsForStreamer(
              broadcasterId,
              streamerUsername,
              TWITCH_CLIENT_ID,
              token
            );

            totalClipsFetched += clips.length;

            if (clips.length === 0) {
              console.log(`[Clips ETL] No clips found for ${streamerUsername}`);
              continue;
            }

            // No title filtering needed - streamer_server_history already validates server relationship
            console.log(`[Clips ETL] ${streamerUsername}: found ${clips.length} clips (last 7 days)`);

            // Convert to database format
            for (const clip of clips) {
              // We already know the streamer username from the loop - no need to extract it
              clipsToInsert.push({
                clip_id: clip.id,
                streamer_username: streamerUsername.toLowerCase(),
                clip_title: clip.title,
                view_count: clip.view_count,
                duration_seconds: clip.duration,
                thumbnail_url: clip.thumbnail_url,
                embed_url: clip.embed_url,
                serverId: serverId,
                twitch_created_at: clip.created_at,
                is_valid: true,
              });
            }
          } catch (error) {
            console.error(`[Clips ETL] Error processing streamer ${streamerUsername}:`, error);
          }
        }

        // Insert all matched clips for this server
        if (clipsToInsert.length > 0) {
          const inserted = await insertClips(clipsToInsert);
          totalClipsInserted += inserted;
          console.log(`[Clips ETL] Server ${serverId}: inserted ${inserted} clips`);
        }
      } catch (error) {
        console.error(`[Clips ETL] Error processing server ${serverId}:`, error);
      }
    }

    const summary = `Fetched ${totalClipsFetched} total clips, inserted ${totalClipsInserted} new clips`;
    results.push(summary);

    return new Response(results.join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  } catch (err) {
    console.error("[Clips ETL] Edge function error:", err);
    return new Response(`Error: ${err.message}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
});
