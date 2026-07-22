-- Run this in Supabase SQL Editor (one time)
-- Daily Appeton check-off (one log per family per day)

create table if not exists public.daily_appeton (
  family_id uuid not null references public.families(id) on delete cascade,
  log_date date not null,
  logged_at timestamptz not null default now(),
  logged_by uuid references auth.users(id),
  primary key (family_id, log_date)
);

alter table public.daily_appeton enable row level security;

create policy "Family members can read daily appeton"
  on public.daily_appeton for select
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can insert daily appeton"
  on public.daily_appeton for insert
  with check (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can delete daily appeton"
  on public.daily_appeton for delete
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

alter publication supabase_realtime add table public.daily_appeton;
