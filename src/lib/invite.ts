import { supabase } from './supabase'

const INVITE_CODE_KEY = 'anaqi-invite-code'

export function getSavedInviteCode() {
  return localStorage.getItem(INVITE_CODE_KEY)
}

export async function joinWithInviteCode(code: string) {
  const normalized = code.trim().toUpperCase()
  if (!normalized) throw new Error('Please enter an invite code')

  const { data: sessionData } = await supabase.auth.getSession()
  if (!sessionData.session) {
    const { error: authError } = await supabase.auth.signInAnonymously()
    if (authError) {
      if (authError.message.toLowerCase().includes('anonymous')) {
        throw new Error(
          'Anonymous sign-ins are disabled. In Supabase: Authentication → Sign In / Providers → Anonymous → Enable → Save.',
        )
      }
      throw authError
    }
  }

  const { error: joinError } = await supabase.rpc('join_family_by_code', {
    p_invite_code: normalized,
  })
  if (joinError) throw joinError

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
