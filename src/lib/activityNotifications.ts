import { supabase } from './supabase'

type ActivityNotification =
  | {
      type: 'milk'
      familyId: string
      oz: number
      milkType: string | null
    }
  | {
      type: 'poop' | 'appeton' | 'direct_feed'
      familyId: string
    }

export async function notifyFamilyOfActivity(
  activity: ActivityNotification,
): Promise<void> {
  const { error } = await supabase.functions.invoke('send-feed-reminders', {
    body: { activity },
  })

  if (error) {
    console.error('Could not send family activity notification:', error)
  }
}
