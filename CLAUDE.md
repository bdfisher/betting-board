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
  AuthGate.jsx     — Supabase magic-link auth wrapper (skipped when Supabase not configured)
  storage.js       — get/set wrapper over Supabase + localStorage fallback
  supabaseClient.js — creates Supabase client from env vars; exports isSupabaseConfigured
  services/
    sportsApi.js   — ESPN API wrapper (getEventsByDate, getNflWeekEvents, parseEspnEvent)
  index.css        — Tailwind base + minor globals
```

---

## Data Model

All data lives in two logical keys persisted via `storage.js`:

### `"settings"` key
```json
{
  "sources": [{ "id": "...", "name": "...", "tiers": { "NFL": "A", "NBA": "B" } }],
  "unitValue": "100"
}
```

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
  sources: [{ sourceId }],
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

Each pick gets a 0–100 confidence score → maps to a unit size recommendation.

| Tier | Weight |
|---|---|
| A (Sharp) | 60 pts |
| B (Solid) | 35 pts |
| C (Long shot) | 15 pts |

Star bonus: +20 pts. Cap: 100 pts.

| Score | Decision |
|---|---|
| ≥85 with 2+ A sources | 2u |
| ≥85 otherwise | 1.5u |
| ≥70 | 1u |
| ≥55 | 0.5u |
| <55 | Pass |

---

## Tabs

| Tab key | Description |
|---|---|
| `"board"` | Read-only view of all picks grouped by sport → game. Shows score badge + unit recommendation. |
| `"add"` | Add flow: pick a sport → pick or create a game → type the pick text → select sources → submit. |
| `"setup"` | Manage sources (name + per-sport tier), set unit dollar value, import/export board JSON. |

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

---

## Deployment

GitHub Pages via `vite build`. The `base: '/betting-board/'` in `vite.config.js` must match the repo name exactly.

---

## Key Conventions

- **Dracula palette**: background `#282a36`, surface `#343746` / `#21222c`, border `#44475a`, comment `#6272a4`, purple `#bd93f9`, green `#50fa7b`, red `#ff5555`, cyan `#8be9fd`.
- **Central timezone** (`America/Chicago`) for all display times. `Intl.DateTimeFormat` with `en-CA` locale gives `YYYY-MM-DD` format.
- **`uid()`** generates IDs: `` `${Date.now()}_${Math.random().toString(36).slice(2,8)}` ``
- **No test suite** — verify UI changes in the browser against the running dev server.
- **Single-component architecture** — all app logic lives in `App.jsx`. Avoid splitting unless the user asks.
