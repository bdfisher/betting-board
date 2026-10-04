// Gemini call: tweet text and/or image in, structured picks out.
//
// Model id is env-overridable so it can be swapped without a code change.
// Free tier covers Flash models at ~1500 requests/day, far more than this needs.

import { GoogleGenAI } from "npm:@google/genai@2.27.0";

const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash";

export interface ExtractedPick {
  label: string;
  matchup?: string | null;
  gameId?: string | null;
  sourceId?: string | null;
  sourceNameRaw?: string | null;
  strength?: "lean" | "normal" | "potd";
  units?: string | null;
  confidence?: number;
  notes?: string | null;
  isPlayerProp?: boolean;
  playerName?: string | null;
  /** Team printed on the graphic — read, never recalled. See the system prompt. */
  statedTeam?: string | null;
}

export interface Extraction {
  isBettingContent: boolean;
  authorHandle: string | null;
  picks: ExtractedPick[];
  warnings: string[];
}

export interface SourceRef {
  id: string;
  name: string;
  handles?: string[];
}

/**
 * Standard JSON Schema via `responseJsonSchema` rather than Google's OpenAPI
 * `responseSchema` — the SDK's own docs say to prefer it when the schema is
 * plain JSON Schema, and `enum` behaves predictably here.
 *
 * Only genuinely-always-present fields are `required`; the rest are allowed to
 * be omitted and get normalized to null in code. That sidesteps the nullable
 * representation question entirely.
 */
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    isBettingContent: { type: "boolean" },
    authorHandle: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description:
              'Exact format per the system prompt: "McCaffrey o89.5 RuY", "Dobbins TD", "Chiefs -3.5"',
          },
          matchup: { type: "string", description: 'Teams as written, e.g. "KC @ BUF"' },
          gameId: {
            type: "string",
            description: "Id from the supplied games list. Omit for player props.",
          },
          sourceId: { type: "string", description: "Id from the supplied sources list." },
          sourceNameRaw: { type: "string", description: "Handle/name as written in the post." },
          strength: { type: "string", enum: ["lean", "normal", "potd"] },
          units: { type: "string", description: 'Stated size if any, e.g. "2u"' },
          confidence: { type: "number" },
          notes: { type: "string" },
          isPlayerProp: { type: "boolean" },
          playerName: {
            type: "string",
            description: "Player name exactly as written. Required when isPlayerProp.",
          },
          statedTeam: {
            type: "string",
            description:
              "Team printed on the graphic next to this player, if visible. Read only — never recall.",
          },
        },
        required: ["label", "strength", "isPlayerProp", "confidence"],
      },
    },
  },
  required: ["isBettingContent", "picks", "warnings"],
};

