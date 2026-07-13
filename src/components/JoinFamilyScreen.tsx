import { useState } from 'react'
import { supabase } from '../lib/supabase'
import '../Auth.css'

interface Props {
  onJoined: () => void
}

export default function JoinFamilyScreen({ onJoined }: Props) {
  const [inviteCode, setInviteCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [createdCode, setCreatedCode] = useState<string | null>(null)

  const joinFamily = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error: joinError } = await supabase.rpc('join_family_by_code', {
      p_invite_code: inviteCode.trim(),
    })

    if (joinError) {
      setError(joinError.message)
      setLoading(false)
      return
    }

    onJoined()
  }

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
          <h1>Join Anaqi's family</h1>
          <p>Enter the invite code from your partner, or create a new family.</p>
        </div>

        <form onSubmit={joinFamily} className="auth-form">
          <label>
            Invite code
            <input
              type="text"
              value={inviteCode}
              onChange={e => setInviteCode(e.target.value.toUpperCase())}
              placeholder="e.g. A1B2C3D4"
              required
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? 'Joining…' : 'Join family'}
          </button>
        </form>

        <div className="auth-divider">or</div>

        <button
          type="button"
          className="auth-secondary"
          onClick={createFamily}
          disabled={loading}
        >
          Create new family (first time setup)
        </button>
      </div>
    </div>
  )
}
