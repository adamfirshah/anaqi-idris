// Supabase Edge Function: send-feed-reminders
// Deploy: supabase functions deploy send-feed-reminders
// Schedule: Supabase Dashboard → Edge Functions → Cron → every 1 minute
//
// Feed reminders (last fed 8:00am → prep 9:00am → feed 10:00am):
//   8:45  prepare_15   icon: /icon.png
//   8:50  prepare_10   icon: /icon.png
//   9:30  prepare_30   icon: /icon.png  (30 min into prep / 30 min before feed)
//  10:00  overdue      icon: /icon.png
//  10:15  forgot_log   icon: /icon.png
//
// Pump reminders (since last pump):
//   2h / 3h / 4h  pump_2h / pump_3h / pump_4h  icon: /mummy.png
//
// Secrets: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const FEED_INTERVAL_MS = 2 * 60 * 60 * 1000
const PREPARE_WARN_MS = 60 * 60 * 1000
const FORGOT_LOG_AFTER_MS = 15 * 60 * 1000
const CRON_WINDOW_MS = 60 * 1000
const FEED_ICON = '/icon.png'
const PUMP_ICON = '/mummy.png'

type FeedReminderType = 'prepare_15' | 'prepare_10' | 'prepare_30' | 'overdue' | 'forgot_log'
type PumpReminderType = 'pump_2h' | 'pump_3h' | 'pump_4h'

const FEED_REMINDERS: Record<FeedReminderType, { title: string; body: string }> = {
  prepare_15: {
    title: '⏱️ Prep susu in 15 min',
    body: 'Babah & Mummy - standby Anaqi lapor.',
  },
  prepare_10: {
    title: '⏱️ Prep susu in 10 min',
    body: 'Lagi 10 nak sejam - bancuh awal tak kalut.',
  },
  prepare_30: {
    title: '⏱️ Lagi 30 min nak feed',
    body: 'Dah setengah jam prep time — susu dah ready?',
  },
  overdue: {
    title: '🍼 Babah & Mummy, time to feed Anaqi!',
    body: '2 hours since last feed — susu time now.',
  },
  forgot_log: {
    title: '🍼 Ha lupa la tuuu..',
    body: 'Feed time was 15 min ago — log now if Anaqi already fed.',
  },
}

const PUMP_REMINDER: { title: string; body: string } = {
  title: 'Mummy, tak pump lagi kan?',
  body: 'Pump la nanti bengkak sakit pula...',
}

function inWindow(value: number, targetMs: number) {
  return value <= targetMs && value > targetMs - CRON_WINDOW_MS
}

function pickFeedReminder(remaining: number, msUntilPrepare: number): FeedReminderType | null {
  if (inWindow(msUntilPrepare, 15 * 60_000)) return 'prepare_15'
  if (inWindow(msUntilPrepare, 10 * 60_000)) return 'prepare_10'
  // 30 min into 1hr prep window = 30 min before feed (e.g. 9:30 if feed at 10:00)
  if (inWindow(remaining, 30 * 60_000)) return 'prepare_30'
  if (inWindow(-remaining, 0)) return 'overdue'
  if (inWindow(-remaining, FORGOT_LOG_AFTER_MS)) return 'forgot_log'
  return null
}

function pickPumpReminder(elapsed: number): PumpReminderType | null {
  if (inWindow(elapsed, 2 * 60 * 60_000)) return 'pump_2h'
  if (inWindow(elapsed, 3 * 60 * 60_000)) return 'pump_3h'
  if (inWindow(elapsed, 4 * 60 * 60_000)) return 'pump_4h'
  return null
}

async function getAccessToken(clientEmail: string, privateKey: string) {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const claim = btoa(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claim}`),
  )
  const jwt = `${header}.${claim}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  })
  const json = await res.json()
  return json.access_token as string
}

function pemToArrayBuffer(pem: string) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')
  const raw = atob(b64)
  const buf = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i)
  return buf.buffer
}

async function sendFcm(
  accessToken: string,
  projectId: string,
  token: string,
  title: string,
  body: string,
  icon: string,
) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        data: { icon },
        webpush: {
          headers: { Urgency: 'high' },
          notification: { title, body, icon },
          fcm_options: { link: '/' },
        },
      },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`FCM ${res.status}: ${err}`)
  }
}

async function notifyFamily(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  projectId: string,
  familyId: string,
  title: string,
  body: string,
  icon: string,
) {
  const { data: members } = await supabase
    .from('family_members')
    .select('user_id')
    .eq('family_id', familyId)

  for (const member of members ?? []) {
    const { data: tokens } = await supabase
      .from('fcm_tokens')
      .select('token')
      .eq('user_id', member.user_id)

    for (const row of tokens ?? []) {
      try {
        await sendFcm(accessToken, projectId, row.token, title, body, icon)
      } catch (err) {
        console.error('FCM send failed:', row.token.slice(0, 12), err)
      }
    }
  }
}

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const projectId = Deno.env.get('FIREBASE_PROJECT_ID')!
  const clientEmail = Deno.env.get('FIREBASE_CLIENT_EMAIL')!
  const privateKey = Deno.env.get('FIREBASE_PRIVATE_KEY')!.replace(/\\n/g, '\n')
  const accessToken = await getAccessToken(clientEmail, privateKey)

  const { data: families } = await supabase.from('families').select('id')
  const now = Date.now()

  for (const family of families ?? []) {
    // ── Feed reminders ──
    const { data: lastFeed } = await supabase
      .from('feedings')
      .select('id, logged_at')
      .eq('family_id', family.id)
      .order('logged_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (lastFeed) {
      const lastTs = new Date(lastFeed.logged_at).getTime()
      const elapsed = now - lastTs
      const remaining = FEED_INTERVAL_MS - elapsed
      const msUntilPrepare = remaining - PREPARE_WARN_MS
      const feedReminderType = pickFeedReminder(remaining, msUntilPrepare)

      if (feedReminderType) {
        const { data: alreadySent } = await supabase
          .from('feed_reminder_log')
          .select('id')
          .eq('family_id', family.id)
          .eq('reminder_type', feedReminderType)
          .eq('feeding_id', lastFeed.id)
          .maybeSingle()

        if (!alreadySent) {
          const { title, body } = FEED_REMINDERS[feedReminderType]
          await notifyFamily(supabase, accessToken, projectId, family.id, title, body, FEED_ICON)
          await supabase.from('feed_reminder_log').insert({
            family_id: family.id,
            reminder_type: feedReminderType,
            feeding_id: lastFeed.id,
          })
        }
      }
    }

    // ── Pump reminders ──
    const { data: lastPump } = await supabase
      .from('pump_sessions')
      .select('id, logged_at')
      .eq('family_id', family.id)
      .order('logged_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (lastPump) {
      const pumpElapsed = now - new Date(lastPump.logged_at).getTime()
      const pumpReminderType = pickPumpReminder(pumpElapsed)

      if (pumpReminderType) {
        const { data: alreadySent } = await supabase
          .from('pump_reminder_log')
          .select('id')
          .eq('family_id', family.id)
          .eq('reminder_type', pumpReminderType)
          .eq('pump_session_id', lastPump.id)
          .maybeSingle()

        if (!alreadySent) {
          const { title, body } = PUMP_REMINDER
          await notifyFamily(supabase, accessToken, projectId, family.id, title, body, PUMP_ICON)
          await supabase.from('pump_reminder_log').insert({
            family_id: family.id,
            reminder_type: pumpReminderType,
            pump_session_id: lastPump.id,
          })
        }
      }
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
