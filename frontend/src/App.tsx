import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { getMe } from './lib/api'
import type { AppUser } from './lib/types'
import type { Session } from '@supabase/supabase-js'
import LandingPage from './pages/LandingPage'
import PaymentPage from './pages/PaymentPage'
import OnboardingPage from './pages/OnboardingPage'
import DashboardPage from './pages/DashboardPage'
import AdminPage from './pages/AdminPage'
import Layout from './components/Layout'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<AppUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) loadUser()
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) loadUser()
      else {
        setUser(null)
        setLoading(false)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadUser() {
    try {
      const me = await getMe()
      setUser(me)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  function refreshUser() {
    loadUser()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  if (!session) {
    const isSignup = window.location.pathname === '/signup'
    return <LandingPage initialMode={isSignup ? 'signup' : 'login'} />
  }

  const status = user?.onboarding_status || 'pending'
  const isAdminRoute = window.location.pathname.startsWith('/admin')
  const isSuperadmin = user?.role === 'superadmin'

  return (
    <Layout onLogout={() => supabase.auth.signOut()} user={user}>
      {isAdminRoute && isSuperadmin && <AdminPage />}
      {isAdminRoute && !isSuperadmin && (
        <div className="p-8 text-red-600">
          403 — superadmin access required.
        </div>
      )}
      {!isAdminRoute && status === 'pending' && <PaymentPage onComplete={refreshUser} />}
      {!isAdminRoute && status === 'payment_done' && (
        <OnboardingPage user={user!} onComplete={refreshUser} />
      )}
      {!isAdminRoute && status === 'complete' && <DashboardPage />}
    </Layout>
  )
}
