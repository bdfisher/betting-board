// POST endpoint that turns a tweet or article URL into picks, returned to the
// app for review. Nothing is stored here — the app adds the ones you keep to
// the board itself. Any sport extracts; only NFL player props get the
// live-roster lookup.
//
// Called by the app's "Import from a post" field, which authenticates with the
// signed-in user's JWT. The handler verifies that JWT itself (see the auth
// block below), so it's deployed with verify_jwt disabled.

import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchImageAsBase64, parseStatusId, resolveTweet } from "./fxtwitter.ts";
import { resolveArticle } from "./article.ts";
import { type BoardGame, resolvePlayerProp } from "./espn.ts";
import { type ExtractedPick, extractPicks, type SourceRef, SPORTS } from "./extract.ts";

// Cheat-sheet posts carry 2–4 pages; this bounds a pathological one.
const MAX_IMAGES = 6;

interface RequestBody {
  url?: string;
  /** Sport chosen in the app before importing. Absent → the model decides. */
  sport?: string;
}

// The PWA calls this cross-origin (github.io → supabase.co), so every response
// needs CORS headers and OPTIONS needs its own handler. "*" is safe here
// because the function authenticates every request itself and never relies on
// cookies — a third-party page still has no JWT and gets a 401.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

/** YYYY-MM-DD in America/Chicago — matches the app's date convention. */
function centralDateISO(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
}

function shiftDays(days: number): string {
  return centralDateISO(new Date(Date.now() + days * 86_400_000));
}

/**
 * Source matching is done in code, not by the model.
 *
 * FxTwitter hands us the author handle verbatim and the source list comes
 * straight out of settings, so this is an exact string comparison — yet asking
 * the model to do it alongside reading 16 props off a graphic produced a 0/8
 * miss rate on a post whose author (@MoneyMandrell) matched a source name
 * character for character. Deterministic work belongs in deterministic code.
 *
 * Compares case-insensitively and ignores a leading @, so a source saved as
 * "@MoneyMandrell", "MoneyMandrell", or "moneymandrell" all match the post.
 */
function normalizeHandle(s: string): string {
  return s.trim().toLowerCase().replace(/^@+/, "");
}

/**
 * Looser second key, for site names: a source saved as "Covers" should match
 * og:site_name "Covers.com", and "ActionNetwork" should match "Action Network".
 * Drops a leading "the", a TLD, and everything that isn't a letter or digit.
 */
function compactName(s: string): string {
  return normalizeHandle(s)
    .replace(/^www\./, "")
    .replace(/^the\s+/, "")
    .replace(/\.(com|net|org|io|co)$/, "")
    .replace(/[^a-z0-9]/g, "");
}

function buildSourceIndex(sources: SourceRef[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const src of sources) {
    for (const n of [src.name, ...(src.handles ?? [])]) {
      if (!n) continue;
      index.set(normalizeHandle(n), src.id);
      // Exact keys win: don't let a compact form shadow another source's name.
      if (!index.has(compactName(n))) index.set(compactName(n), src.id);
    }
  }
  return index;
}

function resolveSourceId(
  index: Map<string, string>,
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const hit = index.get(normalizeHandle(c)) ?? index.get(compactName(c));
    if (hit) return hit;
  }
  return null;
}

/**
 * Pick labels use the player's last name alone ("Dobbins TD"), which is
 * unambiguous right up until one cheat sheet lists two players who share a
 * surname. Only in that case, prefix a first initial ("K. Williams o55.5 RuY")
 * — leaving every other label in the plain requested format.
 */
function disambiguateSurnames(picks: Array<Record<string, unknown>>): void {
  const playersBySurname = new Map<string, Set<string>>();
  for (const p of picks) {
    const resolved = p.resolvedPlayer as string | undefined;
    if (!resolved) continue;
    const surname = resolved.split(/\s+/).pop()!.toLowerCase();
    if (!playersBySurname.has(surname)) playersBySurname.set(surname, new Set());
    playersBySurname.get(surname)!.add(resolved);
  }

  for (const p of picks) {
    const resolved = p.resolvedPlayer as string | undefined;
    const label = p.label as string | undefined;
    if (!resolved || !label) continue;

    const surname = resolved.split(/\s+/).pop()!;
    if ((playersBySurname.get(surname.toLowerCase())?.size ?? 0) < 2) continue;

    // Only rewrite when the label actually leads with the bare surname — a
    // label already using a short form ("JSN …") is left alone.
    if (label.toLowerCase().startsWith(surname.toLowerCase() + " ")) {
      p.label = `${resolved[0]}. ${label}`;
    }
  }
}

