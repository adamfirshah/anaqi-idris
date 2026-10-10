import { supabase } from './supabase'

const INVITE_CODE_KEY = 'anaqi-invite-code'

export function getSavedInviteCode() {
  return localStorage.getItem(INVITE_CODE_KEY)
}

async function signInAsGuest() {
  const { error } = await supabase.auth.signInAnonymously()
  if (!error) return

  if (error.message.toLowerCase().includes('anonymous')) {
    throw new Error(
      'Anonymous sign-ins are disabled. In Supabase: Authentication → Sign In / Providers → Anonymous → Enable → Save.',
    )
  }
  throw new Error(error.message)
}

export async function joinWithInviteCode(code: string) {
  const normalized = code.trim().toUpperCase()
  if (!normalized) throw new Error('Please enter an invite code')

  const { data: sessionData } = await supabase.auth.getSession()
  if (!sessionData.session) {
    await signInAsGuest()
  }

  let { error: joinError } = await supabase.rpc('join_family_by_code', {
    p_invite_code: normalized,
  })

  // A previously cached guest token can become unusable after backend clock
  // corrections. Replace it locally and retry once with a freshly issued JWT.
  if (joinError?.message.toLowerCase().includes('jwt issued at future')) {
    await supabase.auth.signOut({ scope: 'local' })
    await signInAsGuest()
    const retry = await supabase.rpc('join_family_by_code', {
      p_invite_code: normalized,
    })
    joinError = retry.error
  }

  if (joinError) {
    const message = joinError.message.toLowerCase().includes('join_family_by_code')
      ? 'Family joining is not configured in Supabase yet.'
      : joinError.message
    throw new Error(message)
  }

  localStorage.setItem(INVITE_CODE_KEY, normalized)
}

/** Re-join silently if guest session expired but invite code was saved */
export async function tryRestoreGuestSession() {
  const code = getSavedInviteCode()
  if (!code) return false

  const { data: { session } } = await supabase.auth.getSession()
  if (session) return true

  try {
    await joinWithInviteCode(code)
    return true
  } catch {
    return false
  }
}

export function isGuestSession(session: { user: { is_anonymous?: boolean } } | null) {
  return session?.user.is_anonymous === true
}
