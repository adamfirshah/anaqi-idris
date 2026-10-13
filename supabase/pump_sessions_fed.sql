-- Run this in Supabase SQL Editor (one time)
-- Marks a pump session as fed to Idris (excluded from "Pumped today" total)

alter table public.pump_sessions
  add column if not exists fed boolean not null default false;

create policy "Family members can update pump sessions"
  on public.pump_sessions for update
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  )
  with check (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );
