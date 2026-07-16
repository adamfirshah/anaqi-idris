-- Run in Supabase SQL Editor (one time) — updates reminder types for new notification schedule

alter table public.feed_reminder_log
  drop constraint if exists feed_reminder_log_reminder_type_check;

alter table public.feed_reminder_log
  add constraint feed_reminder_log_reminder_type_check
  check (reminder_type in ('prepare_15', 'prepare_10', 'prepare_30', 'overdue', 'forgot_log'));
