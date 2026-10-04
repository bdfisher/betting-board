// Resolves a player-prop pick ("JK Dobbins o55.5 rushing yards") to a game on
// the board.
//
// This is deliberately NOT the model's job. Rosters churn constantly — Dobbins
// was a Raven, then a Charger, then a Bronco in three seasons — and a model's
// training data is frozen, so it will answer with a stale team and total
// confidence. ESPN returns current affiliation, so we look it up live and let
// the model only read the name off the post.
//
// Two ESPN endpoints, both unauthenticated GETs like the rest of the app:
//   1. search  — fuzzy name → candidates with current team. Handles nicknames
//                well ("CMC" finds Christian McCaffrey), but indexes retired
//                players under their last team, which creates false ambiguity.
//   2. roster  — the active roster for a team, used to drop those retirees.
//                Verified: "Dobbins" matches both J.K. (Broncos) and the
//                long-retired Tim (Cowboys) in search, and only the roster
//                check separates them.

const SEARCH_URL = "https://site.web.api.espn.com/apis/search/v2";
const NFL_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const TIMEOUT_MS = 8000;

export type Resolution = "matched" | "no-game-on-board" | "ambiguous" | "not-found";

export interface BoardGame {
  id: string;
  label: string;
  home?: string;
  away?: string;
  date?: string;
  sport?: string;
}

export interface PlayerCandidate {
  displayName: string; // "J.K. Dobbins"
  team: string; // "Denver Broncos"
}

export interface PlayerMatch {
  resolution: Resolution;
  player: PlayerCandidate | null;
  gameId: string | null;
  /** Populated when `resolution` is "ambiguous" so the review UI can offer a picker. */
  candidates: Array<{ player: PlayerCandidate; gameId: string }>;
}

const NOT_FOUND: PlayerMatch = {
  resolution: "not-found",
  player: null,
  gameId: null,
  candidates: [],
};

// Module scope so warm function instances reuse these across invocations.
// Rosters change slowly; a cold start re-fetches, which is often enough.
let teamAbbrByName: Map<string, string> | null = null;
const rosterCache = new Map<string, Set<string>>();

async function getJson(url: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // undocumented endpoints — degrade, never throw
  } finally {
    clearTimeout(timer);
  }
}