Deno.serve(async (req: Request) => {
  // A browser preflights any cross-origin POST carrying Authorization and a
  // JSON content-type. Without this branch that preflight 405s and the request
  // is never sent, surfacing in the app as the opaque "Failed to send a request
  // to the Edge Function". curl doesn't preflight, which is why only a real
  // device caught it.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- auth ----------------------------------------------------------------
  // Derive the user from the signed-in session's JWT — no shared secret ships
  // in the client bundle, and the board read below is whichever account is
  // signed in.
  let userId: string | null = null;

  const authz = req.headers.get("Authorization");
  if (authz?.startsWith("Bearer ")) {
    const { data } = await supabase.auth.getUser(authz.slice(7));
    userId = data?.user?.id ?? null;
  }

  if (!userId) return json({ error: "Unauthorized" }, 401);

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  if (!body.url) return json({ error: "Provide a url" }, 400);

  // What the review sheet shows: the post itself plus what was extracted.
  const post = {
    source_url: body.url,
    raw_text: null as string | null,
    image_url: null as string | null,
    author_handle: null as string | null,
    error: null as string | null,
    extracted: null as unknown,
  };

  try {
    const images: Array<{ data: string; mimeType: string }> = [];
    const extraWarnings: string[] = [];
    let article: {
      site: string | null;
      hostLabel: string | null;
      title: string | null;
      publishedAt: string | null;
      url: string;
    } | null = null;

    // ---- 1. resolve the input ----------------------------------------------
    // Anything that isn't an X permalink is treated as an article.
    if (!parseStatusId(body.url)) {
      const a = await resolveArticle(body.url);
      article = { site: a.siteName, hostLabel: a.hostLabel, title: a.title, publishedAt: a.publishedAt, url: a.permalink };
      // Title first: the review sheet shows the opening lines of raw_text.
      post.raw_text = a.text ? [a.title, a.text].filter(Boolean).join("\n\n") : null;
      post.author_handle = a.siteName;
      post.source_url = a.permalink;
      if (a.error) post.error = a.error;

      // Sharing last week's article by mistake is easy, and its players are
      // probably on this week's board too — so the picks would look plausible.
      const published = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
      if (Number.isFinite(published) && Date.now() - published > 6 * 86_400_000) {
        extraWarnings.push(
          `Article was published ${centralDateISO(new Date(published))} — make sure these are this week's picks.`,
        );
      }
    } else {
      const tweet = await resolveTweet(body.url);
      post.raw_text = tweet.text;
      post.author_handle = tweet.authorHandle;
      post.image_url = tweet.imageUrl;
      post.source_url = tweet.permalink ?? body.url;
      if (tweet.error) post.error = tweet.error;

      // Cheat sheets come as a 2–4 image carousel, so pull them all. Capped so
      // a pathological post can't blow up the request; the cap is surfaced as a
      // warning rather than silently dropping pages.
      const urls = tweet.imageUrls.slice(0, MAX_IMAGES);
      if (tweet.imageUrls.length > MAX_IMAGES) {
        extraWarnings.push(
          `Post had ${tweet.imageUrls.length} images; only the first ${MAX_IMAGES} were read.`,
        );
      }
      for (const u of urls) {
        const img = await fetchImageAsBase64(u);
        if (img) images.push(img);
      }
    }

    // Nothing to read at all — bail rather than burning a model call on an
    // empty prompt.
    if (!post.raw_text && images.length === 0) {
      return json({ ok: false, picks: 0, error: post.error ?? "Nothing to extract — no text and no readable image" });
    }

    // ---- 2. board context ---------------------------------------------------
    const { data: board } = await supabase
      .from("boards")
      .select("settings, board")
      .eq("id", userId)
      .maybeSingle();

    const settings = typeof board?.settings === "string"
      ? JSON.parse(board.settings)
      : board?.settings ?? {};
    const boardData = typeof board?.board === "string"
      ? JSON.parse(board.board)
      : board?.board ?? {};

    const sources: SourceRef[] = (settings.sources ?? []).map(
      (s: { id: string; name: string; handles?: string[] }) => ({
        id: s.id,
        name: s.name,
        handles: s.handles,
      }),
    );

    const sourceIndex = buildSourceIndex(sources);

    // NFL week runs Thu–Mon and people tweet Sunday picks midweek, so the
    // window is a week-plus rather than a couple of days. Every sport on the
    // board goes to the model — a college football roundup needs the NCAAF
    // slate to match against, not just the NFL one.
    const from = shiftDays(-1);
    const to = shiftDays(8);
    const boardGames: BoardGame[] = (boardData.games ?? []).filter(
      (g: BoardGame) => !g.date || (g.date >= from && g.date <= to),
    );
    const nflGames = boardGames.filter((g) => g.sport === "NFL");

    // A sport chosen in the app is authoritative: it narrows the games the
    // model matches against and stamps every pick, so a college slate can't
    // drift onto an NFL game with the same city in it.
    const forcedSport = body.sport && SPORTS.includes(body.sport) ? body.sport : null;
    const candidateGames = forcedSport
      ? boardGames.filter((g) => g.sport === forcedSport)
      : boardGames;
    const gamesById = new Map(boardGames.map((g) => [g.id, g]));

    // ---- 3. extract ---------------------------------------------------------
    const { extraction } = await extractPicks({
      text: post.raw_text,
      images,
      sources,
      games: candidateGames.map((g) => ({ id: g.id, label: g.label, sport: g.sport ?? "Other", date: g.date })),
      sport: forcedSport,
      authorHandle: post.author_handle,
      article: article ?? undefined,
    });
    post.author_handle = post.author_handle ?? extraction.authorHandle;

    // An article's picks all belong to the site, whoever wrote each section.
    const articleSourceId = article
      ? resolveSourceId(sourceIndex, article.site, article.hostLabel)
      : null;

    // ---- 3b. resolve player props against live rosters -----------------------
    const picks: ExtractedPick[] = [];
    // Picks that matched no board game, by sport — one warning per sport
    // rather than one per pick.
    const unmatched = new Map<string, number>();
    for (const pick of extraction.picks) {
      // The model is told never to invent a gameId; this enforces it. A
      // matched game's sport outranks the model's read of the post.
      let game = pick.gameId ? gamesById.get(pick.gameId) : undefined;
      if (forcedSport && game?.sport !== forcedSport) game = undefined;
      const sport = forcedSport ?? game?.sport ??
        (pick.sport && SPORTS.includes(pick.sport) ? pick.sport : "NFL");
      const normalized: Record<string, unknown> = {
        ...pick,
        sport,
        strength: pick.strength ?? "normal",
        gameId: game?.id ?? null,
        // Code first; the model's guess is only a fallback for a handle it
        // read inside the graphic that FxTwitter never saw. Articles skip the
        // model entirely — a writer's byline is never the source.
        sourceId: article
          ? articleSourceId
          : resolveSourceId(sourceIndex, pick.sourceNameRaw, post.author_handle) ??
            pick.sourceId ??
            null,
        sourceNameRaw: article ? post.author_handle : pick.sourceNameRaw ?? post.author_handle ?? null,
        isPlayerProp: Boolean(pick.isPlayerProp),
      };

      if (pick.isPlayerProp && pick.playerName && sport === "NFL") {
        // statedTeam is a team read off the graphic, which disambiguates
        // surname collisions. It narrows the ESPN candidates; it never
        // substitutes for the lookup.
        const match = await resolvePlayerProp(pick.playerName, nflGames, pick.statedTeam);
        normalized.resolution = match.resolution;
        normalized.gameId = match.gameId;
        normalized.resolvedPlayer = match.player?.displayName ?? null;
        normalized.resolvedTeam = match.player?.team ?? null;
        normalized.candidates = match.candidates;

        if (match.resolution === "no-game-on-board" && match.player) {
          extraction.warnings.push(
            `${match.player.displayName} (${match.player.team}) isn't on a game on your board — import that week?`,
          );
        }
      }

      if (!normalized.gameId && !normalized.resolution) {
        unmatched.set(sport, (unmatched.get(sport) ?? 0) + 1);
      }

      picks.push(normalized as unknown as ExtractedPick);
    }

    for (const [sport, n] of unmatched) {
      extraction.warnings.push(
        `${n} ${sport} pick${n === 1 ? "" : "s"} didn't match a game on your board — autofill that ${sport} slate, then set the game on each.`,
      );
    }

    // Labels carry last names only ("Dobbins TD"), which reads fine until one
    // post has two players sharing a surname — Kyren vs Javonte Williams.
    // Where that happens, and only there, prefix a first initial.
    disambiguateSurnames(picks as unknown as Array<Record<string, unknown>>);

    // A plus-form line already means over, so "o30+ RuY" → "30+ RuY". The
    // prompt asks for this too; this catches the model slipping back to the
    // o/u habit the rest of the label rules drill in.
    for (const p of picks) {
      if (p.label) p.label = p.label.replace(/\bo(\d+(?:\.\d+)?\+)/gi, "$1");
    }

    post.extracted = {
      picks,
      warnings: [...extraWarnings, ...extraction.warnings],
      isBettingContent: extraction.isBettingContent,
    };

    return json({
      ok: true,
      picks: picks.length,
      warnings: [...extraWarnings, ...extraction.warnings],
      isBettingContent: extraction.isBettingContent,
      post,
    });
  } catch (e) {
    // 200 with ok:false, so the app shows the message rather than
    // functions.invoke's generic "non-2xx status" error.
    return json({ ok: false, picks: 0, error: e instanceof Error ? e.message : String(e) });
  }
});
