# Betting Board — Project Guide

A personal sports betting tracker. The user logs picks, tracks sources (handicappers/analysts), and gets a confidence-weighted sizing recommendation per pick. It's a mobile-first PWA deployed on GitHub Pages.

---

## Stack

| Layer | Tech |
|---|---|
| UI | React 18, Tailwind CSS (Dracula color palette) |
| Build | Vite — base path `/betting-board/` (matches GitHub Pages repo name) |
| Backend | Supabase — required for auth and cross-device sync |
| Icons | lucide-react |
| Sports data | ESPN public API (no key required) |

Dev server: `npm run dev` → `http://localhost:5173/betting-board/`

---

## File Map

```
src/
  App.jsx          — entire app UI and state (single-component architecture)
  AddPick.jsx      — ESPN autofill component rendered inside App's "Add" tab
  PickInbox.jsx    — review sheet for picks shared in from X (see Pick Ingestion)
  AuthGate.jsx     — Supabase magic-link auth wrapper (skipped when Supabase not configured)
  storage.js       — get/set wrapper over Supabase + localStorage fallback
  supabaseClient.js — creates Supabase client from env vars; exports isSupabaseConfigured
  services/
    sportsApi.js   — ESPN API wrapper (getEventsByDate, getNflWeekEvents, parseEspnEvent)
    inboxApi.js    — reads/updates the pick_inbox staging table
  index.css        — Tailwind base + minor globals

supabase/
  README.md        — ingestion setup: deploy, secrets, iOS Shortcut
  migrations/      — pick_inbox table + storage bucket
  functions/ingest-pick/
    index.ts       — HTTP handler (Deno), auth, orchestration
    fxtwitter.ts   — tweet URL → text + media
    espn.ts        — player prop → current team → board game
    extract.ts     — Gemini call, JSON schema, system prompt
```

---

## Data Model

All data lives in two logical keys persisted via `storage.js`:

### `"settings"` key
```json
{
  "sources": [{ "id": "...", "name": "...", "tiers": { "NFL": "A", "NBA": "B" } }],
  "unitValue": "100",
  "books": [{ "id": "...", "name": "...", "color": "#bd93f9" }],
  "promoTypes": []
}
```

`promoTypes` is vestigial — the promo-type feature was removed from the UI, but whatever list is already stored is read into a ref and written back untouched so the data isn't destroyed.

### `"board"` key
```json
{
  "games": [ game, ... ],
  "picks": [ pick, ... ]
}
```

### Game object
```js
{
  id, label, sport, home, away,
  date,      // "YYYY-MM-DD" in Central time
  gameTime,  // display string e.g. "7:30 PM"
  notes,     // optional free-text scouting notes (injuries, matchup stats); absent when empty
  createdAt,
  raw: { idEvent }  // ESPN event id (autofill only)
}
```
- `label` is always `"Away @ Home"` for autofill games.
- Manual games set `label` from user input; `home`/`away` may be absent.

### Pick object
```js
{
  id, gameId, label,    // label is the free-text pick e.g. "Chiefs -3.5"
  // strength is omitted for a normal play; "lean" or "potd" scale that source's edge
  sources: [{ sourceId, dateAdded, strength }],
  star,      // boolean — boosts confidence score
  placed,    // boolean — bet has been placed
  result,    // null | "win" | "loss" | "push"
  createdAt
}
```

### Source object
```js
{
  id, name,
  tiers: { NFL: "A", NBA: "B", ... }  // per-sport tier override; falls back to global tier
}
```

---

## Scoring System

Each pick gets an **edge** → maps to a unit size recommendation. All constants live at the top of `App.jsx`.

Each source contributes its tier edge:

| Tier | Edge |
|---|---|
| A (Sharp) | 9 |
| B (Solid) | 4.5 |
| C (Long shot) | 1.5 |

That edge is then scaled by how hard the source is on this specific play (`STRENGTH_MULT`) — a source can be a lean on one pick and their POTD on another:

| Strength | Multiplier | Stored as |
|---|---|---|
| Lean | ×0.75 | `strength: "lean"` |
| Play (default) | ×1 | key absent |
| POTD | ×1.4 | `strength: "potd"` |

