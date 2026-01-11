import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "https://deno.land/std@0.168.0/dotenv/load.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY = Deno.env.get("SUPABASE_ANON_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Clip to validate
 */
interface ClipToValidate {
  id: number;
  clip_id: string;
  embed_url: string;
  last_validated_at: string | null;
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
 * Check if a clip URL is still valid
 * Makes an HTTP HEAD request to the embed URL
 */
async function isClipValid(embedUrl: string): Promise<boolean> {
  try {
    const response = await fetch(embedUrl, {
      method: "HEAD",
      signal: createTimeoutSignal(10000),
    });

    // Valid if we get 2xx status
    return response.status >= 200 && response.status < 300;
  } catch (error) {
    console.error(`[Validation] Error checking clip ${embedUrl}:`, error);
    // Assume invalid if there's an error checking
    return false;
  }
}

/**
 * Get clips that need validation
 * Fetches from the clips_needing_validation view
 */
async function getClipsNeedingValidation(): Promise<ClipToValidate[]> {
  try {
    const { data, error } = await supabase
      .from("clips_needing_validation")
      .select("id, clip_id, embed_url, last_validated_at")
      .limit(1000);

    if (error) {
      console.error("[Validation] Error fetching clips to validate:", error);
      return [];
    }

    return (data || []) as ClipToValidate[];
  } catch (error) {
    console.error("[Validation] Exception fetching clips:", error);
    return [];
  }
}

/**
 * Update clip validity status
 */
async function updateClipValidity(
  clipId: number,
  isValid: boolean
): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("twitch_clips")
      .update({
        is_valid: isValid,
        last_validated_at: now,
      })
      .eq("id", clipId);

    if (error) {
      console.error(`[Validation] Error updating clip ${clipId}:`, error);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[Validation] Exception updating clip ${clipId}:`, error);
    return false;
  }
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
    console.log("[Validation] Starting clip validation process...");

    // Get clips that need validation
    const clipsToCheck = await getClipsNeedingValidation();

    if (clipsToCheck.length === 0) {
      console.log("[Validation] No clips need validation");
      return new Response("No clips to validate", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    console.log(`[Validation] Found ${clipsToCheck.length} clips to validate`);

    let validated = 0;
    let invalidated = 0;

    // Validate each clip
    for (const clip of clipsToCheck) {
      try {
        console.log(`[Validation] Checking clip ${clip.clip_id}...`);

        const isValid = await isClipValid(clip.embed_url);
        const updated = await updateClipValidity(clip.id, isValid);

        if (updated) {
          validated++;
          if (!isValid) {
            invalidated++;
            console.log(`[Validation] Clip ${clip.clip_id} marked as invalid`);
          }
        }

        // Small delay to avoid overwhelming the system
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`[Validation] Error processing clip ${clip.clip_id}:`, error);
      }
    }

    const summary = `Validated ${validated} clips (${invalidated} marked as invalid)`;
    console.log(`[Validation] ${summary}`);

    return new Response(summary, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  } catch (err) {
    console.error("[Validation] Edge function error:", err);
    return new Response(`Error: ${err.message}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
});