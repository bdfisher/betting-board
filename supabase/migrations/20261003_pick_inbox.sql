-- Staging table for picks extracted from shared tweets/screenshots.
--
-- Deliberately NOT part of the `boards` row. The app rewrites the whole
-- boards.board JSON blob from in-memory state on every mutation (App.jsx
-- persistBoard) and only reads it once on mount, so anything an external
-- writer merged into that blob would be clobbered by the next tap. The
-- ingest pipeline writes here instead; the app reads this table directly and
-- only ever touches boards.board through its normal persistBoard path when
-- you tap Accept.

create table if not exists public.pick_inbox (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),

  status        text not null default 'pending',  -- pending | accepted | dismissed
  kind          text not null,                    -- url | image | text

  source_url    text,          -- original tweet permalink
  raw_text      text,          -- tweet text (from FxTwitter) or the shared text
  image_url     text,          -- FxTwitter media URL, when the tweet had a photo
  image_path    text,          -- Storage path, when a screenshot was shared
  author_handle text,          -- @handle the pick came from

  extracted     jsonb,         -- { picks: [...], warnings: [...] }
  model         text,          -- which model produced `extracted`
  error         text           -- set when resolution or extraction failed
);

-- Supports the app's only query: this user's pending rows, newest first.
create index if not exists pick_inbox_pending
  on public.pick_inbox (user_id, created_at desc)
  where status = 'pending';

alter table public.pick_inbox enable row level security;

drop policy if exists "own rows" on public.pick_inbox;
create policy "own rows" on public.pick_inbox
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Private bucket for shared screenshots. Objects are stored at
-- <user_id>/<inbox_id>.jpg so the folder-name policy below scopes them.
insert into storage.buckets (id, name, public)
values ('pick-inbox', 'pick-inbox', false)
on conflict (id) do nothing;

drop policy if exists "own screenshots" on storage.objects;
create policy "own screenshots" on storage.objects
  for select
  using (
    bucket_id = 'pick-inbox'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
