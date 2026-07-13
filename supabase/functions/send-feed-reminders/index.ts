// Supabase Edge Function: send-feed-reminders
// Deploy: supabase functions deploy send-feed-reminders
// Schedule: Supabase Dashboard → Edge Functions → Cron → every 1 minute
//
// Secrets needed (supabase secrets set):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY  (from Firebase service account JSON, keep \n as literal)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const FEED_INTERVAL_MS = 2 * 60 * 60 * 1000
const PREPARE_WARN_MS = 30 * 60 * 1000       // prep milk at 1h30m after last feed
const EARLY_PREPARE_MIN_MS = 5 * 60 * 1000   // notify 5–10 min before prep time
const EARLY_PREPARE_MAX_MS = 10 * 60 * 1000

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
) {
  await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        webpush: { fcm_options: { link: '/' } },
      },
    }),
  })
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
    const { data: lastFeed } = await supabase
      .from('feedings')
      .select('id, logged_at')
      .eq('family_id', family.id)
      .order('logged_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!lastFeed) continue

    const lastTs = new Date(lastFeed.logged_at).getTime()
    const elapsed = now - lastTs
    const remaining = FEED_INTERVAL_MS - elapsed
    const msUntilPrepare = remaining - PREPARE_WARN_MS

    let reminderType: 'prepare' | 'feed' | 'overdue' | null = null
    let title = ''
    let body = ''

    if (remaining <= 0 && elapsed < FEED_INTERVAL_MS + 5 * 60_000) {
      reminderType = 'overdue'
      title = '🍼 Feeding overdue!'
      body = 'Anaqi is past the 2-hour feeding window.'
    } else if (remaining > 0 && remaining <= 60_000) {
      reminderType = 'feed'
      title = '🍼 Time to feed Anaqi!'
      body = '2 hours since last feeding.'
    } else if (
      msUntilPrepare > EARLY_PREPARE_MIN_MS &&
      msUntilPrepare <= EARLY_PREPARE_MAX_MS
    ) {
      reminderType = 'prepare'
      const mins = Math.round(msUntilPrepare / 60_000)
      title = '⏱️ Prepare milk soon'
      body = `Start preparing in ~${mins} minutes.`
    }

    if (!reminderType) continue

    const { data: alreadySent } = await supabase
      .from('feed_reminder_log')
      .select('id')
      .eq('family_id', family.id)
      .eq('reminder_type', reminderType)
      .eq('feeding_id', lastFeed.id)
      .maybeSingle()

    if (alreadySent) continue

    const { data: members } = await supabase
      .from('family_members')
      .select('user_id')
      .eq('family_id', family.id)

    for (const member of members ?? []) {
      const { data: tokens } = await supabase
        .from('fcm_tokens')
        .select('token')
        .eq('user_id', member.user_id)

      for (const row of tokens ?? []) {
        await sendFcm(accessToken, projectId, row.token, title, body)
      }
    }

    await supabase.from('feed_reminder_log').insert({
      family_id: family.id,
      reminder_type: reminderType,
      feeding_id: lastFeed.id,
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
