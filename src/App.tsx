import { useState, useEffect, useCallback } from 'react'
import './App.css'

interface Feeding {
  id: string
  timestamp: number
  oz: number
  note: string
}

const STORAGE_KEY = 'anaqi-feedings-v2'
const FEED_INTERVAL_MS = 2 * 60 * 60 * 1000       // 2 hours
const PREPARE_WARN_MS  = 30 * 60 * 1000            // warn 30 min before next feed
const QUICK_OZ = [2, 2.5, 3, 3.5, 4]
const MILK_TYPES = ['FM', 'EBM', 'BM'] as const
type MilkType = typeof MILK_TYPES[number] | ''

// ─── Storage ────────────────────────────────────────────────
function loadFeedings(): Feeding[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Feeding[]) : []
  } catch {
    return []
  }
}
function saveFeedings(f: Feeding[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(f))
}

// ─── Formatters ──────────────────────────────────────────────
function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })
}
function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short' })
}
function todayStr() { return new Date().toDateString() }

function formatCountdown(ms: number): { h: number; m: number; overdue: boolean } {
  const overdue = ms < 0
  const abs = Math.abs(ms)
  const totalMin = Math.floor(abs / 60_000)
  return { h: Math.floor(totalMin / 60), m: totalMin % 60, overdue }
}

