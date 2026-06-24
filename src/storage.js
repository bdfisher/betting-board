import { supabase, isSupabaseConfigured } from "./supabaseClient";

// The app stores two logical keys: "settings" and "board". In Supabase these
// map to the matching jsonb columns on a single row in the `boards` table.
//
// The row id is the signed-in user's id (from Supabase Auth), so every device
// that logs in as the same user reads/writes the same board automatically.
// When Supabase isn't configured we fall back to a local-only board so the app
// still runs offline / for local dev without a backend.

const VALID_KEYS = ["settings", "board"];
const LOCAL_ID_KEY = "betboard:localBoardId";
const LS_PREFIX = "betboard:";

// Set by AuthGate whenever the auth session changes. Null when signed out.
let activeUserId = null;
export function setActiveUserId(id) {
  activeUserId = id || null;
}

// A stable per-browser id used only in local-only (no-Supabase) mode.
function getLocalBoardId() {
  let id = localStorage.getItem(LOCAL_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(LOCAL_ID_KEY, id);
  }
  return id;
}

function getBoardId() {
  return isSupabaseConfigured ? activeUserId : getLocalBoardId();
}

// localStorage cache (also lets the UI paint instantly and seeds migration)
function lsGet(key) {
  const value = localStorage.getItem(LS_PREFIX + key);
  return value == null ? null : { value };
}
function lsSet(key, value) {
  localStorage.setItem(LS_PREFIX + key, value);
}

export const storage = {
  // Returns { value: <string> } or null, matching the shape App.jsx expects.
  async get(key) {
    if (!VALID_KEYS.includes(key)) return null;

    const id = getBoardId();
    if (!isSupabaseConfigured || !id) return lsGet(key);

    try {
      const { data, error } = await supabase
        .from("boards")
        .select(key)
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (data && data[key] != null) {
        const value = data[key];
        lsSet(key, value); // refresh local cache
        return { value };
      }
      return null; // no remote row for this user yet
    } catch (e) {
      console.error(`Supabase get("${key}") failed, using local cache`, e);
      return lsGet(key);
    }
  },

  async set(key, value) {
    if (!VALID_KEYS.includes(key)) return;

    lsSet(key, value); // always keep a local copy

    const id = getBoardId();
    if (!isSupabaseConfigured || !id) return;

    try {
      const { error } = await supabase
        .from("boards")
        .upsert(
          { id, [key]: value, updated_at: new Date().toISOString() },
          { onConflict: "id" }
        );
      if (error) throw error;
    } catch (e) {
      console.error(`Supabase set("${key}") failed (saved locally)`, e);
    }
  },
};

// One-time migration: if this browser has locally-cached board data (e.g. from
// before email login existed) and the signed-in user has no remote board yet,
// push the local data up so the user keeps their existing bets. Safe because it
// only writes when the user's remote row is empty.
export async function migrateLocalDataToUser() {
  if (!isSupabaseConfigured || !activeUserId) return;
  for (const key of VALID_KEYS) {
    const local = lsGet(key);
    if (!local) continue;
    try {
      const { data, error } = await supabase
        .from("boards")
        .select(key)
        .eq("id", activeUserId)
        .maybeSingle();
      if (error) throw error;
      const remoteEmpty = !data || data[key] == null;
      if (remoteEmpty) {
        await supabase
          .from("boards")
          .upsert(
            { id: activeUserId, [key]: local.value, updated_at: new Date().toISOString() },
            { onConflict: "id" }
          );
      }
    } catch (e) {
      console.error(`Migration of "${key}" failed`, e);
    }
  }
}
