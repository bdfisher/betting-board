// POST endpoint that turns a shared post (tweet URL, screenshot, or raw text)
// into NFL picks staged in pick_inbox for review in the app.
//
// Two callers: the app's "Import from a post" field, which authenticates with
// the signed-in user's JWT, and the optional iOS Shortcut, which can't hold a
// session and uses a shared secret header against a pinned user. See the auth
// block below. Runs with verify_jwt disabled so the Shortcut path can work.

import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchImageAsBase64, resolveTweet } from "./fxtwitter.ts";
import { type BoardGame, resolvePlayerProp } from "./espn.ts";
import { type ExtractedPick, extractPicks, type SourceRef } from "./extract.ts";

const BUCKET = "pick-inbox";

// Cheat-sheet posts carry 2–4 pages; this bounds a pathological one.
const MAX_IMAGES = 6;

interface RequestBody {
  url?: string;
  image?: string; // base64, no data: prefix
  media_type?: string;
  text?: string;
}

// The PWA calls this cross-origin (github.io → supabase.co), so every response
// needs CORS headers and OPTIONS needs its own handler. "*" is safe here
// because the function authenticates every request itself and never relies on
// cookies — a third-party page still has no JWT and gets a 401.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ingest-token",
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
  // Two callers, two mechanisms:
  //
  //   1. The app itself, which has a real signed-in session. Derive the user
  //      from their JWT — that way no shared secret has to ship in the client
  //      bundle, and the row lands on whichever account is signed in.
  //   2. The iOS Shortcut, which can't hold a Supabase session. Falls back to
  //      a shared secret header and a single pinned user.
  let userId: string | null = null;

  const authz = req.headers.get("Authorization");
  if (authz?.startsWith("Bearer ")) {
    const { data } = await supabase.auth.getUser(authz.slice(7));
    userId = data?.user?.id ?? null;
  }

  if (!userId) {
    const expected = Deno.env.get("INGEST_TOKEN");
    if (expected && req.headers.get("x-ingest-token") === expected) {
      userId = Deno.env.get("INGEST_USER_ID") ?? null;
    }
  }

  if (!userId) return json({ error: "Unauthorized" }, 401);

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  if (!body.url && !body.image && !body.text) {
    return json({ error: "Provide one of: url, image, text" }, 400);
  }

  const kind = body.url ? "url" : body.image ? "image" : "text";
  const row = {
    user_id: userId,
    kind,
    status: "pending",
    source_url: body.url ?? null,
    raw_text: body.text ?? null,
    image_url: null as string | null,
    image_path: null as string | null,
    author_handle: null as string | null,
    extracted: null as unknown,
    model: null as string | null,
    error: null as string | null,
  };

  // Every exit path below still inserts a row. A pick that arrives broken is
  // one tap from manual entry; a 500 means the pick is gone.
  //
  // `insertedId` guards the error path: anything that throws *after* the row
  // already landed (a bad base64 payload reaching atob, say) must not insert a
  // second copy — it should annotate the existing row instead.
  let insertedId: string | null = null;
  const insert = async () => {
    const { data, error } = await supabase.from("pick_inbox").insert(row).select("id").single();
    if (error) throw error;
    insertedId = data.id as string;
    return insertedId;
  };

  try {
    const images: Array<{ data: string; mimeType: string }> = [];
    const extraWarnings: string[] = [];

    // ---- 1. resolve the input ----------------------------------------------
    if (body.url) {
      const tweet = await resolveTweet(body.url);
      row.raw_text = tweet.text;
      row.author_handle = tweet.authorHandle;
      row.image_url = tweet.imageUrl;
      row.source_url = tweet.permalink ?? body.url;
      if (tweet.error) row.error = tweet.error;

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

    if (body.image) {
      const mimeType = body.media_type || "image/jpeg";
      images.push({ data: body.image, mimeType });
    }

    // Nothing to read at all — store it and bail early rather than burning a
    // model call on an empty prompt.
    if (!row.raw_text && images.length === 0) {
      row.error = row.error ?? "Nothing to extract — no text and no readable image";
      const id = await insert();
      return json({ ok: false, id, picks: 0, error: row.error });
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

    // NFL week runs Thu–Mon and people tweet Sunday picks midweek, so the
    // window is a week-plus rather than a couple of days. ~16 games either way.
    const from = shiftDays(-1);
    const to = shiftDays(8);
    const nflGames: BoardGame[] = (boardData.games ?? []).filter(
      (g: BoardGame) => g.sport === "NFL" && (!g.date || (g.date >= from && g.date <= to)),
    );

    // ---- 3. extract ---------------------------------------------------------
    const { extraction, model } = await extractPicks({
      text: row.raw_text,
      images,
      sources,
      games: nflGames.map((g) => ({ id: g.id, label: g.label, date: g.date })),
      authorHandle: row.author_handle,
    });
    row.model = model;
    row.author_handle = row.author_handle ?? extraction.authorHandle;

    // ---- 3b. resolve player props against live rosters -----------------------
    const picks: ExtractedPick[] = [];
    for (const pick of extraction.picks) {
      const normalized: Record<string, unknown> = {
        ...pick,
        sport: "NFL", // hardcoded: this pipeline is NFL-only
        strength: pick.strength ?? "normal",
        gameId: pick.gameId ?? null,
        sourceId: pick.sourceId ?? null,
        sourceNameRaw: pick.sourceNameRaw ?? row.author_handle ?? null,
        isPlayerProp: Boolean(pick.isPlayerProp),
      };

      if (pick.isPlayerProp && pick.playerName) {
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

      picks.push(normalized as ExtractedPick);
    }

    // Labels carry last names only ("Dobbins TD"), which reads fine until one
    // post has two players sharing a surname — Kyren vs Javonte Williams.
    // Where that happens, and only there, prefix a first initial.
    disambiguateSurnames(picks);

    row.extracted = {
      picks,
      warnings: [...extraWarnings, ...extraction.warnings],
      isBettingContent: extraction.isBettingContent,
    };

    // ---- 4. store the screenshot, then the row ------------------------------
    const id = await insert();

    // Best-effort: the picks are already saved, so a failed upload costs the
    // review thumbnail, not the pick. Never let it take down the response.
    if (body.image) {
      try {
        const path = `${userId}/${id}.jpg`;
        const bytes = Uint8Array.from(atob(body.image), (c) => c.charCodeAt(0));
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, bytes, { contentType: body.media_type || "image/jpeg", upsert: true });
        if (!upErr) {
          await supabase.from("pick_inbox").update({ image_path: path }).eq("id", id);
        }
      } catch (e) {
        console.error("Screenshot upload failed", e);
      }
    }

    return json({
      ok: true,
      id,
      picks: picks.length,
      warnings: [...extraWarnings, ...extraction.warnings],
      isBettingContent: extraction.isBettingContent,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    row.error = [row.error, msg].filter(Boolean).join(" | ");
    try {
      if (insertedId) {
        // Row already landed — annotate it rather than inserting a duplicate.
        await supabase.from("pick_inbox").update({ error: row.error }).eq("id", insertedId);
        return json({ ok: false, id: insertedId, picks: 0, error: msg }, 200);
      }
      const id = await insert();
      return json({ ok: false, id, picks: 0, error: msg }, 200);
    } catch {
      return json({ ok: false, picks: 0, error: msg }, 500);
    }
  }
});
