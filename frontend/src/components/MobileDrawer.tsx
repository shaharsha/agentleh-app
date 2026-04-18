import { useEffect, useState, useRef } from 'react'
import type { AppUser, TenantMembership, TenantRole } from '../lib/types'
import { createTenant } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { useTheme, type Theme } from '../lib/theme'
import { useBackDismiss } from '../lib/useBackDismiss'
import TenantName from './TenantName'
import {
  CheckIcon,
  GlobeIcon,
  GodModeIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SunIcon,
  XIcon,
} from './icons'

interface Props {
  open: boolean
  onClose: () => void
  user: AppUser
  tenants: TenantMembership[]
  activeTenantId: number | null
  onTenantSelect: (tenantId: number) => void
  onRefreshTenants: () => void
  onLogout: () => void
  isAdminRoute: boolean
  isSuperadmin: boolean
}

/**
 * Mobile nav drawer — appears only on narrow viewports (controlled by the
 * Layout's hamburger button which itself is `md:hidden`). Holds every nav
 * control that doesn't fit in a 375-px header:
 *
 *   • workspace list + "new workspace" CTA
 *   • language toggle (big, not the 2-px-padding desktop chip)
 *   • admin-panel shortcut (superadmin only)
 *   • account info + sign out
 *
 * Full-height sheet sliding in from the inline-end side (right in LTR,
 * left in RTL). Safe-area padded so content doesn't hide under the
 * iPhone notch or home indicator. Dismissable via:
 *   • X button
 *   • tapping the backdrop
 *   • Escape key
 *   • hardware/gesture Back (wired by useBackDismiss)
 *
 * Motion is CSS-driven; the reduced-motion media query in index.css
 * already neutralises the transition for users who opt out.
 */
