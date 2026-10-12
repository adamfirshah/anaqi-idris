// Supabase Edge Function: send-feed-reminders
// Deploy: npx supabase functions deploy send-feed-reminders
// Cron: supabase/config.toml schedule = "* * * * *"  (or supabase/setup_cron.sql)
//
// Required SQL (run once in SQL Editor):
//   supabase/reminder_types.sql
//   supabase/pump_reminder_log.sql
//
// Optional secret for notification icons on iOS:
//   supabase secrets set APP_URL=https://your-app.vercel.app

// @ts-expect-error Deno resolves URL imports at runtime.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

declare const Deno: {
  env: {
    get(key: string): string | undefined
  }
  serve(handler: (request: Request) => Response | Promise<Response>): void
}

const FEED_INTERVAL_MS = 2 * 60 * 60 * 1000
const FORGOT_LOG_AFTER_MS = 15 * 60 * 1000
const CRON_WINDOW_MS = 5 * 60 * 1000   // 5-min window so cron doesn't miss the 1-min slot
const FEED_ICON = iconUrl('/icon.png')
const PUMP_ICON = iconUrl('/mummy.png')

function iconUrl(path: string) {
  const base = Deno.env.get('APP_URL')?.replace(/\/$/, '')
  return base ? `${base}${path}` : path
}

type FeedReminderType = 'prepare_30' | 'overdue' | 'forgot_log'
type PumpReminderType = 'pump_2h' | 'pump_3h' | 'pump_4h'

const FEED_REMINDERS: Record<FeedReminderType, { title: string; body: string }> = {
  prepare_30: {
    title: '30 minutes before feeding time',
    body: 'Susu should be prepare now',
  },
  overdue: {
    title: 'Feeding time',
    body: '',
  },
  forgot_log: {
    title: 'Reminder - please log Idris milk',
    body: '',
  },
}

const PUMP_REMINDER = {
  title: 'Ready to pump',
  body: '',
}

function inWindow(value: number, targetMs: number) {
  return value <= targetMs && value > targetMs - CRON_WINDOW_MS
}

function pickFeedReminder(remaining: number): FeedReminderType | null {
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

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function getAccessToken(clientEmail: string, privateKey: string) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const claim = base64url(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))
  const unsigned = `${header}.${claim}`
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
    new TextEncoder().encode(unsigned),
  )
  const jwt = `${unsigned}.${base64url(new Uint8Array(sig))}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  })
  const json = await res.json()
  if (!json.access_token) throw new Error(`Firebase auth failed: ${JSON.stringify(json)}`)
  return json.access_token as string
}

function normalizePrivateKey(pem: string) {
  let key = pem.trim()
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1)
  }
  return key.replace(/\\n/g, '\n')
}

function pemToArrayBuffer(pem: string) {
  const normalized = normalizePrivateKey(pem)
  const b64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')
  try {
    const raw = atob(b64)
    const buf = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i)
    return buf.buffer
  } catch {
    throw new Error( 
      'Invalid FIREBASE_PRIVATE_KEY — re-paste from Firebase JSON (no quotes, include BEGIN/END lines)',
    )
  }
}

async function sendFcm(
  accessToken: string,
  projectId: string,
  token: string,
  title: string,
  body: string,
  icon: string,
  tag: string,
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
        data: { title, body, icon, tag },
        webpush: {
          headers: { Urgency: 'high' },
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
  tag: string,
  excludeUserId?: string,
) {
  let sent = 0
  const errors: string[] = []
  const seenTokens = new Set<string>()

  const { data: members } = await supabase
    .from('family_members')
    .select('user_id')
    .eq('family_id', familyId)

  for (const member of members ?? []) {
    if (member.user_id === excludeUserId) continue
    // One token per user (latest device only) — avoids duplicate pop-ups
    const { data: tokens } = await supabase
      .from('fcm_tokens')
      .select('token')
      .eq('user_id', member.user_id)
      .order('updated_at', { ascending: false })
      .limit(1)

    for (const row of tokens ?? []) {
      if (seenTokens.has(row.token)) continue
      seenTokens.add(row.token)
      try {
        await sendFcm(accessToken, projectId, row.token, title, body, icon, tag)
        sent++
      } catch (err) {
        errors.push(String(err))
        console.error('FCM send failed:', row.token.slice(0, 12), err)
      }
    }
  }

  return { sent, errors }
}

type ActivityType = 'milk' | 'poop' | 'appeton' | 'direct_feed'

interface ActivityPayload {
  type: ActivityType
  familyId: string
  oz?: number
  milkType?: string
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function activityMessage(activity: ActivityPayload) {
  switch (activity.type) {
    case 'milk': {
      const amount =
        typeof activity.oz === 'number' && activity.oz > 0
          ? `${activity.oz}oz`
          : 'Milk'
      const milkType =
        activity.milkType === 'FM' || activity.milkType === 'EBM'
          ? ` ${activity.milkType}`
          : ''
      return {
        title: '🍼 Milk logged',
        body: `${amount}${milkType} was logged for Idris.`,
        tag: 'anaqi-activity-milk',
      }
    }
    case 'poop':
      return {
        title: '💩 Poop logged',
        body: 'Poop was logged for Idris.',
        tag: 'anaqi-activity-poop',
      }
    case 'appeton':
      return {
        title: '💊 Appeton logged',
        body: 'Idris has taken Appeton.',
        tag: 'anaqi-activity-appeton',
      }
    case 'direct_feed':
      return {
        title: '👶 Direct feed logged',
        body: 'A direct feed was logged for Idris.',
        tag: 'anaqi-activity-direct-feed',
      }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let requestBody: { activity?: ActivityPayload } = {}
  try {
    requestBody = await req.json()
  } catch {
    // Scheduled reminder calls may send an empty body.
  }

  if (requestBody.activity) {
    const activity = requestBody.activity
    const allowedTypes: ActivityType[] = [
      'milk',
      'poop',
      'appeton',
      'direct_feed',
    ]
    if (!activity.familyId || !allowedTypes.includes(activity.type)) {
      return jsonResponse({ ok: false, error: 'Invalid activity payload' }, 400)
    }

    const jwt = (req.headers.get('Authorization') ?? '').replace(
      /^Bearer\s+/i,
      '',
    )
    const { data: authData, error: authError } =
      await supabase.auth.getUser(jwt)
    if (authError || !authData.user) {
      return jsonResponse({ ok: false, error: 'Unauthorized' }, 401)
    }

    const { data: membership } = await supabase
      .from('family_members')
      .select('family_id')
      .eq('family_id', activity.familyId)
      .eq('user_id', authData.user.id)
      .maybeSingle()
    if (!membership) {
      return jsonResponse({ ok: false, error: 'Not a family member' }, 403)
    }

    const activityProjectId = Deno.env.get('FIREBASE_PROJECT_ID')
    const activityClientEmail = Deno.env.get('FIREBASE_CLIENT_EMAIL')
    const activityPrivateKey = Deno.env.get('FIREBASE_PRIVATE_KEY')
    if (!activityProjectId || !activityClientEmail || !activityPrivateKey) {
      return jsonResponse({ ok: false, error: 'Missing Firebase secrets' }, 500)
    }

    const activityAccessToken = await getAccessToken(
      activityClientEmail,
      activityPrivateKey,
    )
    const message = activityMessage(activity)
    const result = await notifyFamily(
      supabase,
      activityAccessToken,
      activityProjectId,
      activity.familyId,
      message.title,
      message.body,
      FEED_ICON,
      message.tag,
      authData.user.id,
    )

    return jsonResponse({ ok: true, ...result })
  }

  const projectId = Deno.env.get('FIREBASE_PROJECT_ID')
  const clientEmail = Deno.env.get('FIREBASE_CLIENT_EMAIL')
  const privateKeyRaw = Deno.env.get('FIREBASE_PRIVATE_KEY')

  if (!projectId || !clientEmail || !privateKeyRaw) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Missing Firebase secrets — run: supabase secrets set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY',
    }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  const accessToken = await getAccessToken(clientEmail, privateKeyRaw)
  const { data: families } = await supabase.from('families').select('id')
  const now = Date.now()
  const results: Record<string, unknown>[] = []

  for (const family of families ?? []) {
    const { data: lastFeed } = await supabase
      .from('feedings')
      .select('id, logged_at')
      .eq('family_id', family.id)
      .order('logged_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (lastFeed) {
      const lastTs = new Date(lastFeed.logged_at).getTime()
      const remaining = FEED_INTERVAL_MS - (now - lastTs)
      const feedReminderType = pickFeedReminder(remaining)

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
          const { sent, errors } = await notifyFamily(
            supabase, accessToken, projectId, family.id, title, body, FEED_ICON, feedReminderType,
          )
          const { error: logError } = await supabase.from('feed_reminder_log').insert({
            family_id: family.id,
            reminder_type: feedReminderType,
            feeding_id: lastFeed.id,
          })
          results.push({
            type: feedReminderType,
            sent,
            logError: logError?.message ?? null,
            fcmErrors: errors.slice(0, 2),
          })
        }
      }
    }

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
          const { sent, errors } = await notifyFamily(
            supabase, accessToken, projectId, family.id,
            PUMP_REMINDER.title, PUMP_REMINDER.body, PUMP_ICON, pumpReminderType,
          )
          const { error: logError } = await supabase.from('pump_reminder_log').insert({
            family_id: family.id,
            reminder_type: pumpReminderType,
            pump_session_id: lastPump.id,
          })
          results.push({
            type: pumpReminderType,
            sent,
            logError: logError?.message ?? null,
            fcmErrors: errors.slice(0, 2),
          })
        }
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, at: new Date().toISOString(), results }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
