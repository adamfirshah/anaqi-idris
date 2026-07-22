-- Run this in Supabase SQL Editor (one time)
-- Baby weight (kg) and length/height (cm) tracking

create table if not exists public.baby_measurements (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  measured_at timestamptz not null default now(),
  weight_kg numeric check (weight_kg > 0 and weight_kg <= 30),
  height_cm numeric check (height_cm > 0 and height_cm <= 200),
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists baby_measurements_family_measured_at_idx
  on public.baby_measurements (family_id, measured_at desc);

alter table public.baby_measurements enable row level security;

create policy "Family members can read baby measurements"
  on public.baby_measurements for select
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can insert baby measurements"
  on public.baby_measurements for insert
  with check (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can update baby measurements"
  on public.baby_measurements for update
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can delete baby measurements"
  on public.baby_measurements for delete
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

alter publication supabase_realtime add table public.baby_measurements;

-- Optional: seed Idris's latest stats (run once)
-- insert into public.baby_measurements (family_id, weight_kg, height_cm, measured_at)
-- select id, 5.02, 60, '2026-07-17'::timestamptz from public.families limit 1;
