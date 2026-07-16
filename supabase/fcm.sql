-- Run in Supabase SQL Editor

create table public.fcm_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null,
  platform text default 'web',
  updated_at timestamptz not null default now(),
  unique (user_id, token)
);

alter table public.fcm_tokens enable row level security;

create policy "users manage own fcm tokens"
  on public.fcm_tokens for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Track sent reminders so we don't spam every minute
create table public.feed_reminder_log (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  reminder_type text not null check (reminder_type in ('prepare_15', 'prepare_10', 'prepare_30', 'overdue', 'forgot_log')),
  sent_at timestamptz not null default now(),
  feeding_id uuid references public.feedings(id) on delete set null
);

create index feed_reminder_log_lookup_idx
  on public.feed_reminder_log (family_id, reminder_type, sent_at desc);

-- Edge function uses service role — no RLS needed for reminder_log writes from function
