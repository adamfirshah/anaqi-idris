import { useCallback, useState } from 'react'
import { getToken, onMessage } from 'firebase/messaging'
import { getMessagingInstance, VAPID_KEY } from '../lib/firebase'
import { supabase } from '../lib/supabase'

export function usePushNotifications(userId: string | undefined) {
  const [notiStatus, setNotiStatus] = useState<'off' | 'on' | 'unsupported'>('off')
  const [notiError, setNotiError] = useState('')

  const enableNotifications = useCallback(async () => {
    if (!userId) return
    setNotiError('')

    if (!('Notification' in window)) {
      setNotiStatus('unsupported')
      return
    }

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      setNotiError('Notification permission denied')
      return
    }

    const messaging = await getMessagingInstance()
    if (!messaging) {
      setNotiStatus('unsupported')
      setNotiError('Push not supported on this browser')
      return
    }

    if (!VAPID_KEY) {
      setNotiError('Missing VITE_FIREBASE_VAPID_KEY in .env.local')
      return
    }

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js')

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    })

    if (!token) {
      setNotiError('Could not get FCM token')
      return
    }

    const { error } = await supabase.from('fcm_tokens').upsert(
      {
        user_id: userId,
        token,
        platform: navigator.userAgent.includes('iPhone') ? 'ios' : 'web',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,token' },
    )

    if (error) {
      setNotiError(error.message)
      return
    }

    onMessage(messaging, payload => {
      const title = payload.notification?.title ?? "Anaqi's Milk"
      const body = payload.notification?.body ?? ''
      if (document.visibilityState === 'visible') {
        new Notification(title, { body, icon: '/icon.png' })
      }
    })

    setNotiStatus('on')
  }, [userId])

  return { notiStatus, notiError, enableNotifications }
}
