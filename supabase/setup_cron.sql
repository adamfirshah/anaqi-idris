-- Run in Supabase SQL Editor if cron still doesn't fire after deploy.
-- Dashboard alternative: Edge Functions → send-feed-reminders → Schedules → Add cron "* * * * *"
--
-- Also run these if not done yet:
--   supabase/reminder_types.sql
--   supabase/pump_reminder_log.sql

-- Enable extensions (safe to run multiple times)
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Remove old job if re-running
select cron.unschedule(jobid)
from cron.job
where jobname = 'send-feed-reminders';

-- Invoke edge function every minute
-- Replace YOUR_SERVICE_ROLE_KEY with Project Settings → API → service_role key
select cron.schedule(
  'send-feed-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://fglgfumhymdhqudauhrm.supabase.co/functions/v1/send-feed-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
