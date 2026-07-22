-- Run this in Supabase SQL Editor (one time)
-- Baby clinic / appointment tracking

create table if not exists public.baby_appointments (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  appointment_at timestamptz not null,
  location text not null,
  note text,
  logged_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists baby_appointments_family_at_idx
  on public.baby_appointments (family_id, appointment_at asc);

alter table public.baby_appointments enable row level security;

create policy "Family members can read baby appointments"
  on public.baby_appointments for select
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can insert baby appointments"
  on public.baby_appointments for insert
  with check (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

create policy "Family members can delete baby appointments"
  on public.baby_appointments for delete
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );

alter publication supabase_realtime add table public.baby_appointments;