Multiple sources give **diminishing returns**: edges are sorted strongest-first and each additional one counts `SOURCE_DECAY` (0.6) of the previous. Personal star adds a flat `STAR_EDGE` (+4) on top.

| Edge | Decision |
|---|---|
| ≥17.5 | 2u |
| ≥14 | 1.5u |
| ≥11 | 1u |
| ≥7.5 | 0.5u |
| <7.5 | Pass |

Anchor cases the thresholds are tuned to: 1 A = 9.0 (0.5u), 1 A + 1 B = 11.7 (1u), 2 A = 14.4 (1.5u), 3 A = 17.6 (2u), 2 A + star = 18.4 (2u).

Ladder rungs scale off the anchor pick's size, each capped at `LADDER_RUNG_DECAY` (55%) of the one above.

---

## Tabs

| Tab key | Description |
|---|---|
| `"board"` | Read-only view of all picks grouped by sport → game. Shows score badge + unit recommendation. |
| `"add"` | Add flow: pick a sport → pick or create a game → type the pick text → select sources → submit. |
| `"setup"` | Manage sources (name + per-sport tier) and sportsbooks, set unit dollar value, import/export board JSON. |
| `"promos"` | Name + Book table of sportsbook promos, grouped All / By Book. |

---

## ESPN API (`src/services/sportsApi.js`)

Base URL: `https://site.api.espn.com/apis/site/v2/sports`

No API key. All calls are unauthenticated GET requests.

### Endpoints by sport

| Sport constant | ESPN path |
|---|---|
| NFL | `football/nfl/scoreboard` |
| MLB | `baseball/mlb/scoreboard` |
| NBA | `basketball/nba/scoreboard` |
| NHL | `hockey/nhl/scoreboard` |
| NCAAF | `football/college-football/scoreboard` |
| NCAAB | `basketball/mens-college-basketball/scoreboard` |
| Golf | `golf/pga/scoreboard` |
| Soccer | parallel: `soccer/usa.1` (MLS) + `soccer/fifa.world` (World Cup) |

### Date filtering

`?dates=YYYYMMDD` — ESPN buckets events by **venue local date**, not UTC. No dual-fetch needed; passing today's Central date returns all of today's games including late evening ones.

### NFL week

`/football/nfl/scoreboard` with no params returns the current/active week automatically.

### Event shape (raw ESPN)
```js
{
  id: "...",
  date: "2026-09-10T00:20Z",   // UTC ISO, always has Z
  name: "Patriots at Seahawks",
  competitions: [{
    competitors: [
      { homeAway: "home", team: { displayName: "Seattle Seahawks", abbreviation: "SEA" } },
      { homeAway: "away", team: { displayName: "New England Patriots", ... } }
    ],
    venue: { fullName: "Lumen Field" },
    status: { type: { description: "Scheduled" } }
  }]
}
```

`parseEspnEvent(event)` extracts `{ id, home, away, date, venue, status }`.

---

## Autofill Component (`src/AddPick.jsx`)

Rendered inside the Add tab. Props: `selectedSport`, `onImportGames(games[])`.

- **NFL**: "Autofill NFL week" button — fetches the current ESPN week.
- **Other sports**: "Today" / "Tomorrow" buttons — fetches by Central date.
- **Soccer**: fetches MLS + World Cup in parallel, merges results.
- Preview list shows all fetched games with checkboxes. All start checked. User deselects games already played before importing.
- "Import N games" button calls `onImportGames` with only the selected games.
- Results cached in `localStorage` under `betboard:espn_cache:` with a 1-hour TTL.

In `App.jsx`, `importGamesFromApi(newGames)` deduplicates by `sport + label` before appending to the board.

---

## Pick Ingestion (share a tweet → Inbox)

An iOS Shortcut shares a tweet URL or screenshot to a Supabase Edge Function, which extracts the pick(s) and stages them for review. **NFL only.** Full setup in [`supabase/README.md`](supabase/README.md).