/** "J.K. Dobbins" and "JK Dobbins" must compare equal. */
function normalizeName(n: string): string {
  return n.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Maps a team's full display name ("Denver Broncos") to its slug ("DEN"). */
async function getTeamAbbr(teamDisplayName: string): Promise<string | null> {
  if (!teamAbbrByName) {
    const data = await getJson(`${NFL_BASE}/teams`) as {
      sports?: Array<{ leagues?: Array<{ teams?: Array<{ team?: Record<string, string> }> }> }>;
    } | null;
    const teams = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
    if (!teams.length) return null;

    teamAbbrByName = new Map();
    for (const { team } of teams) {
      if (team?.displayName && team?.abbreviation) {
        teamAbbrByName.set(team.displayName.toLowerCase(), team.abbreviation);
      }
    }
  }
  return teamAbbrByName.get(teamDisplayName.toLowerCase()) ?? null;
}

/** Current active roster for a team, as a set of normalized names. */
async function getRoster(teamDisplayName: string): Promise<Set<string> | null> {
  const abbr = await getTeamAbbr(teamDisplayName);
  if (!abbr) return null;

  const cached = rosterCache.get(abbr);
  if (cached) return cached;

  const data = await getJson(`${NFL_BASE}/teams/${abbr}/roster`) as {
    athletes?: Array<{ items?: Array<Record<string, string>> }>;
  } | null;
  if (!data?.athletes) return null;

  // `athletes` comes back grouped by position ({ position, items: [...] }) but
  // has been a flat array in other ESPN responses — handle both.
  const names = data.athletes
    .flatMap((g) => (Array.isArray(g?.items) ? g.items : [g as Record<string, string>]))
    .map((a) => a?.displayName ?? a?.fullName)
    .filter(Boolean) as string[];
  if (!names.length) return null;

  const set = new Set(names.map(normalizeName));
  rosterCache.set(abbr, set);
  return set;
}

async function searchNflPlayers(query: string): Promise<PlayerCandidate[]> {
  const url = `${SEARCH_URL}?query=${encodeURIComponent(query)}&limit=10&type=player`;
  const body = await getJson(url) as {
    results?: Array<{ type?: string; contents?: Array<Record<string, string>> }>;
  } | null;

  return (body?.results ?? [])
    .filter((g) => g?.type === "player")
    .flatMap((g) => g.contents ?? [])
    .filter((c) =>
      // NFL-only pipeline: this single filter kills most ambiguity for free.
      // A bare search for "smith" spans five leagues; four vanish here.
      c?.defaultLeagueSlug === "nfl" && Boolean(c?.subtitle)
    )
    .map((c) => ({ displayName: c.displayName ?? query, team: c.subtitle }));
}

/**
 * The board stores ESPN `shortDisplayName` ("Broncos") while search returns the
 * full name ("Denver Broncos"), so a substring test bridges them. All 32 NFL
 * mascot names are distinct, so there's nothing to collide with.
 */
function teamPlaysInGame(team: string, game: BoardGame): boolean {
  const t = team.toLowerCase();
  const sides = [game.home, game.away].filter(Boolean) as string[];

  if (sides.length) return sides.some((s) => t.includes(s.toLowerCase()));

  // Manually-created games may have no home/away — fall back to the label,
  // checking each mascot word against it rather than the whole full name.
  const label = (game.label || "").toLowerCase();
  return team.split(/\s+/).some((w) => w.length > 3 && label.includes(w.toLowerCase()));
}

/**
 * `statedTeam` is a team the model could literally READ off the graphic (pick
 * cards almost always print "GREEN BAY PACKERS" above the player). That's
 * evidence, not recall, so it's safe to use — and it's decisive for surname
 * collisions like Kyren Williams (Rams) vs Javonte Williams (Cowboys).
 *
 * It filters candidates; it never replaces the ESPN lookup. If the stated team
 * matches nothing (the graphic is stale, or it was misread), we fall back to
 * the unfiltered set rather than reporting a false not-found.
 */
export async function resolvePlayerProp(
  playerName: string,
  games: BoardGame[],
  statedTeam?: string | null,
): Promise<PlayerMatch> {
  if (!playerName?.trim()) return NOT_FOUND;

  let all = await searchNflPlayers(playerName.trim());

  // OCR off a graphic misreads first names more often than surnames — a real
  // run produced "Jaxson Smith-Njigba" for Jaxon, and the exact search found
  // nothing. Retry on the surname alone, which survives that kind of typo.
  // Safe because the statedTeam filter, board intersection, and roster check
  // below all still have to agree before anything resolves.
  if (!all.length) {
    const surname = playerName.trim().split(/\s+/).pop() ?? "";
    if (surname.length > 2 && surname.toLowerCase() !== playerName.trim().toLowerCase()) {
      all = await searchNflPlayers(surname);
    }
  }
  if (!all.length) return NOT_FOUND;

  let candidates = all;
  if (statedTeam?.trim()) {
    const stated = statedTeam.toLowerCase().trim();
    const narrowed = all.filter((c) => {
      const t = c.team.toLowerCase();
      // Either direction: "Packers" ⊂ "Green Bay Packers", and a full
      // "Green Bay Packers" from the card matches the same string back.
      return t.includes(stated) || stated.includes(t) ||
        t.split(/\s+/).some((w) => w.length > 3 && stated.includes(w));
    });
    if (narrowed.length) candidates = narrowed;
  }

  // Intersect against the board first — it's free, and it's what makes the
  // match trustworthy: it collapses "Smith" to the Smiths on tonight's slate.
  const hits: Array<{ player: PlayerCandidate; gameId: string }> = [];
  for (const player of candidates) {
    const game = games.find((g) => teamPlaysInGame(player.team, g));
    if (game) hits.push({ player, gameId: game.id });
  }

  if (!hits.length) {
    // Player exists but isn't on the imported slate — bye week, or the week
    // hasn't been autofilled. Keep the identity so the UI can say which team.
    return {
      resolution: "no-game-on-board",
      player: candidates[0],
      gameId: null,
      candidates: [],
    };
  }

  // Drop anyone not on their team's current roster. This is what separates
  // J.K. Dobbins (Broncos, active) from Tim Dobbins (Cowboys, retired).
  const verified: typeof hits = [];
  let rosterChecksWorked = false;
  for (const hit of hits) {
    const roster = await getRoster(hit.player.team);
    if (!roster) continue; // endpoint failed — can't judge this one
    rosterChecksWorked = true;
    if (roster.has(normalizeName(hit.player.displayName))) verified.push(hit);
  }

  // If ESPN's roster endpoint is down or returned nothing usable, fall back to
  // the unverified hits rather than reporting a false "not-found".
  const final = rosterChecksWorked && verified.length ? verified : hits;

  if (final.length === 1) {
    return {
      resolution: "matched",
      player: final[0].player,
      gameId: final[0].gameId,
      candidates: [],
    };
  }

  return {
    resolution: "ambiguous",
    player: null,
    gameId: null,
    candidates: final,
  };
}
