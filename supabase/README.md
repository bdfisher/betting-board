# Tweet → Pick ingestion

Paste a post URL into the Add tab (or share one from your phone); the picks show
up in the app's Inbox waiting for approval.

```
Add tab "Import from a post"   ·or·   iOS Share Sheet (optional)
      │  POST — session JWT, or x-ingest-token for the Shortcut
      ▼
Edge Function  ingest-pick
      ├─ URL   → api.fxtwitter.com → text + media
      ├─ image → Supabase Storage + base64 to the model
      ├─ reads boards.settings (sources) + boards.board (this week's NFL games)
      ├─ Gemini → picks[]
      ├─ player props → ESPN search + roster → team → game   (code, not model)
      └─ INSERT pick_inbox (status='pending')
      ▼
App — Board tab banner → review sheet → Accept → normal persistBoard path
```

**Nothing here writes `boards.board`.** The app rewrites that whole JSON blob
from memory on every mutation and only reads it on mount, so an external writer
would be clobbered by your next tap. Picks stage in `pick_inbox` instead, and
only become board data when you accept them.

---

## Setup

### 1. Database

Paste [`migrations/20261003_pick_inbox.sql`](migrations/20261003_pick_inbox.sql)
into the Supabase dashboard → SQL Editor and run it. Creates the `pick_inbox`
table with RLS, and the private `pick-inbox` storage bucket.

### 2. Gemini API key

