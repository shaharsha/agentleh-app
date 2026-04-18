import { useState, type MouseEvent, type ReactNode } from 'react'
import type { AppUser, TenantMembership } from '../lib/types'
import TenantSwitcher from './TenantSwitcher'
import LanguageSwitcher from './LanguageSwitcher'
import ThemeSwitcher from './ThemeSwitcher'
import MobileDrawer from './MobileDrawer'
import { useI18n } from '../lib/i18n'
import { GodModeIcon, LayoutDashboardIcon, MenuIcon } from './icons'
import ProfileMenu from './ProfileMenu'

interface LayoutProps {
  children: ReactNode
  onLogout: () => void
  user?: AppUser | null
  activeTenantId?: number | null
  onTenantSelect?: (tenantId: number) => void
  onRefreshTenants?: () => void
  onNavigate?: (path: string) => void
}

export default function Layout({
  children,
  onLogout,
  user,
  activeTenantId,
  onTenantSelect,
  onRefreshTenants,
  onNavigate,
}: LayoutProps) {
  const { t } = useI18n()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const isAdminRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')
  const isTenantRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/tenants')
  const isSuperadmin = user?.role === 'superadmin'
  // Tenant pages get a wider container than the onboarding wizard so
  // the members table + agents list aren't cramped.
  const mainMaxWidth = isAdminRoute ? 'max-w-7xl' : isTenantRoute ? 'max-w-5xl' : 'max-w-[560px]'
  const tenants: TenantMembership[] = (user?.tenants as TenantMembership[]) || []

  const iconBtnClass =
    'flex items-center justify-center w-9 h-9 rounded-lg text-text-secondary hover:text-text-primary hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer'

  const adminLabel = isAdminRoute
    ? t({ he: 'לוח הבקרה', en: 'Dashboard' })
    : t({ he: 'ניהול', en: 'Admin' })

  const hasDrawerControls = tenants.length > 0 || isSuperadmin || !!user

  const homeHref =
    user?.onboarding_status === 'complete' && activeTenantId
      ? `/tenants/${activeTenantId}`
      : '/'

  function handleHomeClick(e: MouseEvent<HTMLAnchorElement>) {
    if (!onNavigate) return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    onNavigate(homeHref)
  }

  return (
    <div className="min-h-screen section-gradient">
      <header className="glass-nav sticky top-0 z-50 safe-pt">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-2 px-4 sm:px-6 py-2.5 sm:py-3 safe-px">
          {/* Start cluster: hamburger (mobile only) + logo */}
          <div className="flex items-center gap-2 min-w-0">
            {hasDrawerControls && user && (
              <button
                onClick={() => setDrawerOpen(true)}
                aria-label={t({ he: 'פתיחת תפריט', en: 'Open menu' })}
                aria-expanded={drawerOpen}
                className="md:hidden flex items-center justify-center w-10 h-10 rounded-lg text-text-secondary hover:text-text-primary hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer shrink-0"
              >
                <MenuIcon className="w-5 h-5" />
              </button>
            )}

            <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
              <a
                href={homeHref}
                onClick={handleHomeClick}
                aria-label={t({ he: 'דף הבית', en: 'Home' })}
                className="flex items-center shrink-0 rounded-md cursor-pointer hover:opacity-80 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <img
                  src="/brand/logo-wordmark.svg"
                  alt="Agentiko"
                  className="h-6 sm:h-7 w-auto shrink-0 block dark:hidden"
                />
                <img
                  src="/brand/logo-wordmark-dark.svg"
                  alt="Agentiko"
                  className="h-6 sm:h-7 w-auto shrink-0 hidden dark:block"
                />
              </a>
              {isAdminRoute && (
                <span className="hidden sm:inline-block ms-2 text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700 dark:text-purple-300 font-semibold">
                  {t({ he: 'ניהול', en: 'ADMIN' })}
                </span>
              )}
            </div>
          </div>

          {/* End cluster */}
          <div className="flex items-center gap-2">
            {/* Desktop-only nav controls — collapsed into the drawer on <md */}
            <div className="hidden md:flex items-center gap-2">
              {tenants.length > 0 && onTenantSelect && onRefreshTenants && (
                <TenantSwitcher
                  tenants={tenants}
                  activeTenantId={activeTenantId ?? null}
                  onSelect={onTenantSelect}
                  onRefresh={onRefreshTenants}
                />
              )}

              {tenants.length > 0 && (
                <div className="w-px h-5 bg-border-light mx-1" aria-hidden="true" />
              )}

              <LanguageSwitcher />

              <ThemeSwitcher />

              {isSuperadmin && (
                <a
                  href={isAdminRoute ? '/' : '/admin'}
                  className={iconBtnClass}
                  title={adminLabel}
                  aria-label={adminLabel}
                >
                  {isAdminRoute ? <LayoutDashboardIcon /> : <GodModeIcon />}
                </a>
              )}
            </div>

            {user && <ProfileMenu user={user} onLogout={onLogout} />}
          </div>
        </div>
      </header>

      {/* Mobile drawer — only renders when we have a logged-in user. */}
      {user && (
        <MobileDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          user={user}
          tenants={tenants}
          activeTenantId={activeTenantId ?? null}
          onTenantSelect={(id) => {
            onTenantSelect?.(id)
          }}
          onRefreshTenants={() => onRefreshTenants?.()}
          onLogout={onLogout}
          isAdminRoute={isAdminRoute}
          isSuperadmin={!!isSuperadmin}
        />
      )}

      <main className={`${mainMaxWidth} mx-auto px-4 sm:px-5 py-8 sm:py-12 safe-px`}>
        {children}
      </main>
    </div>
  )
}
