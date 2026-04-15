import { useState } from 'react'
import type { TenantMembership } from '../lib/types'
import { createTenant } from '../lib/api'

interface Props {
  tenants: TenantMembership[]
  activeTenantId: number | null
  onSelect: (tenantId: number) => void
  onRefresh: () => void
}

/**
 * Dropdown in the top nav that lets the user switch workspaces + create
 * new ones. Active tenant is persisted in the URL (App.tsx reads
 * /tenants/:id). LocalStorage `agentleh.activeTenantId` is a soft hint
 * used only on first load when the URL doesn't already specify a tenant.
 *
 * Hidden when the user has <2 tenants — a B2C user with a single
 * personal workspace never needs to switch, so we keep the nav clean.
 */
export default function TenantSwitcher({ tenants, activeTenantId, onSelect, onRefresh }: Props) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const activeTenant = tenants.find((t) => t.id === activeTenantId) || tenants[0] || null

  // Keep the switcher UI out of the way for users with just one tenant,
  // BUT expose the "new workspace" button via a subtle affordance once
  // they click their tenant name. For zero-tenant users (shouldn't
  // happen post-onboarding), render nothing.
  if (!activeTenant) return null

  async function handleCreate() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const t = await createTenant(newName.trim())
      onRefresh()
      onSelect(t.id)
      setOpen(false)
      setNewName('')
    } catch (err) {
      alert('Failed to create workspace: ' + (err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const roleBadge = (role: string) => {
    const color =
      role === 'owner' ? 'bg-amber-100 text-amber-800'
      : role === 'admin' ? 'bg-indigo-100 text-indigo-800'
      : 'bg-gray-100 text-gray-600'
    return (
      <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ${color}`}>
        {role}
      </span>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors cursor-pointer"
      >
        <span className="max-w-[180px] truncate" dir="auto">
          {activeTenant.name}
        </span>
        {tenants.length > 1 && (
          <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-72 bg-white rounded-xl shadow-lg border border-gray-200 z-20 overflow-hidden">
            <div className="p-2">
              <div className="px-2 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Your workspaces
              </div>
              {tenants.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    onSelect(t.id)
                    setOpen(false)
                  }}
                  className={`w-full text-right px-3 py-2 rounded-lg text-sm flex items-center justify-between gap-2 cursor-pointer ${
                    t.id === activeTenantId ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  <span className="truncate" dir="auto">
                    {t.name}
                  </span>
                  {roleBadge(t.role)}
                </button>
              ))}
            </div>
            <div className="border-t border-gray-100 p-2">
              {creating ? (
                <div className="flex gap-2 p-2">
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Workspace name"
                    className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  />
                  <button
                    onClick={handleCreate}
                    disabled={!newName.trim()}
                    className="px-3 py-1 text-sm text-white bg-indigo-600 rounded disabled:opacity-40 hover:bg-indigo-700"
                  >
                    Create
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  className="w-full text-right px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50 flex items-center gap-2 justify-start"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  New workspace
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
