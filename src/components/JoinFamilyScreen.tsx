import { useState } from 'react'
import { supabase } from '../lib/supabase'
import '../Auth.css'

interface Props {
  onJoined: () => void
}

export default function JoinFamilyScreen({ onJoined }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [createdCode, setCreatedCode] = useState<string | null>(null)

  const createFamily = async () => {
    setLoading(true)
    setError('')

    const { data, error: createError } = await supabase.rpc('create_family', {
      p_name: 'Anaqi Idris Family',
    })

    if (createError) {
      setError(createError.message)
      setLoading(false)
      return
    }

    const row = Array.isArray(data) ? data[0] : data
    setCreatedCode(row?.invite_code ?? null)
    setLoading(false)
  }

  if (createdCode) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-header">
            <span className="auth-emoji">✅</span>
            <h1>Family created!</h1>
            <p>Share this invite code with your wife:</p>
          </div>
          <div className="invite-code-box">{createdCode}</div>
          <button type="button" className="auth-submit" onClick={onJoined}>
            Continue to app
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <span className="auth-emoji">👨‍👩‍👦</span>
          <h1>First-time setup</h1>
          <p>Create Anaqi Idris's family and get an invite code for Mummy.</p>
        </div>

        {error && <p className="auth-error">{error}</p>}

        <button
          type="button"
          className="auth-submit"
          onClick={createFamily}
          disabled={loading}
        >
          {loading ? 'Creating…' : 'Create family'}
        </button>
      </div>
    </div>
  )
}
