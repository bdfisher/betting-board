import { supabase, isSupabaseConfigured } from "../supabaseClient";

/**
 * Sends a tweet or article URL to the ingest-pick edge function, which extracts
 * the picks and returns them for review. Nothing is stored server-side — the
 * picks you keep reach the board through App.jsx's normal persistBoard path.
 *
 * `functions.invoke` attaches the signed-in user's JWT, and the function
 * derives the account from it — so no shared ingest secret ships in the client
 * bundle.
 *
 * `sport` is optional; when set, every extracted pick is filed under it.
 *
 * Returns { ok, picks, warnings, post } or { ok: false, error }.
 */
export async function ingestUrl(url, sport = null) {
  if (!isSupabaseConfigured) {
    return { ok: false, error: "Supabase isn't configured" };
  }
  try {
    const { data, error } = await supabase.functions.invoke("ingest-pick", {
      body: { url: url.trim(), ...(sport ? { sport } : {}) },
    });
    if (error) throw error;
    return data ?? { ok: false, error: "Empty response" };
  } catch (e) {
    console.error("Ingest failed", e);
    return { ok: false, error: e?.message || "Request failed" };
  }
}
