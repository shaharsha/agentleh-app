import { useEffect, useState } from 'react'
import type { TenantMembership, TenantRole } from '../lib/types'
import { createTenant } from '../lib/api'
import { useI18n } from '../lib/i18n'
import TenantName from './TenantName'

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
 *
 * All strings are bilingual via useI18n. The dropdown inherits the
 * active direction from <html>, so Hebrew renders RTL, English renders
 * LTR, and user-entered tenant names get a per-element dir="auto" to
 * render correctly regardless of the wrapper's direction.
 */
export default function TenantSwitcher({ tenants, activeTenantId, onSelect, onRefresh }: Props) {
  const { t, dir } = useI18n()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  // Escape-key dismiss — complements the backdrop click and keeps
  // keyboard users from getting stuck in the dropdown.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const activeTenant = tenants.find((t) => t.id === activeTenantId) || tenants[0] || null

  if (!activeTenant) return null

  async function handleCreate() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const created = await createTenant(newName.trim())
      onRefresh()
      onSelect(created.id)
      setOpen(false)
      setNewName('')
    } catch (err) {
      alert(
        t({
          he: 'יצירת סביבת עבודה נכשלה: ',
          en: 'Failed to create workspace: ',
        }) + (err as Error).message,
      )
    } finally {
      setCreating(false)
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

  const roleBadge = (role: TenantRole) => {
    const color =
      role === 'owner'
        ? 'bg-amber-100 text-amber-800'
        : role === 'admin'
          ? 'bg-indigo-100 text-indigo-800'
          : 'bg-gray-100 text-gray-600'
    return (
      <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ${color}`}>
        {roleLabel(role)}
      </span>
    )
  }

  // The dropdown is anchored to the opposite side of the button from
  // the reading direction, so it aligns with the nav content below the
  // logo in both LTR and RTL layouts.
  const anchorClass = dir === 'rtl' ? 'start-0' : 'end-0'

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors cursor-pointer"
      >
        <span className="max-w-[180px] truncate">
          <TenantName tenant={activeTenant} />
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
          <div
            className={`absolute ${anchorClass} mt-2 w-[min(18rem,calc(100vw-2rem))] bg-surface rounded-xl shadow-lg border border-border-light z-20 overflow-hidden`}
          >
            <div className="p-2">
              <div className="px-2 py-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                {t({ he: 'סביבות העבודה שלך', en: 'Your workspaces' })}
              </div>
              {tenants.map((tenant) => (
                <button
                  key={tenant.id}
                  onClick={() => {
                    onSelect(tenant.id)
                    setOpen(false)
                  }}
                  className={`w-full px-3 py-2 rounded-lg text-sm flex items-center justify-between gap-2 cursor-pointer ${
                    tenant.id === activeTenantId
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  <span className="truncate flex-1 text-start">
                    <TenantName tenant={tenant} />
                  </span>
                  {roleBadge(tenant.role)}
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
                    placeholder={t({ he: 'שם סביבת העבודה', en: 'Workspace name' })}
                    className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    autoFocus
                    dir="auto"
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  />
                  <button
                    onClick={handleCreate}
                    disabled={!newName.trim()}
                    className="px-3 py-1 text-sm text-white bg-indigo-600 rounded disabled:opacity-40 hover:bg-indigo-700"
                  >
                    {t({ he: 'יצירה', en: 'Create' })}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  className="w-full px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50 flex items-center gap-2 text-start"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  {t({ he: 'סביבת עבודה חדשה', en: 'New workspace' })}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
