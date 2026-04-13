import { useEffect, useState } from 'react'
import {
  getAdminOverview,
  getAdminAgentDetail,
  rotateMeterKey,
  setUserRole,
} from '../lib/api'
import type {
  AdminOverview,
  AdminAgentRow,
  AdminUserRow,
  AdminAgentDetail,
  UsageEvent,
} from '../lib/types'

const MICROS_PER_DOLLAR = 1_000_000

function fmtUsd(micros: number | null | undefined): string {
  if (micros == null) return '—'
  return `$${(micros / MICROS_PER_DOLLAR).toFixed(4)}`
}

function pct(used: number | null | undefined, total: number | null | undefined): string {
  if (used == null || total == null || total === 0) return '—'
  return `${((used / total) * 100).toFixed(1)}%`
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return new Date(s).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' })
}

export default function AdminPage() {
  const [loading, setLoading] = useState(true)
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [agentDetail, setAgentDetail] = useState<AdminAgentDetail | null>(null)
  const [tab, setTab] = useState<'agents' | 'users' | 'plans'>('agents')

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const data = await getAdminOverview()
      setOverview(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
  }, [])

  useEffect(() => {
    if (!selectedAgentId) {
      setAgentDetail(null)
      return
    }
    getAdminAgentDetail(selectedAgentId)
      .then(setAgentDetail)
      .catch((e) => setError((e as Error).message))
  }, [selectedAgentId])

  async function handleRotateKey(agentId: string) {
    if (!confirm(`Rotate meter key for ${agentId}? The old key will stop working immediately.`)) {
      return
    }
    try {
      const res = await rotateMeterKey(agentId)
      alert(
        `New meter key for ${agentId}:\n\n${res.meter_key}\n\n` +
          `Save this now — it will not be shown again. ` +
          `You must update /opt/agentleh/.env on the VM and restart the container.`,
      )
    } catch (e) {
      alert(`Failed: ${(e as Error).message}`)
    }
  }

  async function handlePromote(user: AdminUserRow) {
    const newRole = user.role === 'superadmin' ? 'user' : 'superadmin'
    if (
      !confirm(
        `${newRole === 'superadmin' ? 'Promote' : 'Demote'} ${user.email} to ${newRole}?`,
      )
    ) {
      return
    }
    try {
      await setUserRole(user.id, newRole)
      await reload()
    } catch (e) {
      alert(`Failed: ${(e as Error).message}`)
    }
  }

  if (loading) {
    return (
      <div className="p-8 text-gray-500">Loading admin panel…</div>
    )
  }

  if (error && !overview) {
    return (
      <div className="p-8 text-red-600">
        Error: {error}
        {error.includes('superadmin_required') && (
          <div className="mt-4 text-gray-700">
            You need <code>role='superadmin'</code> on your app_users row to access this page.
          </div>
        )}
      </div>
    )
  }

  if (!overview) return null

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Admin</h1>
        <button
          onClick={reload}
          className="btn-secondary btn-sm"
        >
          Refresh
        </button>
      </div>

      <div className="flex gap-2 border-b">
        {(['agents', 'users', 'plans'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 capitalize ${
              tab === t
                ? 'border-b-2 border-blue-600 text-blue-600 font-semibold'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            {t} ({(overview[t] as unknown[]).length})
          </button>
        ))}
      </div>

      {tab === 'agents' && (
        <AgentsTab
          agents={overview.agents}
          onSelect={setSelectedAgentId}
          onRotateKey={handleRotateKey}
        />
      )}

      {tab === 'users' && (
        <UsersTab users={overview.users} onPromote={handlePromote} />
      )}

      {tab === 'plans' && <PlansTab plans={overview.plans} />}

      {selectedAgentId && (
        <AgentDetailModal
          detail={agentDetail}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  )
}

function AgentsTab({
  agents,
  onSelect,
  onRotateKey,
}: {
  agents: AdminAgentRow[]
  onSelect: (id: string) => void
  onRotateKey: (id: string) => void
}) {
  return (
    <div className="glass-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left p-3">Agent</th>
            <th className="text-left p-3">Owner</th>
            <th className="text-left p-3">Plan</th>
            <th className="text-right p-3">Used</th>
            <th className="text-right p-3">Cap</th>
            <th className="text-right p-3">%</th>
            <th className="text-left p-3">Status</th>
            <th className="text-right p-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const cap = (a.base_allowance_micros || 0) + (a.overage_cap_micros || 0)
            return (
              <tr key={a.agent_id} className="border-t hover:bg-gray-50">
                <td className="p-3 font-mono text-xs">
                  <div>{a.agent_id}</div>
                  {a.agent_name && (
                    <div className="text-gray-500">({a.agent_name})</div>
                  )}
                </td>
                <td className="p-3">
                  {a.user_email || <span className="text-gray-400">—</span>}
                </td>
                <td className="p-3">
                  {a.plan_name_he || <span className="text-gray-400">—</span>}
                </td>
                <td className="p-3 text-right font-mono">{fmtUsd(a.used_micros)}</td>
                <td className="p-3 text-right font-mono">{fmtUsd(cap || null)}</td>
                <td className="p-3 text-right">{pct(a.used_micros, cap || null)}</td>
                <td className="p-3">
                  <span
                    className={
                      a.subscription_status === 'active'
                        ? 'text-green-600'
                        : a.subscription_status === 'exhausted'
                          ? 'text-red-600'
                          : 'text-gray-500'
                    }
                  >
                    {a.subscription_status || 'none'}
                  </span>
                </td>
                <td className="p-3 text-right space-x-2">
                  <button
                    onClick={() => onSelect(a.agent_id)}
                    className="btn-secondary btn-sm"
                  >
                    Details
                  </button>
                  <button
                    onClick={() => onRotateKey(a.agent_id)}
                    className="btn-secondary btn-sm"
                  >
                    Rotate key
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function UsersTab({
  users,
  onPromote,
}: {
  users: AdminUserRow[]
  onPromote: (user: AdminUserRow) => void
}) {
  return (
    <div className="glass-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left p-3">Email</th>
            <th className="text-left p-3">Name</th>
            <th className="text-left p-3">Phone</th>
            <th className="text-left p-3">Role</th>
            <th className="text-left p-3">Status</th>
            <th className="text-right p-3">Agents</th>
            <th className="text-left p-3">Joined</th>
            <th className="text-right p-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-t hover:bg-gray-50">
              <td className="p-3">{u.email}</td>
              <td className="p-3">{u.full_name || '—'}</td>
              <td className="p-3 font-mono text-xs">{u.phone || '—'}</td>
              <td className="p-3">
                <span
                  className={
                    u.role === 'superadmin'
                      ? 'text-purple-600 font-semibold'
                      : 'text-gray-600'
                  }
                >
                  {u.role}
                </span>
              </td>
              <td className="p-3">{u.onboarding_status}</td>
              <td className="p-3 text-right">{u.agent_count}</td>
              <td className="p-3 text-xs text-gray-500">{fmtDate(u.created_at)}</td>
              <td className="p-3 text-right">
                <button onClick={() => onPromote(u)} className="btn-secondary btn-sm">
                  {u.role === 'superadmin' ? 'Demote' : 'Promote'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PlansTab({ plans }: { plans: AdminOverview['plans'] }) {
  return (
    <div className="glass-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left p-3">Plan</th>
            <th className="text-left p-3">Hebrew</th>
            <th className="text-right p-3">Price (₪)</th>
            <th className="text-left p-3">Mode</th>
            <th className="text-right p-3">Base</th>
            <th className="text-right p-3">Overage cap</th>
            <th className="text-right p-3">RPM</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.plan_id} className="border-t">
              <td className="p-3 font-mono">{p.plan_id}</td>
              <td className="p-3">{p.name_he}</td>
              <td className="p-3 text-right">
                {(p.price_ils_cents / 100).toFixed(0)}
              </td>
              <td className="p-3">{p.billing_mode}</td>
              <td className="p-3 text-right font-mono">
                {fmtUsd(p.base_allowance_micros)}
              </td>
              <td className="p-3 text-right font-mono">
                {fmtUsd(p.default_overage_cap_micros)}
              </td>
              <td className="p-3 text-right">{p.rate_limit_rpm}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AgentDetailModal({
  detail,
  onClose,
}: {
  detail: AdminAgentDetail | null
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold">Agent Detail</h2>
            <button onClick={onClose} className="text-gray-500 text-2xl">
              ×
            </button>
          </div>
          {!detail ? (
            <div className="text-gray-500">Loading…</div>
          ) : (
            <>
              <div className="space-y-2 mb-4 text-sm">
                <div>
                  <strong>Agent ID:</strong>{' '}
                  <code>{detail.agent.agent_id}</code>
                </div>
                <div>
                  <strong>Owner:</strong> {detail.agent.user_email || '—'}
                </div>
                <div>
                  <strong>Gateway:</strong>{' '}
                  <code className="text-xs">{detail.agent.gateway_url}</code>
                </div>
              </div>

              <h3 className="font-semibold mt-4 mb-2">Recent usage events</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left p-2">Time</th>
                      <th className="text-left p-2">Kind</th>
                      <th className="text-left p-2">Model</th>
                      <th className="text-right p-2">In</th>
                      <th className="text-right p-2">Out</th>
                      <th className="text-right p-2">Queries</th>
                      <th className="text-right p-2">Cost</th>
                      <th className="text-right p-2">Latency</th>
                      <th className="text-right p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.recent_events.map((e: UsageEvent) => (
                      <tr key={e.event_id} className="border-t">
                        <td className="p-2 text-gray-500">{fmtDate(e.ts)}</td>
                        <td className="p-2">{e.kind}</td>
                        <td className="p-2 font-mono text-xs">{e.model}</td>
                        <td className="p-2 text-right">{e.input_tokens ?? '—'}</td>
                        <td className="p-2 text-right">{e.output_tokens ?? '—'}</td>
                        <td className="p-2 text-right">{e.search_queries ?? '—'}</td>
                        <td className="p-2 text-right font-mono">
                          {fmtUsd(e.cost_micros)}
                        </td>
                        <td className="p-2 text-right">{e.latency_ms ?? '—'}ms</td>
                        <td className="p-2 text-right">
                          <span
                            className={
                              e.upstream_status === 200
                                ? 'text-green-600'
                                : 'text-red-600'
                            }
                          >
                            {e.upstream_status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {detail.spend && 'error' in detail.spend && (
                <div className="mt-4 p-3 bg-yellow-50 text-yellow-800 text-sm rounded">
                  Meter unreachable: {String(detail.spend.error)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
