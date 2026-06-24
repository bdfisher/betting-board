import { supabase, isSupabaseConfigured } from "./supabaseClient";

// The app stores two logical keys: "settings" and "board". In Supabase these
// map to the matching jsonb columns on a single row in the `boards` table,
// keyed by a per-browser board id. When Supabase isn't configured we transparently
// fall back to localStorage so the app still works offline / for local dev.

const VALID_KEYS = ["settings", "board"];
const BOARD_ID_KEY = "betboard:boardId";
const LS_PREFIX = "betboard:";

export function getBoardId() {
  let id = localStorage.getItem(BOARD_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(BOARD_ID_KEY, id);
  }
  return id;
}

export function setBoardId(id) {
  if (!id) return;
  localStorage.setItem(BOARD_ID_KEY, id.trim());
}

// localStorage helpers (also used as a cache so the UI paints instantly)
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

    if (!isSupabaseConfigured) return lsGet(key);

    try {
      const { data, error } = await supabase
        .from("boards")
        .select(key)
        .eq("id", getBoardId())
        .maybeSingle();
      if (error) throw error;
      if (data && data[key] != null) {
        const value = data[key];
        lsSet(key, value); // refresh local cache
        return { value };
      }
      // No remote row yet — fall back to any local cache.
      return lsGet(key);
    } catch (e) {
      console.error(`Supabase get("${key}") failed, using local cache`, e);
      return lsGet(key);
    }
  },

  async set(key, value) {
    if (!VALID_KEYS.includes(key)) return;

    lsSet(key, value); // always keep a local copy

    if (!isSupabaseConfigured) return;

    try {
      const { error } = await supabase
        .from("boards")
        .upsert(
          { id: getBoardId(), [key]: value, updated_at: new Date().toISOString() },
          { onConflict: "id" }
        );
      if (error) throw error;
    } catch (e) {
      console.error(`Supabase set("${key}") failed (saved locally)`, e);
    }
  },
};