const SYSTEM_PROMPT = `You extract NFL betting picks from social media posts for a personal bet-tracking app.

You receive a post's text and/or an image of it, plus the user's list of handicapper sources and the NFL games currently on their board. Return every distinct bet being recommended.

## What counts
Return a pick for each bet the author is recommending. A parlay is ONE pick whose label names all legs. If the post is a recap, a brag about a past result, a retweet with no new bet, or isn't about betting at all, set isBettingContent false and return an empty picks array.

This app tracks NFL only. If a post is clearly about another sport, set isBettingContent false and add a warning saying so. Do not guess at a sport.

## Cheat sheets — the common case
Most posts here are prop GRAPHICS, not text. A single post often carries 2-4 images, each a page of a cheat sheet ("Passing", "Rushing", "Receiving", "TD Scorers"), with 4-16 props per page. The post's own text is usually just promo ("Save this sheet for Sunday", a discount code) and carries no picks at all.

Extract EVERY prop you can read, across EVERY image. Twenty or more picks from one post is normal and correct. Do not summarize, sample, or stop early. If a page is too low-resolution to read reliably, add a warning saying which one rather than guessing at the numbers.

Section headers give you the stat type — a player under "RUSHING YARDS" showing "OVER 69.5" is "o69.5 RuY".

## label — follow this format exactly

Player props:  NAME  o/u+LINE  CODE

    McCaffrey o89.5 RuY
    Kittle o4.5 Rec
    Nix o220.5 PY
    Nix u0.5 INT
    JSN u100.5 ReY
    Dobbins TD

NAME — the player's LAST NAME only. "McCaffrey", "Kittle", "Nix", "Dobbins".
Use a widely-known short form instead only when the surname is hyphenated or
unusually long: Jaxon Smith-Njigba is "JSN". Do not shorten an ordinary
surname — Christian McCaffrey is "McCaffrey", never "CMC".

LINE — o or u fused to the number with no space: o89.5, u100.5. Never write
"Over", "Under", "+", or "-" here.

Anytime-touchdown props carry NO line at all. Just "Dobbins TD". Not
"Dobbins o0.5 TD".

CODE — use exactly these, nothing else:
    PY     Passing Yards           RuY    Rushing Yards
    PA     Passing Attempts        RA     Rushing Attempts
    PC     Passing Completions     Rec    Receptions
    ReY    Receiving Yards         INT    Interceptions
    PTD    Passing Touchdowns      TD     Anytime Touchdown
    LComp  Longest Completion      LRush  Longest Rush
    LRec   Longest Reception       1Q Rec First-quarter Receptions
    P&R    Rushing + Passing Yards
    R&R    Rushing + Receiving Yards

TD vs PTD: TD is the anytime-touchdown market and carries no line ("Chase TD").
PTD is a quarterback's passing-touchdown total and DOES carry one
("Hurts o1.5 PTD"). Never use TD for a passing-TD line.

A period qualifier goes in front of the code the way "1Q Rec" does — first-half
passing yards would be "1H PY".

If a prop's stat is still not covered (tackles, sacks, kicking points), write
the shortest clear abbreviation you can AND add a warning naming the stat, so a
proper code can be added later.

Keep the author's number exactly — never invent or move a half point. If the
graphic says "250+", write "o250+ PY", not "o249.5 PY".

NEVER put odds in the label.

Team and game bets keep their natural form: "Chiefs -3.5", "Bills ML",
"Bills/Chiefs u47.5".

## Player props
When a pick is about one player's statistical line, set isPlayerProp true and put the player's name in playerName EXACTLY as the post writes it ("JK Dobbins", "Dobbins", "CMC").

Then LEAVE gameId EMPTY. A separate step resolves the player against live roster data.

There is one thing you may report about teams and one you may not:
- READING is fine. Pick cards nearly always print the team above the player ("GREEN BAY PACKERS"). If you can see it, put it in statedTeam. It is decisive for telling Kyren Williams from Javonte Williams.
- RECALLING is not. If the graphic does not show a team, omit statedTeam. Never fill it from memory of who a player used to be on. Rosters change every season, what you remember is very likely stale, and a wrong team files the bet under the wrong game. Omitting it is always safe; guessing is not.

Do NOT flag a team assignment as an error in the graphic, and do not "correct" one. You cannot know current rosters — players you remember elsewhere have been traded. A real run of this prompt warned that "George Pickens listed under Dallas Cowboys" looked wrong; he plays for Dallas. Those warnings are false and they make the user distrust correct picks. Transcribe the team as printed and let the downstream lookup be the judge.

Spell the player's name as carefully as you can, letter by letter — a single wrong character can make the lookup fail.

## strength
How hard the author is banging the table on THIS bet:
- "lean"   — hedged: "lean", "small play", "slight edge", "if I had to pick"
- "normal" — a straight recommendation, the default
- "potd"   — "play of the day", "POTD", "best bet", "hammer", "max bet", "lock of the week"
Use "normal" unless the language is clearly one of the others.

## gameId and sourceId
Both must be copied from the lists provided in the user message, or omitted. Never invent an id. Match sources on name or handle — a post from "@SharpEdges" maps to a source named "Sharp Edges" or one listing that handle. If you can't confidently match, omit sourceId and put what the post said in sourceNameRaw.

For non-prop picks, match gameId by team names. Omit it if no supplied game fits.

## confidence
0 to 1, for how sure you are you read the bet correctly — not how good the bet is. Low confidence for blurry images or ambiguous phrasing.

## warnings
Note anything the user should eyeball: unreadable text, a bet you partially parsed, a sport that isn't NFL, more picks visible than you could resolve.`;

export async function extractPicks(opts: {
  text: string | null;
  images: Array<{ data: string; mimeType: string }>;
  sources: SourceRef[];
  games: Array<{ id: string; label: string; date?: string }>;
  authorHandle: string | null;
}): Promise<{ extraction: Extraction; model: string }> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });

  const context = {
    postText: opts.text ?? "(no text — read the image)",
    postAuthor: opts.authorHandle ?? "(unknown)",
    sources: opts.sources.map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.handles?.length ? { handles: s.handles } : {}),
    })),
    nflGamesOnBoard: opts.games,
  };

  const parts: Array<Record<string, unknown>> = [
    ...opts.images.map((img) => ({
      inlineData: { mimeType: img.mimeType, data: img.data },
    })),
    { text: JSON.stringify(context, null, 2) },
  ];

  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseJsonSchema: EXTRACTION_SCHEMA,
      temperature: 0, // extraction, not generation
      // A 4-page cheat sheet can yield 40+ picks; the default output cap would
      // truncate mid-array and the JSON.parse would fail.
      maxOutputTokens: 16384,
    },
  });

  const raw = res.text;
  if (!raw) throw new Error("Model returned no text");

  // responseMimeType makes malformed JSON unlikely, not impossible.
  let parsed: Extraction;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Model returned unparseable JSON: ${raw.slice(0, 300)}`);
  }

  return {
    model: MODEL,
    extraction: {
      isBettingContent: Boolean(parsed.isBettingContent),
      authorHandle: parsed.authorHandle ?? opts.authorHandle ?? null,
      picks: Array.isArray(parsed.picks) ? parsed.picks : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    },
  };
}
