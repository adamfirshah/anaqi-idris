-- Run this in Supabase SQL Editor (one time)
-- Direct breastfeed logs for the Mummy tab

create table if not exists public.direct_feed_logs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  logged_at timestamptz not null default now(),
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists direct_feed_logs_family_logged_at_idx
  on public.direct_feed_logs (family_id, logged_at desc);

alter table public.direct_feed_logs enable row level security;

create policy "Family members can read direct feed logs"
  on public.direct_feed_logs for select
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can insert direct feed logs"
  on public.direct_feed_logs for insert
  with check (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can delete direct feed logs"
  on public.direct_feed_logs for delete
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

alter publication supabase_realtime add table public.direct_feed_logs;
