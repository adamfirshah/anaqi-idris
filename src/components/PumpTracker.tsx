import { useState, useEffect, useCallback } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import {
  formatTime,
  formatDate,
  formatDatePill,
  todayStr,
  formatCountdown,
  formatElapsed,
  toTimeInputValue,
  todayTimeInputToTimestamp,
} from '../lib/format'
import type {
  DirectFeedLog,
  FamilyInfo,
  PumpSession,
  PumpSessionRow,
} from '../types/database'
import { rowToPumpSession, pumpDisplayNote } from '../types/database'

const PUMP_INTERVAL_MS = 3 * 60 * 60 * 1000
const PUMP_WARN_MS = 30 * 60 * 1000
const QUICK_OZ = [1, 1.5, 2, 2.5, 3, 4]
const FORGOT_AGO_MIN = [15, 30, 45, 60] as const

const FED_IDS_KEY = 'pump-fed-ids'

function loadFedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(FED_IDS_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function saveFedIds(ids: Set<string>) {
  try {
    localStorage.setItem(FED_IDS_KEY, JSON.stringify([...ids]))
  } catch {
    // storage unavailable — fed state stays in memory only
  }
}

type Status = 'none' | 'ok' | 'due' | 'overdue'

function getStatus(lastTs: number | null, now: number): Status {
  if (!lastTs) return 'none'
  const remaining = PUMP_INTERVAL_MS - (now - lastTs)
  if (remaining < 0) return 'overdue'
  if (remaining <= PUMP_WARN_MS) return 'due'
  return 'ok'
}

interface Props {
  session: Session
  family: FamilyInfo
  directFeeds: DirectFeedLog[]
  lastDirectFeed: DirectFeedLog | null
  waitingForCue: boolean
  lastBottleFeedTs: number | null
  feedIntervalMs: number
  onRemoveDirectFeed: (id: string) => void
}

type PumpLogItem =
  | { kind: 'session'; session: PumpSession; timestamp: number }
  | { kind: 'direct_feed'; feed: DirectFeedLog; timestamp: number }

export default function PumpTracker({
  session,
  family,
  directFeeds,
  lastDirectFeed,
  waitingForCue,
  lastBottleFeedTs,
  feedIntervalMs,
  onRemoveDirectFeed,
}: Props) {
  const [sessions, setSessions] = useState<PumpSession[]>([])
  const [loading, setLoading] = useState(true)
  const [oz, setOz] = useState('2')
  const [note, setNote] = useState('')
  const [now, setNow] = useState(Date.now())
  const [justLogged, setJustLogged] = useState(false)
  const [activeTab, setActiveTab] = useState<'today' | 'history'>('today')
  const [selectedDateKey, setSelectedDateKey] = useState(todayStr())
  const [forgotOpen, setForgotOpen] = useState(false)
  const [forgotTime, setForgotTime] = useState(() => toTimeInputValue(Date.now() - 30 * 60 * 1000))
  const [error, setError] = useState('')
  const [fedIds, setFedIds] = useState<Set<string>>(loadFedIds)
  const isFed = (s: PumpSession) => s.fed || fedIds.has(s.id)

  const fetchSessions = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from('pump_sessions')
      .select('*')
      .order('logged_at', { ascending: true })

    if (fetchError) {
      setError(fetchError.message)
    } else {
      setSessions((data as PumpSessionRow[]).map(rowToPumpSession))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchSessions()

    const sessionsChannel = supabase
      .channel('pump-sessions-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pump_sessions' },
        () => fetchSessions(),
      )
      .subscribe()

    return () => {
      supabase.removeChannel(sessionsChannel)
    }
  }, [fetchSessions])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null
  const lastDirectTs = lastDirectFeed?.timestamp ?? null
  const lastSessionTs = lastSession?.timestamp ?? null
  const lastPumpAnchorTs =
    lastDirectTs != null && (lastSessionTs == null || lastDirectTs > lastSessionTs)
      ? lastDirectTs
      : lastSessionTs
  const lastWasDirectFeed =
    lastDirectTs != null && lastPumpAnchorTs === lastDirectTs
  const nextPumpTs =
    lastPumpAnchorTs != null ? lastPumpAnchorTs + PUMP_INTERVAL_MS : null
  const remaining = nextPumpTs ? nextPumpTs - now : null
  const status = getStatus(lastPumpAnchorTs, now)
  const countdown = remaining !== null ? formatCountdown(remaining) : null

  const todaySessions = sessions.filter(
    s => new Date(s.timestamp).toDateString() === todayStr(),
  )
  const dailyOz = todaySessions.reduce((sum, s) => (isFed(s) ? sum : sum + s.oz), 0)
  const fedFreshCount = todaySessions.filter(isFed).length
  const todayDirectFeeds = directFeeds.filter(
    s => new Date(s.timestamp).toDateString() === todayStr(),
  )
  const todayActivityCount = todaySessions.length + todayDirectFeeds.length

  const grouped = sessions.reduce<Record<string, PumpSession[]>>((acc, s) => {
    const k = new Date(s.timestamp).toDateString()
    ;(acc[k] ??= []).push(s)
    return acc
  }, {})

  const allDateKeys = [
    ...new Set([
      ...sessions.map((s) => new Date(s.timestamp).toDateString()),
      ...directFeeds.map((f) => new Date(f.timestamp).toDateString()),
    ]),
  ].sort((a, b) => new Date(b).getTime() - new Date(a).getTime())

  const pastDates = allDateKeys.filter((k) => k !== todayStr())
  const historyDateKeys = pastDates
  const visibleDateKeys =
    activeTab === 'today' ? [todayStr()] : historyDateKeys.length > 0 ? historyDateKeys : allDateKeys

  const selectedSessions = sessions.filter(
    s => new Date(s.timestamp).toDateString() === selectedDateKey,
  )
  const selectedDirectFeeds = directFeeds.filter(
    f => new Date(f.timestamp).toDateString() === selectedDateKey,
  )
  const selectedLog: PumpLogItem[] = [
    ...selectedSessions.map((sessionItem) => ({
      kind: 'session' as const,
      session: sessionItem,
      timestamp: sessionItem.timestamp,
    })),
    ...selectedDirectFeeds.map((feed) => ({
      kind: 'direct_feed' as const,
      feed,
      timestamp: feed.timestamp,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp)
  const selectedTotal = selectedSessions.reduce((sum, s) => sum + s.oz, 0)
  const hasSelectedActivity = selectedLog.length > 0

  const logSession = useCallback(async (loggedAtTs: number) => {
    const parsed = parseFloat(oz)
    if (!parsed || parsed <= 0 || parsed > 20) return

    setError('')
    const { error: insertError } = await supabase.from('pump_sessions').insert({
      family_id: family.familyId,
      logged_at: new Date(loggedAtTs).toISOString(),
      oz: parsed,
      side: null,
      duration_min: null,
      note: note.trim() || null,
      logged_by: session.user.id,
    })

    if (insertError) {
      setError(insertError.message)
      return
    }

    setNote('')
    setForgotOpen(false)
    setJustLogged(true)
    setTimeout(() => setJustLogged(false), 2000)
    fetchSessions()
  }, [oz, note, family.familyId, session.user.id, fetchSessions])

  const forgotTs = todayTimeInputToTimestamp(forgotTime)
  const forgotValid =
    forgotTs <= Date.now() &&
    (!lastSession || forgotTs > lastSession.timestamp)

  const removeSession = useCallback(
    async (id: string) => {
      const { error: deleteError } = await supabase.from('pump_sessions').delete().eq('id', id)
      if (deleteError) setError(deleteError.message)
      else fetchSessions()
    },
    [fetchSessions],
  )

  const toggleFed = useCallback(
    async (id: string, fed: boolean) => {
      setError('')
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, fed } : s)))
      setFedIds((prev) => {
        const next = new Set(prev)
        if (fed) next.add(id)
        else next.delete(id)
        saveFedIds(next)
        return next
      })
      // Sync to DB when the `fed` column exists (supabase/pump_sessions_fed.sql);
      // local state above keeps the button working either way.
      const { error: updateError } = await supabase
        .from('pump_sessions')
        .update({ fed })
        .eq('id', id)
      if (updateError && !['42703', 'PGRST204'].includes(updateError.code)) setError(updateError.message)
    },
    [],
  )

  if (loading) {
    return (
      <div className="pump-loading">
        <div className="loading-spinner">🤱</div>
      </div>
    )
  }

  return (
    <>
      {error && <p className="auth-error" style={{ marginBottom: '0.75rem' }}>{error}</p>}

      <div className={`card countdown-card pump-card status-${waitingForCue && lastWasDirectFeed && status === 'ok' ? 'cue' : status}`}>
        {waitingForCue && lastDirectFeed && lastWasDirectFeed && status === 'ok' && nextPumpTs && lastPumpAnchorTs != null && (
          <>
            <p className="cd-label">🤱 Idris just had Direct feed</p>
            <p className="cd-time cd-time-cue">Watch for cue</p>
            {(() => {
              const dueTs = lastPumpAnchorTs + PUMP_INTERVAL_MS - PUMP_WARN_MS
              const cd = formatCountdown(dueTs - now)
              return (
                <div className="cd-rows">
                  <div className="cd-row">
                    <span>Next pump in</span>
                    <span>
                      {cd.h > 0 ? `${cd.h}h ` : ''}{cd.m}m
                    </span>
                  </div>
                  <div className="cd-row"><span>Last direct feed</span><span>{formatTime(lastDirectFeed.timestamp)}</span></div>
                  <div className="cd-row"><span>Next pump</span><span>{formatTime(nextPumpTs)}</span></div>
                  <div className="cd-row"><span>Since last</span><span>{formatElapsed(now - lastDirectFeed.timestamp)}</span></div>
                </div>
              )
            })()}
            {lastBottleFeedTs && (
              <p className="cd-sub">
                Supposed next bottle feed{" "}
                {formatTime(lastBottleFeedTs + feedIntervalMs)}
              </p>
            )}
          </>
        )}

        {status === 'none' && !(waitingForCue && lastWasDirectFeed) && (
          <>
            <p className="cd-label">No pump sessions yet</p>
            <p className="cd-time">—</p>
            <p className="cd-sub">Log your first session below</p>
          </>
        )}

        {status === 'ok' && lastPumpAnchorTs != null && nextPumpTs && !(waitingForCue && lastWasDirectFeed) && (() => {
          const dueTs = lastPumpAnchorTs + PUMP_INTERVAL_MS - PUMP_WARN_MS
          const cd = formatCountdown(dueTs - now)
          return (
            <>
              <p className="cd-label">Next pump in</p>
              <p className="cd-time">
                {cd.h > 0 && <><span>{cd.h}</span><small>h </small></>}
                <span>{cd.m}</span><small> m</small>
              </p>
              <div className="cd-rows">
                <div className="cd-row">
                  <span>{lastWasDirectFeed ? 'Last direct feed' : 'Last pumped'}</span>
                  <span>{formatTime(lastPumpAnchorTs)}</span>
                </div>
                <div className="cd-row"><span>Next pump</span><span>{formatTime(nextPumpTs)}</span></div>
                <div className="cd-row"><span>Since last</span><span>{formatElapsed(now - lastPumpAnchorTs)}</span></div>
              </div>
            </>
          )
        })()}

        {status === 'due' && countdown && nextPumpTs && (
          <>
            {waitingForCue && lastWasDirectFeed && lastDirectFeed && (
              <p className="cd-sub">Watch for cue · last direct feed {formatTime(lastDirectFeed.timestamp)}</p>
            )}
            <p className="cd-label">🤱 Pump soon!</p>
            <p className="cd-time">
              {countdown.h > 0 && <><span>{countdown.h}</span><small>h </small></>}
              <span>{countdown.m}</span><small>m</small>
            </p>
            <p className="cd-sub">
              next pump{formatTime(nextPumpTs)} · {countdown.m}m away
              {lastWasDirectFeed ? ' · from last direct feed' : ''}
            </p>
          </>
        )}

        {status === 'overdue' && countdown && lastPumpAnchorTs != null && (
          <>
            <p className="cd-label">Time to pump!</p>
            <p className="cd-time">
              +{countdown.h > 0 && <><span>{countdown.h}</span><small>h </small></>}
              <span>{countdown.m}</span><small>m</small>
            </p>
            <p className="cd-sub">
              {lastWasDirectFeed ? 'last direct feed' : 'last pumped'} {formatTime(lastPumpAnchorTs)} · {formatElapsed(now - lastPumpAnchorTs)} ago
            </p>
          </>
        )}
      </div>

      {(status === 'due' || status === 'overdue') && (
        <div className="prepare-banner pump-banner">
          <span className="prepare-icon">⏱️</span>
          <span>Good time to pump — helps keep supply steady for Idris</span>
        </div>
      )}

      <div className="stats-row stats-row-pump">
        <div className="stat-box pump-stat">
          <span className="stat-value">{todaySessions.length}</span>
          <p className="stat-label">Sessions</p>
        </div>
        <div className="stat-box pump-stat">
          <span className="stat-value">{dailyOz.toFixed(1)}</span>
          <span className="stat-unit">oz</span>
          <p className="stat-label">Pumped today</p>
        </div>
        <div className="stat-box pump-stat">
          <span className="stat-value">{fedFreshCount}</span>
          <p className="stat-label">Fed Fresh</p>
        </div>
        <div className="stat-box pump-stat">
          <span className="stat-value">
            {lastPumpAnchorTs ? formatTime(lastPumpAnchorTs) : '—'}
          </span>
          <p className="stat-label">{lastWasDirectFeed ? 'Last direct feed' : 'Last pump'}</p>
        </div>
        <div className="stat-box pump-stat">
          <span className="stat-value">
            {nextPumpTs ? formatTime(nextPumpTs) : '—'}
          </span>
          <p className="stat-label">Next pump</p>
        </div>
      </div>

      <div className="card log-card pump-log">
        <h2 className="card-title">Log pump session</h2>

        <p className="section-label">Amount pumped</p>
        <div className="oz-row">
          {QUICK_OZ.map(q => (
            <button
              key={q}
              type="button"
              className={`oz-btn pump-oz-btn ${oz === String(q) ? 'active' : ''}`}
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
            max="20"
            step="0.5"
            inputMode="decimal"
            aria-label="Custom oz amount"
          />
          <span className="oz-unit">oz</span>
        </div>

        <p className="section-label">Remark (optional)</p>
        <input
          type="text"
          className="note-input"
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder="e.g. both sides, 20mins"
          maxLength={80}
        />

        <button
          type="button"
          className={`log-btn pump-log-btn ${justLogged ? 'logged' : ''}`}
          onClick={() => logSession(Date.now())}
        >
          {justLogged ? '✓ Logged!' : '🤱 Log Pump Now'}
        </button>

        <button
          type="button"
          className="forgot-toggle"
          onClick={() => setForgotOpen(open => !open)}
        >
          {forgotOpen ? 'Hide' : 'Forgot to log?'}
        </button>

        {forgotOpen && (
          <div className="forgot-panel">
            <p className="section-label">When did you pump?</p>
            <div className="oz-row">
              {FORGOT_AGO_MIN.map(m => (
                <button
                  key={m}
                  type="button"
                  className="oz-btn pump-oz-btn forgot-ago-btn"
                  onClick={() => setForgotTime(toTimeInputValue(Date.now() - m * 60 * 1000))}
                >
                  {m}m ago
                </button>
              ))}
            </div>
            <div className="custom-row">
              <input
                type="time"
                className="oz-input forgot-time-input"
                value={forgotTime}
                onChange={e => setForgotTime(e.target.value)}
                aria-label="Pump time"
              />
            </div>
            {nextPumpTs && (
              <p className="forgot-hint">Scheduled was ~{formatTime(nextPumpTs)}</p>
            )}
            {!forgotValid && (
              <p className="forgot-error">Pick a time after last pump and not in the future</p>
            )}
            <div className="time-preview">
              <span className="time-preview-label">Will log</span>
              <span className="time-preview-val">{oz}oz at {formatTime(forgotTs)}</span>
              <span className="time-preview-next">
                → next pump
                {formatTime(forgotTs + PUMP_INTERVAL_MS)}
              </span>
            </div>
            <button
              type="button"
              className="log-btn log-btn-missed pump-log-btn-missed"
              disabled={!forgotValid}
              onClick={() => logSession(forgotTs)}
            >
              Log {oz}oz at {formatTime(forgotTs)}
            </button>
          </div>
        )}
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab-btn pump-tab ${activeTab === 'today' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('today')
            setSelectedDateKey(todayStr())
          }}
        >
          Today
          {todayActivityCount > 0 && <span className="tab-badge">{todayActivityCount}</span>}
        </button>
        <button
          type="button"
          className={`tab-btn pump-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('history')
            const firstPast = allDateKeys.find(k => k !== todayStr())
            setSelectedDateKey(firstPast ?? todayStr())
          }}
        >
          History
          {pastDates.length > 0 && <span className="tab-badge">{pastDates.length}</span>}
        </button>
      </div>

      <div className="card history-card">
        {activeTab === 'history' && pastDates.length === 0 ? (
          <p className="empty-state">No past activity recorded.</p>
        ) : (
          <>
            {activeTab === 'history' && visibleDateKeys.length > 0 && (
              <div className="date-strip-wrap">
                <p className="date-strip-label">Pick a day</p>
                <div className="date-strip">
                  {visibleDateKeys.map(dk => {
                    const dayItems = grouped[dk] ?? sessions.filter(
                      s => new Date(s.timestamp).toDateString() === dk,
                    )
                    const dayDirectCount = directFeeds.filter(
                      f => new Date(f.timestamp).toDateString() === dk,
                    ).length
                    const dayTotal = dayItems.reduce((sum, s) => sum + s.oz, 0)
                    return (
                      <button
                        key={dk}
                        type="button"
                        className={`date-pill date-pill-pump ${selectedDateKey === dk ? 'active' : ''}`}
                        onClick={() => setSelectedDateKey(dk)}
                      >
                        <span className="date-pill-label">{formatDatePill(dk)}</span>
                        <span className="date-pill-oz">{dayTotal.toFixed(1)}oz</span>
                        <span className="date-pill-count">{dayItems.length + dayDirectCount}x</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {!hasSelectedActivity ? (
              <p className="empty-state">
                {activeTab === 'today'
                  ? 'No activity logged today yet.'
                  : 'No activity on this day.'}
              </p>
            ) : (
              <>
                <div className="day-hero day-hero-pump">
                  <div className="day-hero-left">
                    <span className="day-hero-date">
                      {formatDate(
                        selectedLog[0]?.timestamp ?? Date.now(),
                      )}
                    </span>
                    <span className="day-hero-count">
                      {[
                        selectedSessions.length > 0 &&
                          `${selectedSessions.length} session${selectedSessions.length !== 1 ? 's' : ''}`,
                        selectedDirectFeeds.length > 0 &&
                          `${selectedDirectFeeds.length} direct feed${selectedDirectFeeds.length !== 1 ? 's' : ''}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  <div className="day-hero-oz">
                    <span className="day-hero-oz-num">{selectedTotal.toFixed(1)}</span>
                    <span className="day-hero-oz-unit">oz total</span>
                  </div>
                </div>

                <ul className="feeding-list feed-list-v2">
                  {[...selectedLog].reverse().map((item, i, arr) => {
                    const prevItem = arr[i + 1]
                    const prevTs = prevItem?.timestamp ?? null
                    const ts = item.timestamp
                    const gap = prevTs ? ts - prevTs : null
                    const gapEl =
                      gap && activeTab === 'today' ? (
                        <div className="feeding-gap">
                          {formatCountdown(gap).h > 0
                            ? `${formatCountdown(gap).h}h ${formatCountdown(gap).m}m gap`
                            : `${formatCountdown(gap).m}m gap`}
                        </div>
                      ) : null

                    if (item.kind === 'direct_feed') {
                      const df = item.feed
                      return (
                        <li key={df.id} className="feeding-item">
                          {gapEl}
                          <div className="activity-log-row activity-direct-feed-row">
                            <span className="activity-log-icon">👶</span>
                            <div className="activity-log-meta">
                              <span className="activity-log-text">
                                Direct feed with Idris!
                              </span>
                              <span className="feed-time">{formatTime(df.timestamp)}</span>
                            </div>
                            {activeTab === 'today' && (
                              <button
                                type="button"
                                className="remove-btn"
                                onClick={() => onRemoveDirectFeed(df.id)}
                                aria-label="Remove direct feed log"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </li>
                      )
                    }

                    const s = item.session
                    const displayNote = pumpDisplayNote(s)
                    return (
                      <li key={s.id} className="feeding-item">
                        {gapEl}
                        <div className="feed-row">
                          <div className="feed-oz-block">
                            <span className="feed-oz-num">{s.oz}</span>
                            <span className="feed-oz-unit">oz</span>
                          </div>
                          <div className="feed-meta">
                            <span className="feed-time">{formatTime(s.timestamp)}</span>
                            {displayNote && <span className="feed-note">{displayNote}</span>}
                          </div>
                          {activeTab === 'today' && isFed(s) && (
                            <button
                              type="button"
                              className="pump-fed-undo"
                              onClick={() => toggleFed(s.id, false)}
                              aria-label="Undo fed"
                            >
                              Undo
                            </button>
                          )}
                          {activeTab === 'today' && (
                            <button
                              type="button"
                              className="pump-fed-btn"
                              onClick={() => toggleFed(s.id, true)}
                              disabled={isFed(s)}
                              aria-label="Mark as fed"
                            >
                              Feed
                            </button>
                          )}
                          {activeTab === 'today' && (
                            <button
                              type="button"
                              className="remove-btn"
                              onClick={() => removeSession(s.id)}
                              aria-label="Remove"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}
