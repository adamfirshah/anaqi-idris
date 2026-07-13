import { useState, useEffect, useCallback } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import {
  formatTime,
  formatDate,
  todayStr,
  formatCountdown,
  formatElapsed,
} from '../lib/format'
import type { FamilyInfo, Feeding, FeedingRow, MilkType } from '../types/database'
import { rowToFeeding, feedingDisplayNote } from '../types/database'
import '../App.css'
import '../Auth.css'

const FEED_INTERVAL_MS = 2 * 60 * 60 * 1000
const PREPARE_WARN_MS = 30 * 60 * 1000
const QUICK_OZ = [2, 2.5, 3, 3.5, 4]
const MILK_TYPES = ['FM', 'EBM', 'BM'] as const

type Status = 'none' | 'ok' | 'prepare' | 'overdue'

function getStatus(lastTs: number | null, now: number): Status {
  if (!lastTs) return 'none'
  const remaining = FEED_INTERVAL_MS - (now - lastTs)
  if (remaining < 0) return 'overdue'
  if (remaining <= PREPARE_WARN_MS) return 'prepare'
  return 'ok'
}

interface Props {
  session: Session
  family: FamilyInfo
  onSignOut: () => void
}

export default function MilkTracker({ session, family, onSignOut }: Props) {
  const [feedings, setFeedings] = useState<Feeding[]>([])
  const [loading, setLoading] = useState(true)
  const [oz, setOz] = useState('3')
  const [milkType, setMilkType] = useState<MilkType | ''>('FM')
  const [note, setNote] = useState('')
  const [now, setNow] = useState(Date.now())
  const [justLogged, setJustLogged] = useState(false)
  const [activeTab, setActiveTab] = useState<'today' | 'history'>('today')
  const [error, setError] = useState('')

  const fetchFeedings = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from('feedings')
      .select('*')
      .order('logged_at', { ascending: true })

    if (fetchError) {
      setError(fetchError.message)
      return
    }

    setFeedings((data as FeedingRow[]).map(rowToFeeding))
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchFeedings()

    const channel = supabase
      .channel('feedings-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'feedings' },
        () => fetchFeedings(),
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [fetchFeedings])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const lastFeeding = feedings.length > 0 ? feedings[feedings.length - 1] : null
  const nextFeedTs = lastFeeding ? lastFeeding.timestamp + FEED_INTERVAL_MS : null
  const remaining = nextFeedTs ? nextFeedTs - now : null
  const status = getStatus(lastFeeding?.timestamp ?? null, now)
  const countdown = remaining !== null ? formatCountdown(remaining) : null

  const todayFeedings = feedings.filter(
    f => new Date(f.timestamp).toDateString() === todayStr(),
  )
  const dailyOz = todayFeedings.reduce((s, f) => s + f.oz, 0)

  const pastFeedings = feedings.filter(
    f => new Date(f.timestamp).toDateString() !== todayStr(),
  )
  const grouped = pastFeedings.reduce<Record<string, Feeding[]>>((acc, f) => {
    const k = new Date(f.timestamp).toDateString()
    ;(acc[k] ??= []).push(f)
    return acc
  }, {})
  const pastDates = Object.keys(grouped).sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime(),
  )

  const logFeeding = useCallback(async () => {
    const parsed = parseFloat(oz)
    if (!parsed || parsed <= 0 || parsed > 10) return

    setError('')
    const { error: insertError } = await supabase.from('feedings').insert({
      family_id: family.familyId,
      logged_at: new Date().toISOString(),
      oz: parsed,
      milk_type: milkType || null,
      note: note.trim() || null,
      logged_by: session.user.id,
    })

    if (insertError) {
      setError(insertError.message)
      return
    }

    setNote('')
    setJustLogged(true)
    setTimeout(() => setJustLogged(false), 2000)
    fetchFeedings()
  }, [oz, milkType, note, family.familyId, session.user.id, fetchFeedings])

  const removeFeeding = useCallback(
    async (id: string) => {
      const { error: deleteError } = await supabase.from('feedings').delete().eq('id', id)
      if (deleteError) setError(deleteError.message)
      else fetchFeedings()
    },
    [fetchFeedings],
  )

  if (loading) {
    return (
      <div className="auth-page">
        <div className="loading-spinner">🍼</div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="header-top">
        <header className="header" style={{ marginBottom: 0 }}>
          <img src="/icon.png" alt="Anaqi" className="auth-icon" style={{ width: 48, height: 48 }} />
          <div>
            <h1 className="header-title">Anaqi Idris's Milk</h1>
            <p className="header-sub">
              {new Date().toLocaleDateString('en-MY', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </p>
          </div>
        </header>
        <div className="header-actions">
          <span className="invite-pill">Code: {family.inviteCode}</span>
          <button type="button" className="sign-out-btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>

      {error && <p className="auth-error" style={{ marginBottom: '0.75rem' }}>{error}</p>}

      <div className={`card countdown-card status-${status}`}>
        {status === 'none' && (
          <>
            <p className="cd-label">No feedings yet</p>
            <p className="cd-time">—</p>
            <p className="cd-sub">Log the first feeding below</p>
          </>
        )}

        {status === 'ok' && lastFeeding && nextFeedTs && (() => {
          const prepareTs = lastFeeding.timestamp + FEED_INTERVAL_MS - PREPARE_WARN_MS
          const cd = formatCountdown(prepareTs - now)
          return (
            <>
              <p className="cd-label">Can prepare in</p>
              <p className="cd-time">
                {cd.h > 0 && <><span>{cd.h}</span><small>h </small></>}
                <span>{cd.m}</span><small>m</small>
              </p>
              <div className="cd-rows">
                <div className="cd-row"><span>prep milk</span><span>{formatTime(nextFeedTs - PREPARE_WARN_MS)}</span></div>
                <div className="cd-row"><span>next feed</span><span>{formatTime(nextFeedTs)}</span></div>
                <div className="cd-row"><span>last fed</span><span>{formatTime(lastFeeding.timestamp)}</span></div>
              </div>
            </>
          )
        })()}

        {status === 'prepare' && countdown && nextFeedTs && (
          <>
            <p className="cd-label">🍼 Can Prepare!</p>
            <p className="cd-time">
              {countdown.h > 0 && <><span>{countdown.h}</span><small>h </small></>}
              <span>{countdown.m}</span><small>m</small>
            </p>
            <p className="cd-sub">
              next feed {formatTime(nextFeedTs)} · {countdown.m}m away
            </p>
          </>
        )}

        {status === 'overdue' && countdown && lastFeeding && (
          <>
            <p className="cd-label">Feeding overdue!</p>
            <p className="cd-time">
              +{countdown.h > 0 && <><span>{countdown.h}</span><small>h </small></>}
              <span>{countdown.m}</span><small>m</small>
            </p>
            <p className="cd-sub">
              last fed {formatTime(lastFeeding.timestamp)} · {formatElapsed(now - lastFeeding.timestamp)}
            </p>
          </>
        )}
      </div>

      {status === 'prepare' && (
        <div className="prepare-banner">
          <span className="prepare-icon">⏱️</span>
          <span>Time to warm the bottle — next feed in under 30 min</span>
        </div>
      )}

      <div className="stats-row">
        <div className="stat-box">
          <span className="stat-value">{dailyOz.toFixed(1)}</span>
          <span className="stat-unit">oz</span>
          <p className="stat-label">Today's total</p>
        </div>
        <div className="stat-box">
          <span className="stat-value">{todayFeedings.length}</span>
          <p className="stat-label">Feedings</p>
        </div>
        <div className="stat-box">
          <span className="stat-value">
            {lastFeeding ? formatTime(lastFeeding.timestamp) : '—'}
          </span>
          <p className="stat-label">Last fed</p>
        </div>
      </div>

      <div className="card log-card">
        <h2 className="card-title">How much did Anaqi drink?</h2>

        <p className="section-label">Amount</p>
        <div className="oz-row">
          {QUICK_OZ.map(q => (
            <button
              key={q}
              type="button"
              className={`oz-btn ${oz === String(q) ? 'active' : ''}`}
              onClick={() => setOz(String(q))}
            >
              {q}oz
            </button>
          ))}
        </div>

        <div className="custom-row">
          <input
            type="number"
            className="oz-input"
            value={oz}
            onChange={e => setOz(e.target.value)}
            min="0.5"
            max="10"
            step="0.5"
            inputMode="decimal"
            aria-label="Custom oz amount"
          />
          <span className="oz-unit">oz</span>
        </div>

        <p className="section-label">Milk type</p>
        <div className="milk-type-row">
          {MILK_TYPES.map(t => (
            <button
              key={t}
              type="button"
              className={`milk-btn ${milkType === t ? 'active' : ''}`}
              onClick={() => setMilkType(prev => (prev === t ? '' : t))}
            >
              {t}
            </button>
          ))}
        </div>

        <input
          type="text"
          className="note-input"
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="Extra note (optional)"
          maxLength={80}
        />

        {lastFeeding && (
          <div className="time-preview">
            <span className="time-preview-label">Last fed was</span>
            <span className="time-preview-val">{formatTime(lastFeeding.timestamp)}</span>
            <span className="time-preview-next">→ next feed ~{formatTime(lastFeeding.timestamp + FEED_INTERVAL_MS)}</span>
          </div>
        )}

        <button
          type="button"
          className={`log-btn ${justLogged ? 'logged' : ''}`}
          onClick={logFeeding}
        >
          {justLogged ? '✓ Logged!' : '🍼 Log Feed Now'}
        </button>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab-btn ${activeTab === 'today' ? 'active' : ''}`}
          onClick={() => setActiveTab('today')}
        >
          Today
          {todayFeedings.length > 0 && <span className="tab-badge">{todayFeedings.length}</span>}
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          History
        </button>
      </div>

      {activeTab === 'today' && (
        <div className="card history-card">
          {todayFeedings.length === 0 ? (
            <p className="empty-state">No feedings logged today yet.</p>
          ) : (
            <ul className="feeding-list">
              {[...todayFeedings].reverse().map((f, i, arr) => {
                const prev = arr[i + 1]
                const gap = prev ? f.timestamp - prev.timestamp : null
                const displayNote = feedingDisplayNote(f)
                return (
                  <li key={f.id} className="feeding-item">
                    {gap && (
                      <div className="feeding-gap">
                        {formatCountdown(gap).h > 0
                          ? `${formatCountdown(gap).h}h ${formatCountdown(gap).m}m gap`
                          : `${formatCountdown(gap).m}m gap`}
                      </div>
                    )}
                    <div className="feeding-row">
                      <div className="feeding-left">
                        <span className="feeding-oz">{f.oz}oz</span>
                        {displayNote && <span className="feeding-note">{displayNote}</span>}
                      </div>
                      <div className="feeding-right">
                        <span className="feeding-time">{formatTime(f.timestamp)}</span>
                        <button
                          type="button"
                          className="remove-btn"
                          onClick={() => removeFeeding(f.id)}
                          aria-label="Remove"
                        >×</button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {activeTab === 'history' && (
        <div className="card history-card">
          {pastDates.length === 0 ? (
            <p className="empty-state">No past feedings recorded.</p>
          ) : (
            pastDates.map(dk => {
              const items = grouped[dk]
              const total = items.reduce((s, f) => s + f.oz, 0)
              return (
                <div key={dk} className="history-day">
                  <div className="history-day-header">
                    <span className="history-day-label">{formatDate(items[0].timestamp)}</span>
                    <span className="history-day-total">{total.toFixed(1)}oz · {items.length}x</span>
                  </div>
                  <ul className="feeding-list">
                    {[...items].reverse().map(f => {
                      const displayNote = feedingDisplayNote(f)
                      return (
                        <li key={f.id} className="feeding-item">
                          <div className="feeding-row">
                            <div className="feeding-left">
                              <span className="feeding-oz">{f.oz}oz</span>
                              {displayNote && <span className="feeding-note">{displayNote}</span>}
                            </div>
                            <div className="feeding-right">
                              <span className="feeding-time">{formatTime(f.timestamp)}</span>
                              <button
                                type="button"
                                className="remove-btn"
                                onClick={() => removeFeeding(f.id)}
                                aria-label="Remove"
                              >×</button>
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })
          )}
        </div>
      )}

      <p className="sync-status">Synced with Supabase · updates live for both phones</p>
    </div>
  )
}
