export type MilkType = 'FM' | 'EBM' | 'BM'

export interface FeedingRow {
  id: string
  family_id: string
  logged_at: string
  oz: number
  milk_type: MilkType | null
  note: string | null
  logged_by: string | null
  created_at: string
}

export interface Feeding {
  id: string
  timestamp: number
  oz: number
  milkType: MilkType | null
  note: string
}

export interface FamilyInfo {
  familyId: string
  name: string
  inviteCode: string
}

export function rowToFeeding(row: FeedingRow): Feeding {
  return {
    id: row.id,
    timestamp: new Date(row.logged_at).getTime(),
    oz: Number(row.oz),
    milkType: row.milk_type,
    note: row.note ?? '',
  }
}

export function feedingDisplayNote(f: Feeding): string {
  return [f.milkType, f.note.trim()].filter(Boolean).join(' · ')
}

export type PumpSide = 'L' | 'R' | 'Both'

export interface PumpSessionRow {
  id: string
  family_id: string
  logged_at: string
  oz: number
  side: PumpSide | null
  duration_min: number | null
  note: string | null
  logged_by: string | null
  created_at: string
}

export interface PumpSession {
  id: string
  timestamp: number
  oz: number
  side: PumpSide | null
  durationMin: number | null
  note: string
}

export function rowToPumpSession(row: PumpSessionRow): PumpSession {
  return {
    id: row.id,
    timestamp: new Date(row.logged_at).getTime(),
    oz: Number(row.oz),
    side: row.side,
    durationMin: row.duration_min,
    note: row.note ?? '',
  }
}

export function pumpDisplayNote(s: PumpSession): string {
  const parts: string[] = []
  if (s.side) parts.push(s.side === 'Both' ? 'Both sides' : `${s.side} side`)
  if (s.durationMin) parts.push(`${s.durationMin} min`)
  if (s.note.trim()) parts.push(s.note.trim())
  return parts.join(' · ')
}

export interface BabyMeasurementRow {
  id: string
  family_id: string
  measured_at: string
  weight_kg: number | null
  height_cm: number | null
  logged_by: string | null
  created_at: string
  updated_at: string
}

export interface BabyMeasurement {
  id: string
  measuredAt: number
  weightKg: number | null
  heightCm: number | null
}

export function rowToBabyMeasurement(row: BabyMeasurementRow): BabyMeasurement {
  return {
    id: row.id,
    measuredAt: new Date(row.measured_at).getTime(),
    weightKg: row.weight_kg != null ? Number(row.weight_kg) : null,
    heightCm: row.height_cm != null ? Number(row.height_cm) : null,
  }
}

export type PoopType = 'Poo' | 'Pee' | 'Both'

export interface PoopLogRow {
  id: string
  family_id: string
  logged_at: string
  poop_type: PoopType
  note: string | null
  logged_by: string | null
  created_at: string
}

export interface PoopLog {
  id: string
  timestamp: number
  poopType: PoopType
  note: string
}

export function rowToPoopLog(row: PoopLogRow): PoopLog {
  return {
    id: row.id,
    timestamp: new Date(row.logged_at).getTime(),
    poopType: row.poop_type,
    note: row.note ?? '',
  }
}

export function poopDisplayText(poopType: PoopType): string {
  if (poopType === 'Pee') return 'Idris peed!'
  if (poopType === 'Both') return 'Idris pooped & peed!'
  return 'Idris pooped!'
}
