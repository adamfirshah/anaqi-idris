-- Run this in Supabase SQL Editor (one time)
-- Adds breast pump session tracking for the Mummy tab

create table if not exists public.pump_sessions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  logged_at timestamptz not null default now(),
  oz numeric not null check (oz > 0 and oz <= 20),
  side text check (side in ('L', 'R', 'Both')),
  duration_min integer check (duration_min > 0 and duration_min <= 120),
  note text,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists pump_sessions_family_logged_at_idx
  on public.pump_sessions (family_id, logged_at desc);

-- RLS: same pattern as feedings — family members only
alter table public.pump_sessions enable row level security;

create policy "Family members can read pump sessions"
  on public.pump_sessions for select
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can insert pump sessions"
  on public.pump_sessions for insert
  with check (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can delete pump sessions"
  on public.pump_sessions for delete
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

-- Realtime sync (both phones see updates instantly)
alter publication supabase_realtime add table public.pump_sessions;
