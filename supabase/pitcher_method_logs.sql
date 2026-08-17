-- Run this in Supabase SQL Editor once.
-- Records each completed pitcher method so the pump total can restart from zero.

create table if not exists public.pitcher_method_logs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  completed_at timestamptz not null default now(),
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists pitcher_method_logs_family_completed_at_idx
  on public.pitcher_method_logs (family_id, completed_at desc);

alter table public.pitcher_method_logs enable row level security;

create policy "Family members can read pitcher method logs"
  on public.pitcher_method_logs for select
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can insert pitcher method logs"
  on public.pitcher_method_logs for insert
  with check (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

alter publication supabase_realtime add table public.pitcher_method_logs;