export default function MobileDrawer({
  open,
  onClose,
  user,
  tenants,
  activeTenantId,
  onTenantSelect,
  onRefreshTenants,
  onLogout,
  isAdminRoute,
  isSuperadmin,
}: Props) {
  const { t, lang, setLang } = useI18n()
  const { theme, setTheme } = useTheme()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  useBackDismiss(open, onClose)

  // Lock background scroll while open — without this the page scrolls
  // behind the drawer on iOS when the user swipes on the backdrop.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Escape to close + initial focus on the close button.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    closeBtnRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Reset inline create form whenever the drawer is closed, so re-opening
  // starts clean.
  useEffect(() => {
    if (!open) {
      setCreating(false)
      setNewName('')
      setCreateError(null)
    }
  }, [open])

  async function handleCreate() {
    if (!newName.trim()) return
    try {
      const created = await createTenant(newName.trim())
      onRefreshTenants()
      onTenantSelect(created.id)
      setCreating(false)
      setNewName('')
      setCreateError(null)
      onClose()
    } catch (err) {
      setCreateError((err as Error).message)
    }
  }

  const roleLabel = (role: TenantRole) =>
    t(
      role === 'owner'
        ? { he: 'בעלים', en: 'owner' }
        : role === 'admin'
          ? { he: 'מנהל', en: 'admin' }
          : { he: 'חבר', en: 'member' },
    )

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-[60] md:hidden ${open ? '' : 'pointer-events-none'}`}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Sheet — slides in from the inline-START side, same edge as the
       * hamburger trigger (left in LTR, right in RTL). Anchoring the
       * drawer to the opposite side of the trigger feels wrong: your
       * tap activates a panel somewhere across the screen. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t({ he: 'תפריט ניווט', en: 'Navigation menu' })}
        className={`absolute inset-y-0 start-0 w-[min(330px,88vw)] bg-surface shadow-2xl border-e border-border-light flex flex-col transition-transform duration-200 ease-out safe-pt safe-pb ${
          open ? 'translate-x-0' : 'rtl:translate-x-full ltr:-translate-x-full'
        }`}
        style={{ paddingInlineStart: 'max(0.75rem, env(safe-area-inset-left))', paddingInlineEnd: 'max(0.75rem, env(safe-area-inset-right))' }}
      >
        {/* Header row: close button */}
        <div className="flex items-center justify-between px-2 py-3 border-b border-border-light">
          <span className="text-sm font-semibold text-text-secondary">
            {t({ he: 'ניווט', en: 'Menu' })}
          </span>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label={t({ he: 'סגירה', en: 'Close' })}
            className="w-11 h-11 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
          {/* Workspaces */}
          {tenants.length > 0 && (
            <section>
              <h3 className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {t({ he: 'סביבות העבודה', en: 'Workspaces' })}
              </h3>
              <ul className="space-y-0.5">
                {tenants.map((tenant) => {
                  const isActive = tenant.id === activeTenantId
                  return (
                    <li key={tenant.id}>
                      <button
                        onClick={() => {
                          onTenantSelect(tenant.id)
                          onClose()
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-start min-h-[48px] transition-colors ${
                          isActive
                            ? 'bg-brand-50 text-brand-dark'
                            : 'hover:bg-black/5 dark:hover:bg-white/5 text-text-primary'
                        }`}
                      >
                        <CheckIcon
                          className={`w-4 h-4 shrink-0 ${isActive ? 'opacity-100 text-brand' : 'opacity-0'}`}
                        />
                        <span className="flex-1 min-w-0 truncate text-sm">
                          <TenantName tenant={tenant} />
                        </span>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 text-text-secondary">
                          {roleLabel(tenant.role)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>

              {/* New workspace */}
              <div className="mt-1 px-1">
                {creating ? (
                  <div className="space-y-2 py-2">
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={t({ he: 'שם סביבת העבודה', en: 'Workspace name' })}
                      dir="auto"
                      autoFocus
                      onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                      className="input-glass w-full px-3 py-3 text-sm rounded-xl"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleCreate}
                        disabled={!newName.trim()}
                        className="btn-brand btn-md flex-1 disabled:opacity-50"
                      >
                        {t({ he: 'יצירה', en: 'Create' })}
                      </button>
                      <button
                        onClick={() => {
                          setCreating(false)
                          setNewName('')
                          setCreateError(null)
                        }}
                        className="btn-secondary btn-md"
                      >
                        {t({ he: 'ביטול', en: 'Cancel' })}
                      </button>
                    </div>
                    {createError && (
                      <p className="text-xs text-danger">{createError}</p>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => setCreating(true)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-black/5 dark:hover:bg-white/5 min-h-[44px] text-sm text-start transition-colors"
                  >
                    <PlusIcon className="w-4 h-4 shrink-0" />
                    {t({ he: 'סביבת עבודה חדשה', en: 'New workspace' })}
                  </button>
                )}
              </div>
            </section>
          )}

          <hr className="border-border-light" />

          {/* Language */}
          <section>
            <h3 className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              {t({ he: 'שפה', en: 'Language' })}
            </h3>
            <div className="flex gap-2 px-1" role="group" aria-label={t({ he: 'בחירת שפה', en: 'Language selection' })}>
              <button
                onClick={() => setLang('he')}
                aria-pressed={lang === 'he'}
                className={`flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-3 rounded-lg text-sm font-medium transition-colors ${
                  lang === 'he'
                    ? 'bg-gray-900 text-white dark:bg-white/15 dark:text-text-primary'
                    : 'bg-black/5 dark:bg-white/5 text-text-secondary hover:text-text-primary'
                }`}
              >
                <GlobeIcon className="w-4 h-4" />
                עברית
              </button>
              <button
                onClick={() => setLang('en')}
                aria-pressed={lang === 'en'}
                className={`flex-1 inline-flex items-center justify-center gap-2 min-h-[44px] px-3 rounded-lg text-sm font-medium transition-colors ${
                  lang === 'en'
                    ? 'bg-gray-900 text-white dark:bg-white/15 dark:text-text-primary'
                    : 'bg-black/5 dark:bg-white/5 text-text-secondary hover:text-text-primary'
                }`}
              >
                <GlobeIcon className="w-4 h-4" />
                English
              </button>
            </div>
          </section>

          <hr className="border-border-light" />

          {/* Theme */}
          <section>
            <h3 className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              {t({ he: 'ערכת נושא', en: 'Theme' })}
            </h3>
            <div
              role="radiogroup"
              aria-label={t({ he: 'בחירת ערכת נושא', en: 'Theme selection' })}
              className="flex gap-2 px-1"
            >
              {(
                [
                  ['auto', <MonitorIcon key="a" className="w-4 h-4" />, t({ he: 'אוטומטי', en: 'Auto' })],
                  ['light', <SunIcon key="l" className="w-4 h-4" />, t({ he: 'בהיר', en: 'Light' })],
                  ['dark', <MoonIcon key="d" className="w-4 h-4" />, t({ he: 'כהה', en: 'Dark' })],
                ] as Array<[Theme, React.ReactNode, string]>
              ).map(([target, icon, label]) => (
                <button
                  key={target}
                  type="button"
                  onClick={() => setTheme(target)}
                  aria-pressed={theme === target}
                  aria-label={label}
                  className={`flex-1 inline-flex flex-col items-center justify-center gap-1 min-h-[56px] px-3 rounded-lg text-xs font-medium transition-colors ${
                    theme === target
                      ? 'bg-gray-900 text-white dark:bg-white/15 dark:text-text-primary'
                      : 'bg-black/5 dark:bg-white/5 text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {icon}
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Superadmin shortcut */}
          {isSuperadmin && (
            <>
              <hr className="border-border-light" />
              <section className="px-1">
                <a
                  href={isAdminRoute ? '/' : '/admin'}
                  className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-black/5 dark:hover:bg-white/5 min-h-[44px] text-sm transition-colors"
                >
                  {isAdminRoute ? (
                    <LayoutDashboardIcon className="w-4 h-4 shrink-0" />
                  ) : (
                    <GodModeIcon className="w-4 h-4 shrink-0" />
                  )}
                  <span className="flex-1">
                    {isAdminRoute
                      ? t({ he: 'לוח הבקרה', en: 'Dashboard' })
                      : t({ he: 'פאנל ניהול', en: 'Admin panel' })}
                  </span>
                </a>
              </section>
            </>
          )}

          <hr className="border-border-light" />

          {/* Account + sign out */}
          <section>
            <h3 className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              {t({ he: 'החשבון שלי', en: 'My account' })}
            </h3>
            <div className="px-3 py-2 text-sm">
              {user.full_name?.trim() && (
                <div className="font-medium text-text-primary truncate">
                  <bdi>{user.full_name}</bdi>
                </div>
              )}
              <div className="text-xs text-text-muted truncate">
                <bdi>{user.email}</bdi>
              </div>
            </div>
            <div className="px-1 mt-1">
              <button
                onClick={() => {
                  onClose()
                  onLogout()
                }}
                className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-danger hover:bg-danger/10 min-h-[44px] text-sm text-start transition-colors"
              >
                <LogOutIcon className="w-4 h-4 shrink-0 icon-flip" />
                {t({ he: 'התנתקות', en: 'Sign out' })}
              </button>
            </div>
          </section>
        </div>
      </aside>
    </div>
  )
}
