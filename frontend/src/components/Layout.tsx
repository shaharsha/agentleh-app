import type { ReactNode } from 'react'
import type { AppUser } from '../lib/types'

interface LayoutProps {
  children: ReactNode
  onLogout: () => void
  user?: AppUser | null
}

export default function Layout({ children, onLogout, user }: LayoutProps) {
  const isAdminRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')
  const isSuperadmin = user?.role === 'superadmin'
  const mainMaxWidth = isAdminRoute ? 'max-w-7xl' : 'max-w-[560px]'
  return (
    <div className="min-h-screen section-gradient">
      <header className="glass-nav sticky top-0 z-50 px-6 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] bg-brand flex items-center justify-center shadow-sm">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <span className="text-[17px] font-semibold tracking-[-0.3px]">Agentiko</span>
            {isAdminRoute && (
              <span className="ml-2 text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700 font-semibold">
                ADMIN
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            {isSuperadmin && (
              <a
                href={isAdminRoute ? '/' : '/admin'}
                className="text-[14px] text-text-secondary hover:text-text-primary transition-colors"
              >
                {isAdminRoute ? 'Dashboard' : 'Admin'}
              </a>
            )}
            <button
              onClick={onLogout}
              className="text-[14px] text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
            >
              התנתקות
            </button>
          </div>
        </div>
      </header>
      <main className={`${mainMaxWidth} mx-auto px-5 py-12`}>
        {children}
      </main>
    </div>
  )
}
