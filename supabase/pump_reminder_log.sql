-- Run in Supabase SQL Editor (one time)
-- Tracks sent pump reminders so we don't spam every minute

create table if not exists public.pump_reminder_log (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  reminder_type text not null check (reminder_type in ('pump_2h', 'pump_3h', 'pump_4h')),
  sent_at timestamptz not null default now(),
  pump_session_id uuid references public.pump_sessions(id) on delete set null
);

create index if not exists pump_reminder_log_lookup_idx
  on public.pump_reminder_log (family_id, reminder_type, pump_session_id);
