export function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })
}

export function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString('en-MY', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

export function todayStr() {
  return new Date().toDateString()
}

export function formatCountdown(ms: number): { h: number; m: number; overdue: boolean } {
  const overdue = ms < 0
  const abs = Math.abs(ms)
  const totalMin = Math.floor(abs / 60_000)
  return { h: Math.floor(totalMin / 60), m: totalMin % 60, overdue }
}

export function formatElapsed(ms: number) {
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return 'just now'
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`
  return `${m}m ago`
}

export function toTimeInputValue(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function todayTimeInputToTimestamp(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}
