import { useAuth } from './hooks/useAuth'
import { useFamily } from './hooks/useFamily'
import AuthScreen from './components/AuthScreen'
import JoinFamilyScreen from './components/JoinFamilyScreen'
import LoadingScreen from './components/LoadingScreen'
import MilkTracker from './components/MilkTracker'

export default function App() {
  const { session, loading: authLoading, signOut } = useAuth()
  const { family, loading: familyLoading, refresh, hasFamily } = useFamily(session)

  if (authLoading) return <LoadingScreen />
  if (!session) return <AuthScreen />
  if (familyLoading) return <LoadingScreen />
  if (!hasFamily || !family) return <JoinFamilyScreen onJoined={refresh} />

  return (
    <MilkTracker
      session={session}
      family={family}
      onSignOut={signOut}
    />
  )
}
