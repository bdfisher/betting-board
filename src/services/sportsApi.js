const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

// ESPN sport/league path segments
const SPORT_ENDPOINT = {
  NFL:   "football/nfl",
  MLB:   "baseball/mlb",
  NBA:   "basketball/nba",
  NHL:   "hockey/nhl",
  NCAAF: "football/college-football",
  NCAAB: "basketball/mens-college-basketball",
  Golf:  "golf/pga",
  // Soccer is multi-league — see SOCCER_ENDPOINTS below
};

// Fetched in parallel and merged for the Soccer sport
const SOCCER_ENDPOINTS = [
  "soccer/usa.1",      // MLS
  "soccer/fifa.world", // FIFA World Cup
];

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
  const espnDate = toEspnDate(dateISO);

  if (sport === "Soccer") {
    const results = await Promise.all(
      SOCCER_ENDPOINTS.map((path) =>
        fetchJson(`${ESPN_BASE}/${path}/scoreboard?dates=${espnDate}`)
          .then((d) => d.events || [])
          .catch(() => [])
      )
    );
    return results.flat();
  }

  const endpoint = SPORT_ENDPOINT[sport];
  if (!endpoint) return [];
  const data = await fetchJson(`${ESPN_BASE}/${endpoint}/scoreboard?dates=${espnDate}`);
  return data.events || [];
}

// Returns the current/upcoming NFL week's events (ESPN defaults to the active week).
export async function getNflWeekEvents() {
  const data = await fetchJson(`${ESPN_BASE}/football/nfl/scoreboard`);
  return data.events || [];
}

export default { getEventsByDate, getNflWeekEvents, parseEspnEvent };