function formatElapsed(ms: number) {
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return 'just now'
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`
  return `${m}m ago`
}

// ─── Status helpers ──────────────────────────────────────────
type Status = 'none' | 'ok' | 'prepare' | 'overdue'

function getStatus(lastTs: number | null, now: number): Status {
  if (!lastTs) return 'none'
  const elapsed = now - lastTs
  const remaining = FEED_INTERVAL_MS - elapsed
  if (remaining < 0) return 'overdue'
  if (remaining <= PREPARE_WARN_MS) return 'prepare'
  return 'ok'
}

export default function App() {
  const [feedings, setFeedings] = useState<Feeding[]>(loadFeedings)
  const [oz, setOz]             = useState('3')
  const [milkType, setMilkType] = useState<MilkType>('FM')
  const [note, setNote]         = useState('')
  const [now, setNow]           = useState(Date.now())
  const [justLogged, setJustLogged] = useState(false)
  const [activeTab, setActiveTab]   = useState<'today' | 'history'>('today')

  // Tick every 30 s for live countdown
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const lastFeeding = feedings.length > 0 ? feedings[feedings.length - 1] : null
  const nextFeedTs  = lastFeeding ? lastFeeding.timestamp + FEED_INTERVAL_MS : null
  const remaining   = nextFeedTs ? nextFeedTs - now : null
  const status      = getStatus(lastFeeding?.timestamp ?? null, now)
  const countdown   = remaining !== null ? formatCountdown(remaining) : null

  const todayFeedings = feedings.filter(f => new Date(f.timestamp).toDateString() === todayStr())
  const dailyOz = todayFeedings.reduce((s, f) => s + f.oz, 0)

  // History grouped by day (past days only)
  const pastFeedings = feedings.filter(f => new Date(f.timestamp).toDateString() !== todayStr())
  const grouped = pastFeedings.reduce<Record<string, Feeding[]>>((acc, f) => {
    const k = new Date(f.timestamp).toDateString()
    ;(acc[k] ??= []).push(f)
    return acc
  }, {})
  const pastDates = Object.keys(grouped).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())

  const logFeeding = useCallback(() => {
    const parsed = parseFloat(oz)
    if (!parsed || parsed <= 0 || parsed > 10) return
    const combinedNote = [milkType, note.trim()].filter(Boolean).join(' · ')
    const entry: Feeding = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      oz: parsed,
      note: combinedNote,
    }
    const updated = [...feedings, entry]
    setFeedings(updated)
    saveFeedings(updated)
    setNote('')
    setJustLogged(true)
    setTimeout(() => setJustLogged(false), 2000)
  }, [oz, note, feedings])

  const removeFeeding = useCallback((id: string) => {
    const updated = feedings.filter(f => f.id !== id)
    setFeedings(updated)
    saveFeedings(updated)
  }, [feedings])

  return (
    <div className="app">

      {/* Header */}
      <header className="header">
        <span className="header-icon">🍼</span>
        <div>
          <h1 className="header-title">Anaqi Idris's Milk</h1>
          <p className="header-sub">
            {new Date().toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
      </header>

      {/* ── Countdown hero ────────────────────────────────────── */}
      <div className={`card countdown-card status-${status}`}>
        {status === 'none' && (
          <>
            <p className="cd-label">No feedings yet</p>
            <p className="cd-time">—</p>
            <p className="cd-sub">Log the first feeding below</p>
          </>
        )}

        {status === 'ok' && (() => {
          // In OK state: count down to the PREPARE time (1h30m after last feed)
          const prepareTs = lastFeeding!.timestamp + FEED_INTERVAL_MS - PREPARE_WARN_MS
          const cd = formatCountdown(prepareTs - now)
          return (
            <>
              <p className="cd-label">Can prepare in</p>
              <p className="cd-time">
                {cd.h > 0 && <><span>{cd.h}</span><small>h </small></>}
                <span>{cd.m}</span><small>m</small>
              </p>
              <div className="cd-rows">
                <div className="cd-row"><span>prep milk</span><span>{formatTime(nextFeedTs! - PREPARE_WARN_MS)}</span></div>
                <div className="cd-row"><span>next feed</span><span>{formatTime(nextFeedTs!)}</span></div>
                <div className="cd-row"><span>last fed</span><span>{formatTime(lastFeeding!.timestamp)}</span></div>
              </div>
            </>
          )
        })()}

        {status === 'prepare' && countdown && (
          <>
            <p className="cd-label">🍼 Can Prepare!</p>
            <p className="cd-time">
              {countdown.h > 0 && <><span>{countdown.h}</span><small>h </small></>}
              <span>{countdown.m}</span><small>m</small>
            </p>
            <p className="cd-sub">
              next feed {formatTime(nextFeedTs!)} · {countdown.m}m away
            </p>
          </>
        )}

        {status === 'overdue' && countdown && (
          <>
            <p className="cd-label">Feeding overdue!</p>
            <p className="cd-time">
              +{countdown.h > 0 && <><span>{countdown.h}</span><small>h </small></>}
              <span>{countdown.m}</span><small>m</small>
            </p>
            <p className="cd-sub">
              last fed {formatTime(lastFeeding!.timestamp)} · {formatElapsed(now - lastFeeding!.timestamp)}
            </p>
          </>
        )}
      </div>

      {/* ── Prepare nudge banner (30-min window) ─────────────── */}
      {status === 'prepare' && (
        <div className="prepare-banner">
          <span className="prepare-icon">⏱️</span>
          <span>Time to warm the bottle — next feed in under 30 min</span>
        </div>
      )}

      {/* ── Stats row ─────────────────────────────────────────── */}
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
              onClick={() => setMilkType(prev => prev === t ? '' : t)}
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

        {/* Time preview */}
        <div className="time-preview">
          <span className="time-preview-label">Last fed was</span>
          <span className="time-preview-val">{formatTime(lastFeeding!.timestamp)}</span>
          <span className="time-preview-next">→ next feed ~{formatTime(now + FEED_INTERVAL_MS)}</span>
        </div>

        <button
          type="button"
          className={`log-btn ${justLogged ? 'logged' : ''}`}
          onClick={logFeeding}
        >
          {justLogged ? '✓ Logged!' : '🍼 Log Feed Now'}
        </button>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────── */}
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

      {/* ── Today ─────────────────────────────────────────────── */}
      {activeTab === 'today' && (
        <div className="card history-card">
          {todayFeedings.length === 0
            ? <p className="empty-state">No feedings logged today yet.</p>
            : (
              <ul className="feeding-list">
                {[...todayFeedings].reverse().map((f, i, arr) => {
                  const prev = arr[i + 1]
                  const gap = prev ? f.timestamp - prev.timestamp : null
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
                          {f.note && <span className="feeding-note">{f.note}</span>}
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
            )
          }
        </div>
      )}

      {/* ── History ───────────────────────────────────────────── */}
      {activeTab === 'history' && (
        <div className="card history-card">
          {pastDates.length === 0
            ? <p className="empty-state">No past feedings recorded.</p>
            : pastDates.map(dk => {
                const items = grouped[dk]
                const total = items.reduce((s, f) => s + f.oz, 0)
                return (
                  <div key={dk} className="history-day">
                    <div className="history-day-header">
                      <span className="history-day-label">{formatDate(items[0].timestamp)}</span>
                      <span className="history-day-total">{total.toFixed(1)}oz · {items.length}x</span>
                    </div>
                    <ul className="feeding-list">
                      {[...items].reverse().map(f => (
                        <li key={f.id} className="feeding-item">
                          <div className="feeding-row">
                            <div className="feeding-left">
                              <span className="feeding-oz">{f.oz}oz</span>
                              {f.note && <span className="feeding-note">{f.note}</span>}
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
                      ))}
                    </ul>
                  </div>
                )
              })
          }
        </div>
      )}

    </div>
  )
}
