import { initializeApp } from 'firebase/app'
import { getMessaging, isSupported, type Messaging } from 'firebase/messaging'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const firebaseApp = initializeApp(firebaseConfig)

let messagingPromise: Promise<Messaging | null> | null = null

export function getMessagingInstance() {
  if (!messagingPromise) {
    messagingPromise = isSupported().then(supported =>
      supported ? getMessaging(firebaseApp) : null,
    )
  }
  return messagingPromise
}

export const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY as string
