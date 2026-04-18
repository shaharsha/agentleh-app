import { useEffect, useRef, useState } from 'react'
import type { AppUser } from '../lib/types'
import { useI18n } from '../lib/i18n'
import { LogOutIcon } from './icons'



interface Props {
  user: AppUser
  onLogout: () => void
}

const AVATAR_PALETTE = [
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-sky-500',
  'bg-violet-500',
] as const

function getInitials(fullName: string, email: string): string {
  const name = (fullName || '').trim()
  if (name) {
    const parts = name.split(/\s+/)
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
  }
  return (email.trim().charAt(0) || '?').toUpperCase()
}

export default function ProfileMenu({ user, onLogout }: Props) {
  const { t, dir } = useI18n()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  // ProfileMenu sits at the inline-end of the header in both
  // directions, so we always anchor end-0 — the dropdown grows
  // inward toward the header's center, never off-screen.

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    // Use a mousedown listener on the window for outside-click dismiss
    // rather than a `fixed inset-0` backdrop with onClick. The backdrop
    // approach is flaky on iOS Safari — touch events on a bare div
    // without `cursor: pointer` don't reliably translate to click
    // handlers. Checking `containerRef.current.contains` against the
    // event target works everywhere and matches the pattern used by
    // ThemeSwitcher / LanguageSwitcher.
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [open])

  const initials = getInitials(user.full_name, user.email)
  const avatarColor = AVATAR_PALETTE[user.id % AVATAR_PALETTE.length]
  const logoutIconClass = dir === 'rtl' ? 'w-[18px] h-[18px] -scale-x-100' : 'w-[18px] h-[18px]'

  const accountMenuLabel = t({ he: 'תפריט חשבון', en: 'Account menu' })
  const signOutLabel = t({ he: 'התנתקות', en: 'Sign out' })

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center justify-center w-9 h-9 shrink-0 rounded-full text-white text-sm font-medium ${avatarColor} hover:ring-2 hover:ring-gray-200 transition-all cursor-pointer`}
        title={accountMenuLabel}
        aria-label={accountMenuLabel}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {initials}
      </button>

      {open && (
        <>
          <div
            className="absolute end-0 mt-2 w-[min(18rem,calc(100vw-2rem))] bg-surface-soft rounded-xl shadow-[0_12px_48px_rgb(14_19_32/0.18)] border border-border z-20 overflow-hidden"
            role="menu"
          >
            <div className="p-3 flex items-center gap-3">
              <div
                className={`flex items-center justify-center w-12 h-12 rounded-full text-white text-base font-medium ${avatarColor} shrink-0`}
                aria-hidden="true"
              >
                {initials}
              </div>
              <div className="min-w-0 flex-1 text-start">
                {user.full_name?.trim() && (
                  <div className="text-sm font-medium text-text-primary truncate">
                    <bdi>{user.full_name}</bdi>
                  </div>
                )}
                <div className="text-xs text-text-muted truncate">
                  <bdi>{user.email}</bdi>
                </div>
              </div>
            </div>
            <div className="border-t border-border p-1">
              <button
                onClick={() => {
                  setOpen(false)
                  onLogout()
                }}
                className="w-full flex items-center gap-2 px-3 py-2.5 min-h-[44px] rounded-lg text-sm text-danger hover:bg-danger/10 text-start cursor-pointer"
                role="menuitem"
              >
                <LogOutIcon className={logoutIconClass} />
                <span>{signOutLabel}</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
