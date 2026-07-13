import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { FamilyInfo } from '../types/database'

export function useFamily(session: Session | null) {
  const [family, setFamily] = useState<FamilyInfo | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!session) {
      setFamily(null)
      setLoading(false)
      return
    }

    setLoading(true)
    const { data, error } = await supabase
      .from('family_members')
      .select('family_id, families(name, invite_code)')
      .eq('user_id', session.user.id)
      .maybeSingle()

    if (error || !data?.families) {
      setFamily(null)
    } else {
      const raw = data.families
      const f = (Array.isArray(raw) ? raw[0] : raw) as { name: string; invite_code: string }
      setFamily({
        familyId: data.family_id,
        name: f.name,
        inviteCode: f.invite_code,
      })
    }
    setLoading(false)
  }, [session])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { family, loading, refresh, hasFamily: family !== null }
}
