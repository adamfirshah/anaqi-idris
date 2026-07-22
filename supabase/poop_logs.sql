-- Run this in Supabase SQL Editor (one time)
-- Poop / pee tracking for the Anaqi tab

create table if not exists public.poop_logs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  logged_at timestamptz not null default now(),
  poop_type text not null default 'Poo' check (poop_type in ('Poo', 'Pee', 'Both')),
  note text,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists poop_logs_family_logged_at_idx
  on public.poop_logs (family_id, logged_at desc);

alter table public.poop_logs enable row level security;

create policy "Family members can read poop logs"
  on public.poop_logs for select
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can insert poop logs"
  on public.poop_logs for insert
  with check (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can delete poop logs"
  on public.poop_logs for delete
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

alter publication supabase_realtime add table public.poop_logs;
