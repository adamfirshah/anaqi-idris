-- Run this in Supabase SQL Editor (one time)
-- Tracks how many EBM portions are in the fridge (plain count)

create table if not exists public.family_fridge (
  family_id uuid primary key references public.families(id) on delete cascade,
  ebm_count integer not null default 0 check (ebm_count >= 0 and ebm_count <= 999),
  updated_at timestamptz not null default now()
);

insert into public.family_fridge (family_id)
select id from public.families
on conflict (family_id) do nothing;

alter table public.family_fridge enable row level security;

create policy "Family members can read fridge ebm"
  on public.family_fridge for select
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can insert fridge ebm"
  on public.family_fridge for insert
  with check (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can update fridge ebm"
  on public.family_fridge for update
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

alter publication supabase_realtime add table public.family_fridge;

-- If you already created the table with ebm_oz or ebm_ml, run once:
-- alter table public.family_fridge rename column ebm_ml to ebm_count;
-- alter table public.family_fridge alter column ebm_count type integer using round(ebm_count)::integer;
