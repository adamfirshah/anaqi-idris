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
