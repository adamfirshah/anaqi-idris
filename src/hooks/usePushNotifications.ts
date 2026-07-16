import { useCallback, useEffect, useRef, useState } from 'react'
import { getToken, onMessage } from 'firebase/messaging'
import { getMessagingInstance, VAPID_KEY } from '../lib/firebase'
import { iosPushBlockedReason, registerFirebaseServiceWorker } from '../lib/push'
import { supabase } from '../lib/supabase'

const ALERTS_ENABLED_KEY = 'anaqi-alerts-enabled'

async function saveToken(userId: string, token: string) {
  const { error } = await supabase.from('fcm_tokens').upsert(
    {
      user_id: userId,
      token,
      platform: navigator.userAgent.includes('iPhone') ? 'ios' : 'web',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,token' },
  )
  if (error) throw error
}

export function usePushNotifications(userId: string | undefined) {
  const [notiStatus, setNotiStatus] = useState<'off' | 'on' | 'unsupported'>(() =>
    localStorage.getItem(ALERTS_ENABLED_KEY) === '1' ? 'on' : 'off',
  )
  const [notiError, setNotiError] = useState('')
  const [iosHint, setIosHint] = useState('')
  const listenerReady = useRef(false)

  useEffect(() => {
    const blocked = iosPushBlockedReason()
    if (blocked) setIosHint(blocked)
    registerFirebaseServiceWorker().catch(() => {})
  }, [])

  const setupForegroundListener = useCallback(async () => {
    if (listenerReady.current) return
    const messaging = await getMessagingInstance()
    if (!messaging) return
    listenerReady.current = true
    onMessage(messaging, payload => {
      const title = payload.notification?.title ?? "Anaqi Idris's Milk"
      const body = payload.notification?.body ?? ''
      if (document.visibilityState === 'visible') {
        new Notification(title, { body, icon: '/icon.png' })
      }
    })
  }, [])

  const syncToken = useCallback(
    async (requestPermission: boolean) => {
      if (!userId) return false
      setNotiError('')

      const iosBlocked = iosPushBlockedReason()
      if (iosBlocked) {
        setIosHint(iosBlocked)
        setNotiError(iosBlocked)
        return false
      }

      if (!('Notification' in window)) {
        setNotiStatus('unsupported')
        return false
      }

      let permission = Notification.permission
      if (requestPermission) {
        permission = await Notification.requestPermission()
      }
      if (permission !== 'granted') {
        if (requestPermission) setNotiError('Notification permission denied')
        localStorage.removeItem(ALERTS_ENABLED_KEY)
        setNotiStatus('off')
        return false
      }

      const messaging = await getMessagingInstance()
      if (!messaging) {
        setNotiStatus('unsupported')
        setNotiError('Push not supported on this browser')
        return false
      }

      if (!VAPID_KEY) {
        setNotiError('Missing VITE_FIREBASE_VAPID_KEY')
        return false
      }

      const registration = await registerFirebaseServiceWorker()
      if (!registration) {
        setNotiError('Could not register notification service worker')
        return false
      }

      const token = await getToken(messaging, {
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: registration,
      })

      if (!token) {
        if (requestPermission) setNotiError('Could not get FCM token')
        return false
      }

      await saveToken(userId, token)
      await setupForegroundListener()
      localStorage.setItem(ALERTS_ENABLED_KEY, '1')
      setNotiStatus('on')
      return true
    },
    [userId, setupForegroundListener],
  )

  // Re-register FCM token silently when app reopens (permission already granted)
  useEffect(() => {
    if (!userId) return
    if (localStorage.getItem(ALERTS_ENABLED_KEY) !== '1') return
    if (Notification.permission !== 'granted') {
      localStorage.removeItem(ALERTS_ENABLED_KEY)
      setNotiStatus('off')
      return
    }
    syncToken(false).catch(() => {
      localStorage.removeItem(ALERTS_ENABLED_KEY)
      setNotiStatus('off')
    })
  }, [userId, syncToken])

  const enableNotifications = useCallback(async () => {
    await syncToken(true)
  }, [syncToken])

  return { notiStatus, notiError, iosHint, enableNotifications }
}
