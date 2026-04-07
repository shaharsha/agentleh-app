import type { ReactNode } from 'react'

interface LayoutProps {
  children: ReactNode
  onLogout: () => void
}

export default function Layout({ children, onLogout }: LayoutProps) {
  return (
    <div className="min-h-screen mesh-bg">
      <header className="glass sticky top-0 z-50 px-6 py-3">
        <div className="max-w-[640px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] bg-brand flex items-center justify-center shadow-sm">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <span className="text-[17px] font-semibold tracking-[-0.3px]">Agentiko</span>
          </div>
          <button
            onClick={onLogout}
            className="text-[14px] text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
          >
            התנתקות
          </button>
        </div>
      </header>
      <main className="max-w-[560px] mx-auto px-5 py-12">
        {children}
      </main>
    </div>
  )
}
