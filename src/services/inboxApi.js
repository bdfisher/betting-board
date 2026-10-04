import { supabase, isSupabaseConfigured } from "../supabaseClient";

// Reads the pick_inbox staging table — picks extracted from tweets/screenshots
// by the ingest-pick edge function, waiting to be reviewed.
//
// These go straight through the authenticated supabase client rather than
// storage.js, which only accepts the "settings"/"board" keys and silently
// returns null for anything else. RLS scopes every query to the signed-in user,
// so none of these calls pass a user id.

const TABLE = "pick_inbox";
const BUCKET = "pick-inbox";

/** Pending rows, newest first. Returns [] when Supabase isn't configured. */
export async function fetchPending() {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load pick inbox", error);
    return [];
  }
  return data ?? [];
}

async function setStatus(id, status) {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.from(TABLE).update({ status }).eq("id", id);
  if (error) console.error(`Failed to mark inbox row ${status}`, error);
}

export const markAccepted = (id) => setStatus(id, "accepted");
export const markDismissed = (id) => setStatus(id, "dismissed");

/**
 * Screenshots live in a private bucket, so the review sheet needs a short-lived
 * signed URL to display one. Returns null for rows that came from a tweet URL
 * (those carry a public image_url instead).
 */
export async function signedImageUrl(path, expiresInSeconds = 3600) {
  if (!isSupabaseConfigured || !path) return null;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) {
    console.error("Failed to sign inbox image", error);
    return null;
  }
  return data?.signedUrl ?? null;
}

/**
 * Sends a tweet/post URL to the ingest-pick edge function, which extracts the
 * picks and stages them in pick_inbox.
 *
 * `functions.invoke` attaches the signed-in user's JWT, and the function
 * derives the account from it — so no shared ingest secret ships in the client
 * bundle. (The iOS Shortcut, which can't hold a session, uses a secret header
 * instead; the function accepts either.)
 *
 * Returns { ok, picks, warnings } or { ok: false, error }.
 */
export async function ingestUrl(url) {
  if (!isSupabaseConfigured) {
    return { ok: false, error: "Supabase isn't configured" };
  }
  try {
    const { data, error } = await supabase.functions.invoke("ingest-pick", {
      body: { url: url.trim() },
    });
    if (error) throw error;
    return data ?? { ok: false, error: "Empty response" };
  } catch (e) {
    console.error("Ingest failed", e);
    return { ok: false, error: e?.message || "Request failed" };
  }
}

export default { fetchPending, markAccepted, markDismissed, signedImageUrl, ingestUrl };