**The architectural constraint:** nothing in this pipeline writes `boards.board`. `persistBoard` rewrites that entire blob from in-memory state on every mutation and the app only reads it on mount, so an external writer would be silently clobbered by the next tap. Extracted picks land in a separate `pick_inbox` table; they only become board data when you tap Accept, which runs them through `acceptInboxPicks` → the normal `persistBoard` path.

**Player props are resolved in code, never by the model.** Rosters churn (J.K. Dobbins: Ravens → Chargers → Broncos in three seasons) and training data is frozen, so a model will name a stale team with full confidence. `espn.ts` instead: searches ESPN for the name → filters to `defaultLeagueSlug === "nfl"` → intersects against games on the board → verifies the player is on that team's **current roster** (ESPN's search indexes retired players under their last team, which otherwise creates false ambiguity). Anything it can't resolve to exactly one player arrives gameless with a warning rather than guessed at.

The model's job is narrow: read the post, output `playerName` as written, the side, line, stat, and `strength` (`lean`/`normal`/`potd`). It never infers a team and never invents a `gameId` or `sourceId`.

Extraction accuracy lives in the system prompt in `extract.ts` — add real examples there as misses turn up.

---

## Storage (`src/storage.js`)

`storage.get(key)` / `storage.set(key, value)` — **only accepts `"settings"` or `"board"`**. Any other key silently returns null. Do not try to use this for custom cache keys; use `localStorage` directly (as `AddPick.jsx` does).

Data is stored in a Supabase `boards` table — one row per user, with `settings` and `board` jsonb columns. The signed-in user's auth UUID is the row id, enabling cross-device sync. On Supabase failure it falls back to `localStorage` as a safety net, but Supabase is required for the app to function properly.

---

## Auth (`src/AuthGate.jsx`)

Magic-link email auth via Supabase. Wraps the entire app — users must be signed in to use it.

On first login, `migrateLocalDataToUser()` pushes any existing local board up to Supabase so the user keeps their data.

## Environment Variables

Supabase credentials are required. Variable names are in `.env.example` at the repo root:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxxxxxxxxxxxxx
```

- **Local dev**: create a `.env` file at the repo root with the real values (it is gitignored — never committed).
- **GitHub Pages deployment**: add the same two vars as repository Secrets under Settings → Secrets → Actions.

Get the values from Supabase dashboard → Project Settings → API Keys.

The `ingest-pick` Edge Function has its own separate secrets (`GEMINI_API_KEY`, `INGEST_TOKEN`, `INGEST_USER_ID`, optional `GEMINI_MODEL`), set with `supabase secrets set` rather than in `.env` — they are server-side only and must never reach the client bundle. See [`supabase/README.md`](supabase/README.md).

---

## Deployment

GitHub Pages via `vite build`. The `base: '/betting-board/'` in `vite.config.js` must match the repo name exactly.

### Workflows (`.github/workflows/`)

| File | Trigger | Purpose |
|---|---|---|
| `deploy.yml` | push to `main`, manual | Build and publish to GitHub Pages. |
| `keep-supabase-awake.yml` | daily cron, manual | Reads one row from `boards` so Supabase doesn't pause the free-tier project for inactivity (it pauses after ~7 days idle). |

Both use the `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` repo secrets. Note that GitHub disables scheduled workflows in a repo with no commits for 60 days — if that happens, re-enable the keep-alive from the Actions tab.

---

## Key Conventions

- **Dracula palette**: background `#282a36`, surface `#343746` / `#21222c`, border `#44475a`, comment `#6272a4`, purple `#bd93f9`, green `#50fa7b`, red `#ff5555`, cyan `#8be9fd`.
- **Central timezone** (`America/Chicago`) for all display times. `Intl.DateTimeFormat` with `en-CA` locale gives `YYYY-MM-DD` format.
- **`uid()`** generates IDs: `` `${Date.now()}_${Math.random().toString(36).slice(2,8)}` ``
- **No test suite** — verify UI changes in the browser against the running dev server.
- **Single-component architecture** — all app logic lives in `App.jsx`. Avoid splitting unless the user asks.
