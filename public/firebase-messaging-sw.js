/* eslint-disable no-undef */
importScripts('/firebase-sw-config.js')
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging-compat.js')

firebase.initializeApp(self.FIREBASE_CONFIG)

const messaging = firebase.messaging()

messaging.onBackgroundMessage(payload => {
  const noti = payload.notification ?? payload.webpush?.notification ?? {}
  const title = noti.title ?? "Anaqi's Milk"
  const body = noti.body ?? 'Time to check on feeding'
  const icon = noti.icon ?? payload.data?.icon ?? '/icon.png'
  self.registration.showNotification(title, {
    body,
    icon,
    badge: icon,
    tag: 'anaqi-reminder',
    data: payload.data,
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
