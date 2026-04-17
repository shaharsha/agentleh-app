import type { ReactNode } from 'react'
import type { AppUser, TenantMembership } from '../lib/types'
import TenantSwitcher from './TenantSwitcher'
import LanguageSwitcher from './LanguageSwitcher'
import { useI18n } from '../lib/i18n'
import { GodModeIcon, LayoutDashboardIcon } from './icons'
import ProfileMenu from './ProfileMenu'

interface LayoutProps {
  children: ReactNode
  onLogout: () => void
  user?: AppUser | null
  activeTenantId?: number | null
  onTenantSelect?: (tenantId: number) => void
  onRefreshTenants?: () => void
}

export default function Layout({
  children,
  onLogout,
  user,
  activeTenantId,
  onTenantSelect,
  onRefreshTenants,
}: LayoutProps) {
  const { t } = useI18n()
  const isAdminRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')
  const isTenantRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/tenants')
  const isSuperadmin = user?.role === 'superadmin'
  // Tenant pages get a wider container than the onboarding wizard so
  // the members table + agents list aren't cramped.
  const mainMaxWidth = isAdminRoute ? 'max-w-7xl' : isTenantRoute ? 'max-w-5xl' : 'max-w-[560px]'
  const tenants: TenantMembership[] = (user?.tenants as TenantMembership[]) || []

  // Shared ghost-icon-button class. Matches the hover feel of the
  // TenantSwitcher trigger above so the whole right-side toolbar reads
  // as one consistent action group.
  const iconBtnClass =
    'flex items-center justify-center w-9 h-9 rounded-lg text-text-secondary hover:text-text-primary hover:bg-gray-100 transition-colors cursor-pointer'

  const adminLabel = isAdminRoute
    ? t({ he: 'לוח הבקרה', en: 'Dashboard' })
    : t({ he: 'ניהול', en: 'Admin' })

  return (
    <div className="min-h-screen section-gradient">
      <header className="glass-nav sticky top-0 z-50 px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] bg-brand flex items-center justify-center shadow-sm">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <span className="text-[17px] font-semibold tracking-[-0.3px]">Agentiko</span>
            {isAdminRoute && (
              <span className="ms-2 text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700 font-semibold">
                {t({ he: 'ניהול', en: 'ADMIN' })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {tenants.length > 0 && onTenantSelect && onRefreshTenants && (
              <TenantSwitcher
                tenants={tenants}
                activeTenantId={activeTenantId ?? null}
                onSelect={onTenantSelect}
                onRefresh={onRefreshTenants}
              />
            )}

            {/* Thin vertical divider before the action icons — pure visual
                grouping. Hidden when the tenant switcher isn't rendered
                (avoids a divider with nothing on its start side). */}
            {tenants.length > 0 && (
              <div className="w-px h-5 bg-gray-200 mx-1" aria-hidden="true" />
            )}

            <LanguageSwitcher />

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

            {user && <ProfileMenu user={user} onLogout={onLogout} />}
          </div>
        </div>
      </header>
      <main className={`${mainMaxWidth} mx-auto px-5 py-12`}>
        {children}
      </main>
    </div>
  )
}
