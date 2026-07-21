/* eslint-disable no-undef */
importScripts('/firebase-sw-config.js')
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging-compat.js')

firebase.initializeApp(self.FIREBASE_CONFIG)

const messaging = firebase.messaging()

messaging.onBackgroundMessage(payload => {
  // Data-only messages — show once here (no webpush.notification to avoid double pop-up)
  const d = payload.data ?? {}
  const title = d.title ?? "Anaqi's Milk"
  const body = d.body ?? ''
  const icon = d.icon ?? '/icon.png'
  const tag = d.tag ?? 'anaqi-reminder'
  self.registration.showNotification(title, {
    body,
    icon,
    badge: icon,
    tag,
    data: d,
  })
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus()
      }
      if (clients.openWindow) return clients.openWindow('/')
    }),
  )
})
