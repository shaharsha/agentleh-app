import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { getMe } from './lib/api'
import { useI18n } from './lib/i18n'
import type { AppUser } from './lib/types'
import type { Session } from '@supabase/supabase-js'
import LandingPage from './pages/LandingPage'
import PaymentPage from './pages/PaymentPage'
import OnboardingPage from './pages/OnboardingPage'
import AdminPage from './pages/AdminPage'
import TenantPage from './pages/TenantPage'
import InviteAcceptPage from './pages/InviteAcceptPage'
import Layout from './components/Layout'

const LS_ACTIVE_TENANT = 'agentleh.activeTenantId'

// Parse the current pathname into a routed page + tenant context.
// Kept intentionally homemade (no react-router) — the app is small and
// a regex match on window.location is all we need.
function parseRoute(pathname: string): {
  kind: 'invite-accept' | 'admin' | 'tenant' | 'root'
  tenantId?: number
  subpage?: 'dashboard' | 'members' | 'settings' | 'usage'
} {
  if (pathname.startsWith('/invites/accept')) return { kind: 'invite-accept' }
  if (pathname.startsWith('/admin')) return { kind: 'admin' }
  const m = pathname.match(/^\/tenants\/(\d+)(?:\/(dashboard|members|settings|usage))?/)
  if (m) {
    return {
      kind: 'tenant',
      tenantId: parseInt(m[1], 10),
      subpage: (m[2] as any) || 'dashboard',
    }
  }
  return { kind: 'root' }
}

export default function App() {
  const { t } = useI18n()
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<AppUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname))
  const [activeTenantId, setActiveTenantId] = useState<number | null>(() => {
    const fromLs = Number(localStorage.getItem(LS_ACTIVE_TENANT))
    return Number.isFinite(fromLs) && fromLs > 0 ? fromLs : null
  })

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

    const onPop = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', onPop)

    return () => {
      subscription.unsubscribe()
      window.removeEventListener('popstate', onPop)
    }
  }, [])

  async function loadUser() {
    try {
      const me = await getMe()
      setUser(me)
      // First-load tenant resolution: URL wins, then LS, then default.
      const current = parseRoute(window.location.pathname)
      if (current.kind === 'tenant' && current.tenantId) {
        setActiveTenantId(current.tenantId)
      } else if (me.default_tenant_id) {
        // Don't override a URL-parsed active tenant from a different route.
        if (!activeTenantId || !me.tenants?.some((t: any) => t.id === activeTenantId)) {
          setActiveTenantId(me.default_tenant_id)
        }
        // Auto-redirect complete tenant users from / → /tenants/:id so the
        // URL, the container width (Layout reads window.location), and the
        // browser history all agree. Without this, TenantPage renders at /
        // inside the narrow onboarding-style max-w-[560px] wrapper, and the
        // first tab click visibly swaps the layout. Only redirect when the
        // user is fully onboarded — payment_done / pending users need the
        // root path to show PaymentPage / OnboardingPage.
        if (
          current.kind === 'root' &&
          me.onboarding_status === 'complete' &&
          me.default_tenant_id
        ) {
          const tid = activeTenantId || me.default_tenant_id
          window.history.replaceState({}, '', `/tenants/${tid}`)
          setRoute(parseRoute(`/tenants/${tid}`))
        }
      }
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  function refreshUser() {
    loadUser()
  }

  function navigate(path: string) {
    window.history.pushState({}, '', path)
    setRoute(parseRoute(path))
  }

  function selectTenant(tenantId: number) {
    setActiveTenantId(tenantId)
    localStorage.setItem(LS_ACTIVE_TENANT, String(tenantId))
    navigate(`/tenants/${tenantId}`)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">
          {t({ he: 'טוען…', en: 'Loading…' })}
        </div>
      </div>
    )
  }

  // Invite accept is public — renders even without a session so the
  // invitee can sign in from that page.
  if (route.kind === 'invite-accept') {
    return <InviteAcceptPage />
  }

  if (!session) {
    const isSignup = window.location.pathname === '/signup'
    return <LandingPage initialMode={isSignup ? 'signup' : 'login'} />
  }

  const status = user?.onboarding_status || 'pending'
  const isSuperadmin = user?.role === 'superadmin'

  return (
    <Layout
      onLogout={() => supabase.auth.signOut()}
      user={user}
      activeTenantId={activeTenantId}
      onTenantSelect={selectTenant}
      onRefreshTenants={refreshUser}
    >
      {route.kind === 'admin' && isSuperadmin && <AdminPage />}
      {route.kind === 'admin' && !isSuperadmin && (
        <div className="p-8 text-red-600">
          {t({
            he: '403 — דרושה גישת סופראדמין.',
            en: '403 — superadmin access required.',
          })}
        </div>
      )}

      {route.kind === 'tenant' && route.tenantId && (
        <TenantPage
          tenantId={route.tenantId}
          subpage={route.subpage || 'dashboard'}
          onNavigate={navigate}
          onTenantsChanged={refreshUser}
        />
      )}

      {route.kind === 'root' && status === 'pending' && <PaymentPage onComplete={refreshUser} />}
      {route.kind === 'root' && status === 'payment_done' && (
        <OnboardingPage user={user!} onComplete={refreshUser} />
      )}
      {route.kind === 'root' && status === 'complete' && !user?.default_tenant_id && (
        // Complete user with no tenant — shouldn't happen after the
        // loadUser auto-redirect, but keep a minimal fallback so we
        // don't blank the page if the backend returns an inconsistent
        // me payload. Plain-text message is enough — the user should
        // contact support rather than land on a broken dashboard.
        <div className="p-8 text-center text-gray-600">
          {t({
            he: 'סביבת העבודה לא נטענה. נסה לרענן את הדף או פנה לתמיכה.',
            en: 'Could not load your workspace. Try refreshing the page or contact support.',
          })}
        </div>
      )}
    </Layout>
  )
}
