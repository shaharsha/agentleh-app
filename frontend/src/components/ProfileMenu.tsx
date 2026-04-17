import { useEffect, useState } from 'react'
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

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const initials = getInitials(user.full_name, user.email)
  const avatarColor = AVATAR_PALETTE[user.id % AVATAR_PALETTE.length]
  const anchorClass = dir === 'rtl' ? 'start-0' : 'end-0'
  const logoutIconClass = dir === 'rtl' ? 'w-[18px] h-[18px] -scale-x-100' : 'w-[18px] h-[18px]'

  const accountMenuLabel = t({ he: 'תפריט חשבון', en: 'Account menu' })
  const signOutLabel = t({ he: 'התנתקות', en: 'Sign out' })

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center justify-center w-9 h-9 rounded-full text-white text-sm font-medium ${avatarColor} hover:ring-2 hover:ring-gray-200 transition-all cursor-pointer`}
        title={accountMenuLabel}
        aria-label={accountMenuLabel}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {initials}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`absolute ${anchorClass} mt-2 w-72 bg-white rounded-xl shadow-lg border border-gray-200 z-20 overflow-hidden`}
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
                  <div className="text-sm font-medium text-gray-900 truncate">
                    <bdi>{user.full_name}</bdi>
                  </div>
                )}
                <div className="text-xs text-gray-500 truncate">
                  <bdi>{user.email}</bdi>
                </div>
              </div>
            </div>
            <div className="border-t border-gray-100 p-1">
              <button
                onClick={() => {
                  setOpen(false)
                  onLogout()
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-600 hover:bg-red-50 text-start cursor-pointer"
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
