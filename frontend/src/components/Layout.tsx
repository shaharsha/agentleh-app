import type { ReactNode } from 'react'

interface LayoutProps {
  children: ReactNode
  onLogout: () => void
}

export default function Layout({ children, onLogout }: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-brand">Agentleh</h1>
        <button
          onClick={onLogout}
          className="text-sm text-gray-500 hover:text-gray-700 cursor-pointer"
        >
          Logout
        </button>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  )
}
