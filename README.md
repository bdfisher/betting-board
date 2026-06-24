# Bet Board

Your personal sports betting note-taking and pick-scoring tool.

---

## Setup (one time, ~15 minutes)

### 1. Create a Supabase project (free)

1. Go to [supabase.com](https://supabase.com) and sign up for free
2. Click **New project**, give it a name (e.g. `bet-board`), set a password, pick a region close to you
3. Wait ~2 minutes for it to spin up
4. Go to **SQL Editor** in the left sidebar and run this query to create your table:

```sql
create table boards (
  id text primary key,
  settings jsonb default '{}'::jsonb,
  board jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);

alter table boards enable row level security;

create policy "Allow all operations"
  on boards for all
  using (true)
  with check (true);
```

5. Go to **Project Settings → API** and copy two values:
   - **Project URL** (looks like `https://xxxx.supabase.co`)
   - **Publishable key** (starts with `sb_publishable_`, under **API Keys**). This is the new public client key that replaced the legacy `anon` key — safe to ship in the frontend since the table is protected by Row Level Security.

---

### 2. Put the code on GitHub

1. Go to [github.com](https://github.com) and sign up / sign in
2. Click **New repository**, name it `bet-board`, set it to **Public**, click **Create repository**
3. Download this project folder to your computer
4. Open a terminal in that folder and run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/bet-board.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username.

---

### 3. Add your Supabase keys as GitHub secrets

1. In your GitHub repo, go to **Settings → Secrets and variables → Actions**
2. Click **New repository secret** and add these two:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Your Supabase publishable key (`sb_publishable_…`) |

---

### 4. Enable GitHub Pages

1. In your GitHub repo, go to **Settings → Pages**
2. Under **Source**, select **GitHub Actions**
3. That's it — GitHub will now auto-deploy every time you push

---

### 5. Trigger the first deploy

Go to the **Actions** tab in your repo. You should see the deploy workflow running (or click **Run workflow** to trigger it manually). After ~2 minutes, your app will be live at:

```
https://YOUR_USERNAME.github.io/betting-board/
```

---

## Running locally

```bash
npm install
cp .env.example .env   # then paste your Supabase URL + publishable key into .env
npm run dev
```

Open the printed URL (e.g. `http://localhost:5173/betting-board/`). If you skip the `.env` step the app still runs, but data is saved only in your browser's localStorage (no cloud sync).

---

## Using on multiple devices

Your board is identified by a UUID that's stored in your browser's localStorage.

1. Open the app on your first device and go to **Setup**
2. Find **Your Board ID** at the bottom and tap **Copy**
3. On your second device, open the same URL, go to **Setup**, paste the ID into the input field, and tap **Load**
4. The app reloads with your data

> Keep your board ID somewhere safe (notes app, password manager). If you clear your browser storage and don't have the ID, you won't be able to recover your data.

---

## Making changes

If you ever want to update the app (new features, tweaks), edit `src/App.jsx` and push to GitHub. The Actions workflow will automatically rebuild and redeploy.

```bash
git add .
git commit -m "Your change description"
git push
```

---

## Tech stack

- **React + Vite** — frontend
- **Tailwind CSS** — styling
- **Supabase** — database (free tier)
- **GitHub Pages** — hosting (free)
- **GitHub Actions** — auto-deploy on push