Get one at [aistudio.google.com](https://aistudio.google.com/apikey) — free
tier, no credit card. **Use a personal Google account, not a work one.**

Free-tier Flash limits are ~10 requests/minute and ~1,500/day, which is orders
of magnitude more than this uses. Note Google may use free-tier inputs for
training; these are public tweets, so there's nothing sensitive in them.

### 3. Secrets

Set in the dashboard → **Edge Functions → Secrets**
(`.../project/zeafyxuumutysmsdmwrd/functions/secrets`):

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | from AI Studio |
| `INGEST_TOKEN` | random string, only needed for the optional Shortcut |
| `INGEST_USER_ID` | your auth UUID (Authentication → Users) |
| `GEMINI_MODEL` | optional, overrides the default model |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

### 4. Deploy

Already deployed. To redeploy after editing the function, either use the
Supabase MCP server's `deploy_edge_function`, or the CLI:

```bash
brew install supabase/tap/supabase
supabase login && supabase link --project-ref zeafyxuumutysmsdmwrd
supabase functions deploy ingest-pick --no-verify-jwt
```

`--no-verify-jwt` is required. It does **not** make the function public: the
handler does its own auth, accepting either a signed-in user's JWT (the app) or
the `x-ingest-token` secret (the Shortcut), and rejecting everything else with
a 401. The flag only stops the platform from rejecting the Shortcut's
session-less requests before they reach that check.

### 5. Smoke test

```bash
curl -X POST https://zeafyxuumutysmsdmwrd.supabase.co/functions/v1/ingest-pick \
  -H "x-ingest-token: $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hammering Chiefs -3.5 tonight, thats my POTD"}'
```

Expect `{"ok":true,"picks":1,...}`. Import the current NFL week in the app first
(Add tab → Autofill NFL week) so there are games to match against.

### 6. iOS Shortcut (optional)

The Add tab's "Import from a post" field covers this without any setup — it
authenticates with your signed-in session, so no secret ships in the client.
Build the Shortcut only if you want one-tap sharing straight from the X app
rather than copy-link → switch app → paste.


New shortcut named **Add Pick**. In its settings turn on *Show in Share Sheet*
and set accepted types to **Text, URLs, Images**.

| # | Action | Notes |
|---|---|---|
| 1 | Get Images from Input | empty when a URL was shared |
| 2 | If *Images* has any value | |
| 3 | → Resize Image | Longest Edge, 1568 |
| 4 | → Base64 Encode | Line Breaks: **None** |
| 5 | → Dictionary | `image` = Base64 Encoded, `media_type` = `image/jpeg` |
| 6 | Otherwise | |
| 7 | → Dictionary | `url` = Shortcut Input |
| 8 | End If | |
| 9 | Get Contents of URL | see below |
| 10 | Show Notification | `Added [picks] pick(s)` |

Step 9: `POST` to
`https://zeafyxuumutysmsdmwrd.supabase.co/functions/v1/ingest-pick`,
Headers `x-ingest-token: <your token>` and `Content-Type: application/json`,
Request Body **JSON** = the Dictionary from step 5/7.

From X: tap share on a tweet → **Add Pick**. For anything else (Discord, a text
message, a tweet FxTwitter can't resolve) screenshot it and share the
screenshot — step 2 branches automatically.

---

## Label format

Player props are written as `NAME o/u+LINE CODE`:

```
McCaffrey o89.5 RuY     Kittle o4.5 Rec        Nix o220.5 PY
Nix u0.5 INT            JSN u100.5 ReY         Dobbins TD
```

Last name only; a widely-known short form replaces it when the surname is
hyphenated or long (Smith-Njigba is JSN). Anytime-TD props carry no line at
all. Odds are never captured.

| Code | Stat | Code | Stat |
|---|---|---|---|
| `PY` | Passing Yards | `RuY` | Rushing Yards |
| `PA` | Passing Attempts | `RA` | Rushing Attempts |
| `PC` | Passing Completions | `Rec` | Receptions |
| `ReY` | Receiving Yards | `INT` | Interceptions |
| `PTD` | Passing Touchdowns | `TD` | Anytime Touchdown |
| `LComp` | Longest Completion | `LRush` | Longest Rush |
| `LRec` | Longest Reception | `1Q Rec` | First-quarter Receptions |
| `P&R` | Rushing + Passing Yards | `R&R` | Rushing + Receiving Yards |

`TD` is the anytime-touchdown market and carries no line (`Chase TD`); `PTD` is
a passing-TD total and does (`Hurts o1.5 PTD`). A period qualifier prefixes the
code the way `1Q Rec` does, so first-half passing yards would be `1H PY`.

A stat with no code gets the model's best short abbreviation plus a warning, so
the gap is visible rather than silent. Add new codes to `SYSTEM_PROMPT` in
`extract.ts`.

Labels use last names alone, which collides when one sheet lists two players
sharing a surname. `disambiguateSurnames()` in `index.ts` prefixes a first
initial in exactly that case — a real run produced `J. Williams o59.5 RuY` and
`K. Williams o55.5 RuY` while leaving the other 30 labels plain.

## How player props resolve

Most prop tweets are just a name and a line: *"JK Dobbins o55.5 rushing yards"*.
Filing that on the right game means knowing Dobbins is a Bronco, and **the model
is deliberately not allowed to decide that** — he was a Raven, then a Charger,
then a Bronco in three seasons, and a model's training data is frozen. It would
answer confidently and wrongly.

So [`espn.ts`](functions/ingest-pick/espn.ts) resolves it against live data:

1. **ESPN search** → candidates with current team. Handles nicknames well
   (`CMC` → Christian McCaffrey).
2. **Filter to NFL** — one line that kills most ambiguity, since a bare "smith"
   search spans five leagues.
3. **Intersect with your board** — a candidate only counts if their team is
   actually playing in a game you've imported.
4. **Verify against the active roster** — ESPN's search indexes *retired*
   players under their last team, which creates false ambiguity. A bare
   "Dobbins" matches both J.K. (Broncos) and the long-retired Tim (Cowboys);
   only the roster check separates them.

| Outcome | What you see |
|---|---|
| one match | game filled in, with `Player → Team` shown under the pick |
| no match on board | pick arrives gameless + "import that week?" warning |
| several matches | pick arrives gameless, dropdown narrowed to the candidates |
| player not found | pick arrives gameless for manual assignment |

Every outcome still produces a reviewable row. The design preference throughout
is *arrive needing attention* over *arrive confidently wrong*.

---

## Files

| File | Role |
|---|---|
| `functions/ingest-pick/index.ts` | HTTP handler, auth, orchestration, row insert |
| `functions/ingest-pick/fxtwitter.ts` | tweet URL → text + media |
| `functions/ingest-pick/espn.ts` | player prop → team → board game |
| `functions/ingest-pick/extract.ts` | Gemini call, JSON schema, system prompt |
| `migrations/20261003_pick_inbox.sql` | table, RLS, storage bucket |
| `../src/services/inboxApi.js` | app-side reads of `pick_inbox` |
| `../src/PickInbox.jsx` | review sheet |

## Tuning extraction

The system prompt in `extract.ts` is where accuracy lives. Add real examples to
it as you hit misses — bare player props, pick-card graphics, lean vs. POTD
phrasing. Check what a given post actually produced:

```sql
select created_at, author_handle, error, jsonb_pretty(extracted)
from pick_inbox order by created_at desc limit 5;
```

To swap models without a code change: `supabase secrets set GEMINI_MODEL=...`.
