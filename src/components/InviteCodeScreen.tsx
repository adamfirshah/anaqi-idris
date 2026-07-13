import { useState } from 'react'
import { joinWithInviteCode } from '../lib/invite'
import '../Auth.css'

interface Props {
  onJoined: () => void
  onBabahLogin: () => void
}

export default function InviteCodeScreen({ onJoined, onBabahLogin }: Props) {
  const [inviteCode, setInviteCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      await joinWithInviteCode(inviteCode)
      onJoined()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join family')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <img src="/icon.png" alt="Anaqi" className="auth-icon" />
          <h1>Anaqi's Milk Tracker</h1>
          <p>Enter the invite code from Babah to join</p>
        </div>

        <form onSubmit={submit} className="auth-form">
          <label>
            Invite code
            <input
              type="text"
              value={inviteCode}
              onChange={e => setInviteCode(e.target.value.toUpperCase())}
              placeholder="e.g. A1B2C3D4"
              required
              autoComplete="off"
              autoCapitalize="characters"
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading ? 'Joining…' : 'Join app'}
          </button>
        </form>

        <p className="auth-footnote">
          Once joined, you won't need to log in again.
        </p>

        <button type="button" className="auth-link-btn" onClick={onBabahLogin}>
          Babah login →
        </button>
      </div>
    </div>
  )
}
