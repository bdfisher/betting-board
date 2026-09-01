const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

// ESPN sport/league path segments. Keys match the app's LEAGUES values exactly.
// "Other" has no endpoint — it's manual-only.
const SPORT_ENDPOINT = {
  NFL:                "football/nfl",
  NCAAF:              "football/college-football",
  NCAAB:              "basketball/mens-college-basketball",
  NHL:                "hockey/nhl",
  NBA:                "basketball/nba",
  MLS:                "soccer/usa.1",
  EPL:                "soccer/eng.1",
  "Champions League": "soccer/uefa.champions",
  MLB:                "baseball/mlb",
};

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

// ESPN dates param format: YYYYMMDD
function toEspnDate(isoDate) {
  return isoDate.replace(/-/g, "");
}

// Pull a normalized odds snapshot out of an ESPN competition, or null.
// ESPN only populates competition.odds for scheduled (pre-game) events, so this
// returns null once a game is live/final — callers should keep the last snapshot.
function parseOdds(comp) {
  const o = (comp.odds || [])[0];
  if (!o) return null;
  const favorite = o.homeTeamOdds?.favorite ? "home"
                 : o.awayTeamOdds?.favorite ? "away"
                 : null;
  // Favorite's spread — prefer the explicit per-side line, fall back to top-level.
  const favLine = favorite === "home" ? o.pointSpread?.home?.close?.line ?? o.pointSpread?.home?.open?.line
                : favorite === "away" ? o.pointSpread?.away?.close?.line ?? o.pointSpread?.away?.open?.line
                : null;
  let spread = favLine != null ? parseFloat(favLine)
             : typeof o.spread === "number" ? o.spread
             : null;
  if (Number.isNaN(spread)) spread = null;
  const homeML = o.moneyline?.home?.close?.odds ?? o.moneyline?.home?.open?.odds ?? null;
  const awayML = o.moneyline?.away?.close?.odds ?? o.moneyline?.away?.open?.odds ?? null;
  if (favorite == null && homeML == null && awayML == null) return null;
  return { provider: o.provider?.name || null, favorite, spread, homeML, awayML };
}

// Extract home/away/date/odds from an ESPN event object
export function parseEspnEvent(event) {
  const comp = (event.competitions || [])[0] || {};
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  // shortDisplayName is the mascot/school-only form: "Seahawks", "Alabama", "England"
  // (vs. displayName's "Seattle Seahawks"). Fall back progressively if it's missing.
  const teamName = (t) => t?.shortDisplayName || t?.name || t?.displayName || "";
  return {
    id:     event.id,
    home:   teamName(home?.team),
    away:   teamName(away?.team),
    date:   event.date || "", // UTC ISO with Z — safe to pass to new Date()
    venue:  comp.venue?.fullName || "",
    status: comp.status?.type?.description || "",
    odds:   parseOdds(comp),
  };
}

// Returns raw ESPN events for a sport on a given local date (YYYY-MM-DD).
// ESPN's dates= param buckets by venue local date, so no dual-fetch needed.
export async function getEventsByDate(sport, dateISO) {
  const endpoint = SPORT_ENDPOINT[sport];
  if (!endpoint) return [];
  const data = await fetchJson(`${ESPN_BASE}/${endpoint}/scoreboard?dates=${toEspnDate(dateISO)}`);
  return data.events || [];
}

// Returns the current/upcoming NFL week's events (ESPN defaults to the active week).
export async function getNflWeekEvents() {
  const data = await fetchJson(`${ESPN_BASE}/football/nfl/scoreboard`);
  return data.events || [];
}

// Returns the current college-football week's Top-25 slate (ESPN's default
// scoreboard). Mirrors the NFL week behavior; add any other games manually.
export async function getCfbWeekEvents() {
  const data = await fetchJson(`${ESPN_BASE}/football/college-football/scoreboard`);
  return data.events || [];
}

export default { getEventsByDate, getNflWeekEvents, getCfbWeekEvents, parseEspnEvent };
