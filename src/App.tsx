import { useState } from 'react'
import { useAuth } from './hooks/useAuth'
import { useFamily } from './hooks/useFamily'
import { isGuestSession } from './lib/invite'
import AuthScreen from './components/AuthScreen'
import InviteCodeScreen from './components/InviteCodeScreen'
import JoinFamilyScreen from './components/JoinFamilyScreen'
import LoadingScreen from './components/LoadingScreen'
import MilkTracker from './components/MilkTracker'

type Screen = 'invite' | 'login'

export default function App() {
  const { session, loading: authLoading, signOut } = useAuth()
  const { family, loading: familyLoading, refresh, hasFamily } = useFamily(session)
  const [screen, setScreen] = useState<Screen>('invite')

  if (authLoading || familyLoading) return <LoadingScreen />


  
  // Logged in + in family → straight to tracker
  if (session && hasFamily && family) {
    return (
      <MilkTracker
        session={session}
        family={family}
        onSignOut={signOut}
        showSignOut={!isGuestSession(session)}
      />
    )
  }

  // Babah logged in but no family yet → create family
  if (session && !isGuestSession(session)) {
    return <JoinFamilyScreen onJoined={refresh} />
  }

  // Not logged in → invite code first, login optional for Babah
  if (screen === 'login') {
    return <AuthScreen onBack={() => setScreen('invite')} />
  }

  return (
    <InviteCodeScreen
      onJoined={refresh}
      onBabahLogin={() => setScreen('login')}
    />
  )
}
