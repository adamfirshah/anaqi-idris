export function isIosDevice() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
}

export function isStandalonePwa() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function iosPushBlockedReason(): string | null {
  if (!isIosDevice()) return null
  if (!isStandalonePwa()) {
    return 'On iPhone: tap Share → Add to Home Screen, then open the app from there and enable alerts.'
  }
  if (!('Notification' in window)) {
    return 'Notifications not supported in this browser.'
  }
  return null
}

export async function registerFirebaseServiceWorker() {
  if (!('serviceWorker' in navigator)) return null
  return navigator.serviceWorker.register('/firebase-messaging-sw.js')
}
