// Supabase Edge Function: send-test-notification
// Deploy: supabase functions deploy send-test-notification --no-verify-jwt
// (JWT is verified manually below via getUser)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        webpush: {
          headers: { Urgency: 'high' },
          notification: { title, body, icon: '/icon.png' },
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing auth' }), { status: 401 })
  }

  const supabaseUser = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data: { user }, error: userError } = await supabaseUser.auth.getUser()
  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: tokens } = await supabase
    .from('fcm_tokens')
    .select('token')
    .eq('user_id', user.id)

  if (!tokens?.length) {
    return new Response(JSON.stringify({ error: 'No FCM tokens — tap Enable alerts first' }), {
      status: 400,
    })
  }

  const projectId = Deno.env.get('FIREBASE_PROJECT_ID')!
  const clientEmail = Deno.env.get('FIREBASE_CLIENT_EMAIL')!
  const privateKey = Deno.env.get('FIREBASE_PRIVATE_KEY')!.replace(/\\n/g, '\n')
  const accessToken = await getAccessToken(clientEmail, privateKey)

  const title = '🍼 Test notification'
  const body = 'Alerts are working! This is a test from Anaqi\'s Milk Tracker.'
  const results: { ok: number; failed: number; errors: string[] } = { ok: 0, failed: 0, errors: [] }

  for (const row of tokens) {
    try {
      await sendFcm(accessToken, projectId, row.token, title, body)
      results.ok++
    } catch (err) {
      results.failed++
      results.errors.push(String(err))
    }
  }

  return new Response(JSON.stringify({ ok: true, sent: results.ok, failed: results.failed, errors: results.errors }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
