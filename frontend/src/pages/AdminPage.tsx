import { useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  adminCreateCoupon,
  adminGrantPlan,
  adminListCouponRedemptions,
  adminListCoupons,
  adminSetCouponDisabled,
  getAdminOverview,
  getAdminAgentDetail,
  getAdminVmStats,
  rotateMeterKey,
  setUserRole,
  type AdminCouponRedemptionRow,
  type AdminCouponRow,
} from '../lib/api'
import type {
  AdminOverview,
  AdminAgentRow,
  AdminUserRow,
  AdminAgentDetail,
  UsageEvent,
} from '../lib/types'

type AdminTab = 'agents' | 'users' | 'plans' | 'coupons' | 'stats'
const VALID_TABS: readonly AdminTab[] = ['agents', 'users', 'plans', 'coupons', 'stats']

function readTabFromUrl(): AdminTab {
  if (typeof window === 'undefined') return 'agents'
  const p = new URLSearchParams(window.location.search).get('tab')
  return (VALID_TABS as readonly string[]).includes(p ?? '') ? (p as AdminTab) : 'agents'
}

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
  const [tab, setTab] = useState<AdminTab>(readTabFromUrl)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (tab === 'agents') params.delete('tab')
    else params.set('tab', tab)
    const qs = params.toString()
    const url = `${window.location.pathname}${qs ? '?' + qs : ''}${window.location.hash}`
    window.history.replaceState(null, '', url)
  }, [tab])

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
        {(['agents', 'users', 'plans', 'coupons'] as const).map((t) => {
          // Coupons are loaded by the tab's own component on mount,
          // not by the top-level overview, so the count is omitted.
          const count = t === 'coupons' ? null : (overview[t] as unknown[]).length
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 capitalize ${
                tab === t
                  ? 'border-b-2 border-blue-600 text-blue-600 font-semibold'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              {t}{count !== null ? ` (${count})` : ''}
            </button>
          )
        })}
        <button
          onClick={() => setTab('stats')}
          className={`px-4 py-2 ${
            tab === 'stats'
              ? 'border-b-2 border-blue-600 text-blue-600 font-semibold'
              : 'text-gray-500 hover:text-gray-800'
          }`}
        >
          Stats (for nerds)
        </button>
      </div>

      {tab === 'agents' && (
        <AgentsTab
          agents={overview.agents}
          plans={overview.plans}
          onSelect={setSelectedAgentId}
          onRotateKey={handleRotateKey}
          onGranted={reload}
        />
      )}

      {tab === 'users' && (
        <UsersTab users={overview.users} onPromote={handlePromote} />
      )}

      {tab === 'plans' && <PlansTab plans={overview.plans} />}

      {tab === 'coupons' && <CouponsTab plans={overview.plans} />}

      {tab === 'stats' && <StatsTab />}

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
  plans,
  onSelect,
  onRotateKey,
  onGranted,
}: {
  agents: AdminAgentRow[]
  plans: AdminOverview['plans']
  onSelect: (id: string) => void
  onRotateKey: (id: string) => void
  onGranted: () => void
}) {
  const [grantTenantId, setGrantTenantId] = useState<number | null>(null)

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
                  {a.tenant_id != null && (
                    <button
                      onClick={() => setGrantTenantId(a.tenant_id)}
                      className="btn-secondary btn-sm"
                    >
                      Grant plan
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {grantTenantId !== null && (
        <GrantPlanModal
          tenantId={grantTenantId}
          plans={plans}
          onClose={() => setGrantTenantId(null)}
          onGranted={() => {
            setGrantTenantId(null)
            onGranted()
          }}
        />
      )}
    </div>
  )
}

function GrantPlanModal({
  tenantId,
  plans,
  onClose,
  onGranted,
}: {
  tenantId: number
  plans: AdminOverview['plans']
  onClose: () => void
  onGranted: () => void
}) {
  const [planId, setPlanId] = useState(plans[0]?.plan_id || 'minimal')
  const [durationDays, setDurationDays] = useState(30)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    setSubmitting(true)
    setError(null)
    try {
      await adminGrantPlan(tenantId, { plan_id: planId, duration_days: durationDays })
      onGranted()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">Grant plan to tenant {tenantId}</h3>
          <button onClick={onClose} className="text-gray-500 text-2xl">×</button>
        </div>
        <div className="space-y-3">
          <label className="block">
            <div className="text-xs font-semibold mb-1">Plan</div>
            <select value={planId} onChange={(e) => setPlanId(e.target.value)} className="input-glass w-full">
              {plans.map((p) => (
                <option key={p.plan_id} value={p.plan_id}>
                  {p.plan_id} — {p.name_he} (₪{(p.price_ils_cents / 100).toFixed(0)})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="text-xs font-semibold mb-1">Duration (days)</div>
            <input
              type="number"
              min={1}
              max={3650}
              value={durationDays}
              onChange={(e) => setDurationDays(Number(e.target.value))}
              className="input-glass w-full"
            />
          </label>
          <p className="text-xs text-gray-500">
            Logged as an admin grant (coupon_id=NULL, granted_by_admin=you). Same supersession rules
            as a coupon: upgrades take effect immediately, downgrades and same-plan renewals queue
            at the current period end.
          </p>
          {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-2">{error}</div>}
          <button onClick={handleSubmit} disabled={submitting} className="btn-brand w-full">
            {submitting ? 'Granting…' : 'Grant plan'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Coupons tab ────────────────────────────────────────────────────────

function CouponsTab({ plans }: { plans: AdminOverview['plans'] }) {
  const [coupons, setCoupons] = useState<AdminCouponRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [openRedemptionsFor, setOpenRedemptionsFor] = useState<AdminCouponRow | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const r = await adminListCoupons()
      setCoupons(r.coupons)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function handleToggle(coupon: AdminCouponRow) {
    const willDisable = !coupon.disabled_at
    if (!confirm(`${willDisable ? 'Disable' : 'Re-enable'} coupon ${coupon.code}?`)) return
    try {
      await adminSetCouponDisabled(coupon.id, willDisable)
      await load()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  if (loading) return <div className="p-6 text-gray-500">Loading coupons…</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Coupons</h2>
        <button onClick={() => setShowCreate((v) => !v)} className="btn-brand btn-sm">
          {showCreate ? 'Cancel' : 'New coupon'}
        </button>
      </div>

      {showCreate && (
        <CouponCreateForm
          plans={plans}
          onCreated={() => {
            setShowCreate(false)
            load()
          }}
        />
      )}

      {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}

      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3">Code</th>
              <th className="text-left p-3">Plan</th>
              <th className="text-right p-3">Days</th>
              <th className="text-right p-3">Used / Cap</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Valid until</th>
              <th className="text-left p-3">Notes</th>
              <th className="text-right p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {coupons.map((c) => {
              const status = couponStatus(c)
              return (
                <tr key={c.id} className="border-t hover:bg-gray-50">
                  <td className="p-3 font-mono text-xs">{c.code}</td>
                  <td className="p-3">{c.plan_name_he} <span className="text-gray-400">({c.plan_id})</span></td>
                  <td className="p-3 text-right">{c.duration_days}</td>
                  <td className="p-3 text-right">
                    {c.redemption_count}/{c.max_redemptions ?? '∞'}
                  </td>
                  <td className="p-3">
                    <span className={statusColor(status)}>{status}</span>
                  </td>
                  <td className="p-3 text-xs text-gray-500">
                    {c.valid_until ? new Date(c.valid_until).toLocaleDateString('en-GB') : '—'}
                  </td>
                  <td className="p-3 text-xs text-gray-500 max-w-xs truncate" title={c.notes}>
                    {c.notes || '—'}
                  </td>
                  <td className="p-3 text-right space-x-2">
                    <button
                      onClick={() => setOpenRedemptionsFor(c)}
                      className="btn-secondary btn-sm"
                    >
                      Redemptions
                    </button>
                    <button onClick={() => handleToggle(c)} className="btn-secondary btn-sm">
                      {c.disabled_at ? 'Enable' : 'Disable'}
                    </button>
                  </td>
                </tr>
              )
            })}
            {coupons.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-gray-500">
                  No coupons yet — click "New coupon" to mint one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {openRedemptionsFor && (
        <RedemptionsModal
          coupon={openRedemptionsFor}
          onClose={() => setOpenRedemptionsFor(null)}
        />
      )}
    </div>
  )
}

function couponStatus(c: AdminCouponRow): 'active' | 'disabled' | 'expired' | 'exhausted' | 'pending' {
  if (c.disabled_at) return 'disabled'
  const now = new Date()
  if (c.valid_until && new Date(c.valid_until) < now) return 'expired'
  if (c.valid_from && new Date(c.valid_from) > now) return 'pending'
  if (c.max_redemptions != null && c.redemption_count >= c.max_redemptions) return 'exhausted'
  return 'active'
}

function statusColor(s: string): string {
  switch (s) {
    case 'active': return 'text-green-600 font-semibold'
    case 'disabled': return 'text-gray-400'
    case 'expired': return 'text-red-600'
    case 'exhausted': return 'text-amber-600'
    case 'pending': return 'text-blue-600'
    default: return 'text-gray-500'
  }
}

function CouponCreateForm({
  plans,
  onCreated,
}: {
  plans: AdminOverview['plans']
  onCreated: () => void
}) {
  const [code, setCode] = useState('')
  const [planId, setPlanId] = useState(plans[0]?.plan_id || 'minimal')
  const [durationDays, setDurationDays] = useState(30)
  const [maxRedemptions, setMaxRedemptions] = useState<string>('')
  const [validUntil, setValidUntil] = useState('')
  const [onePerUser, setOnePerUser] = useState(true)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdCode, setCreatedCode] = useState<string | null>(null)

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const max = maxRedemptions.trim() ? Number(maxRedemptions) : null
      const validUntilIso = validUntil ? new Date(validUntil + 'T23:59:59').toISOString() : null
      const created = await adminCreateCoupon({
        code: code.trim() || undefined,
        plan_id: planId,
        duration_days: durationDays,
        max_redemptions: max,
        valid_until: validUntilIso,
        one_per_user: onePerUser,
        notes: notes.trim(),
      })
      setCreatedCode(created.code)
      // Reset form (keep plan + duration as sensible defaults for the next create)
      setCode('')
      setMaxRedemptions('')
      setValidUntil('')
      setNotes('')
      // Don't dismiss yet — show the created code so the admin can copy it.
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="glass-card p-5 space-y-3">
      {createdCode ? (
        <>
          <div className="text-sm">
            <strong>Created:</strong>{' '}
            <code className="font-mono bg-green-50 text-green-800 px-2 py-1 rounded">
              {createdCode}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(createdCode)}
              className="btn-secondary btn-sm ml-2"
            >
              Copy
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setCreatedCode(null)} className="btn-secondary btn-sm">
              Create another
            </button>
            <button onClick={onCreated} className="btn-brand btn-sm">
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="block">
              <div className="text-xs font-semibold mb-1">Code (optional)</div>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="auto-generated if blank"
                className="input-glass w-full font-mono uppercase"
              />
            </label>
            <label className="block">
              <div className="text-xs font-semibold mb-1">Plan</div>
              <select value={planId} onChange={(e) => setPlanId(e.target.value)} className="input-glass w-full">
                {plans.map((p) => (
                  <option key={p.plan_id} value={p.plan_id}>
                    {p.plan_id} — {p.name_he}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <div className="text-xs font-semibold mb-1">Duration (days)</div>
              <input
                type="number"
                min={1}
                max={3650}
                value={durationDays}
                onChange={(e) => setDurationDays(Number(e.target.value))}
                className="input-glass w-full"
              />
            </label>
            <label className="block">
              <div className="text-xs font-semibold mb-1">Max redemptions</div>
              <input
                type="number"
                min={1}
                value={maxRedemptions}
                onChange={(e) => setMaxRedemptions(e.target.value)}
                placeholder="unlimited"
                className="input-glass w-full"
              />
            </label>
            <label className="block">
              <div className="text-xs font-semibold mb-1">Valid until</div>
              <input
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
                className="input-glass w-full"
              />
            </label>
            <label className="flex items-center gap-2 mt-6">
              <input
                type="checkbox"
                checked={onePerUser}
                onChange={(e) => setOnePerUser(e.target.checked)}
              />
              <span className="text-sm">One per user</span>
            </label>
          </div>
          <label className="block">
            <div className="text-xs font-semibold mb-1">Notes</div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="input-glass w-full"
              placeholder="Internal note — who/why this coupon was created"
            />
          </label>
          {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-2">{error}</div>}
          <button onClick={submit} disabled={submitting} className="btn-brand">
            {submitting ? 'Creating…' : 'Create coupon'}
          </button>
        </>
      )}
    </div>
  )
}

function RedemptionsModal({
  coupon,
  onClose,
}: {
  coupon: AdminCouponRow
  onClose: () => void
}) {
  const [rows, setRows] = useState<AdminCouponRedemptionRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    adminListCouponRedemptions(coupon.id)
      .then((r) => setRows(r.redemptions))
      .finally(() => setLoading(false))
  }, [coupon.id])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">
            Redemptions — <code className="font-mono text-base">{coupon.code}</code>
          </h3>
          <button onClick={onClose} className="text-gray-500 text-2xl">×</button>
        </div>
        {loading ? (
          <div className="text-gray-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-gray-500">No redemptions yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2">User</th>
                <th className="text-left p-2">Tenant</th>
                <th className="text-left p-2">Period</th>
                <th className="text-left p-2">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">{r.user_email}</td>
                  <td className="p-2">{r.tenant_name}</td>
                  <td className="p-2 text-xs text-gray-500">
                    {new Date(r.period_start).toLocaleDateString('en-GB')} →{' '}
                    {new Date(r.period_end).toLocaleDateString('en-GB')}
                  </td>
                  <td className="p-2 text-xs text-gray-500">
                    {new Date(r.redeemed_at).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
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

// ─── Stats tab (VM capacity + nerd metrics) ────────────────────────

interface VmStatsResponse {
  live: {
    cpu?: {
      percent: number
      cores: number
      load_avg_1m: number
      load_avg_5m: number
      load_avg_15m: number
    }
    memory?: {
      total_mb: number
      used_mb: number
      available_mb: number
      percent: number
    }
    disk?: {
      root?: { total_gb: number; used_gb: number; free_gb: number; percent: number }
      data?: { total_gb: number; used_gb: number; free_gb: number; percent: number }
    }
    docker?: {
      total: number
      running: number
      containers: Array<{ name: string; image: string; state: string; status: string }>
    }
    uptime_seconds?: number
    hostname?: string
  } | null
  live_error: string | null
  history: Array<{
    ts: string
    cpu_percent: number | null
    memory_percent: number | null
    disk_root_pct: number | null
    disk_data_pct: number | null
    containers_run: number | null
    load_avg_1m: number | null
  }>
  events_per_hour: Array<{
    hour: string
    events: number
    cost_micros: number
    avg_latency_ms: number | null
  }>
  top_agents: Array<{
    agent_id: string
    cost_micros: number
    events: number
    total_tokens: number
  }>
  meter_latency_1h: {
    n: number
    p50: number | null
    p95: number | null
    p99: number | null
  } | null
  today_totals: {
    requests: number
    llm_requests: number
    search_requests: number
    embedding_requests: number
    input_tokens: number
    output_tokens: number
    cached_tokens: number
    search_queries: number
    cost_micros: number
    llm_cost_micros: number
    search_cost_micros: number
    embedding_cost_micros: number
  } | null
  cost_by_kind_per_hour: Array<{
    hour: string
    llm_cost_micros: number
    search_cost_micros: number
    embedding_cost_micros: number
    llm_events: number
    search_events: number
    embedding_events: number
  }>
  tokens_per_hour: Array<{
    hour: string
    input_tokens: number
    output_tokens: number
    cached_tokens: number
  }>
  model_breakdown_7d: Array<{
    model: string
    kind: 'llm' | 'search' | 'tts' | 'embedding'
    events: number
    cost_micros: number
    total_tokens: number
  }>
}

function StatsTab() {
  const [data, setData] = useState<VmStatsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    try {
      const r = await getAdminVmStats()
      setData(r)
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 10_000) // auto-refresh every 10s
    return () => clearInterval(id)
  }, [])

  if (err) return <div className="p-6 text-red-600">Error: {err}</div>
  if (!data) return <div className="p-6 text-gray-500">Loading…</div>

  return (
    <div className="space-y-6">
      <LiveCard data={data} />
      <TodayUsageTotals totals={data.today_totals} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CostByKindChart hours={data.cost_by_kind_per_hour} />
        <TokensThroughputChart hours={data.tokens_per_hour} />
      </div>
      <TrafficChart events={data.events_per_hour} />
      <HistoryCharts history={data.history} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MeterLatencyCard latency={data.meter_latency_1h} />
        <TopAgentsCard agents={data.top_agents} />
      </div>
      <ModelBreakdownCard rows={data.model_breakdown_7d} />
      <ContainersCard containers={data.live?.docker?.containers || []} />
    </div>
  )
}

// Tiny self-positioning tooltip used by chart headers and metric tiles. Pure
// React + Tailwind, no portal, no lib. Shows instantly on hover and toggles on
// click so it also works on touch. Placement defaults to "right" — the bubble
// hangs off the right side of the ⓘ so it doesn't clip against card edges.
function InfoTip({
  text,
  placement = 'right',
}: {
  text: string
  placement?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const bubbleSide =
    placement === 'right' ? 'left-0 ml-0' : 'right-0 mr-0'
  const arrowSide = placement === 'right' ? 'left-3' : 'right-3'
  return (
    <span className="relative inline-block align-middle">
      <span
        role="button"
        tabIndex={0}
        aria-label={text}
        className="cursor-help opacity-60 hover:opacity-100 focus:opacity-100 focus:outline-none select-none text-gray-400 text-[12px] leading-none"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((v) => !v)
          }
          if (e.key === 'Escape') setOpen(false)
        }}
      >
        ⓘ
      </span>
      {open && (
        <span
          role="tooltip"
          className={`absolute z-50 top-full mt-2 ${bubbleSide} w-64 max-w-[80vw] rounded-lg bg-gray-900 text-white text-xs font-normal normal-case leading-relaxed px-3 py-2 shadow-xl pointer-events-none`}
        >
          <span
            className={`absolute -top-1 ${arrowSide} w-2 h-2 bg-gray-900 rotate-45`}
          />
          {text}
        </span>
      )}
    </span>
  )
}

function colorForPct(pct: number, yellow: number, red: number): string {
  if (pct >= red) return 'text-red-600 bg-red-50'
  if (pct >= yellow) return 'text-yellow-600 bg-yellow-50'
  return 'text-green-600 bg-green-50'
}

function barColor(pct: number, yellow: number, red: number): string {
  if (pct >= red) return 'bg-red-500'
  if (pct >= yellow) return 'bg-yellow-500'
  return 'bg-green-500'
}

function MetricTile({
  label,
  value,
  unit,
  pct,
  yellow,
  red,
  sub,
  info,
}: {
  label: string
  value: string | number
  unit?: string
  pct: number
  yellow: number
  red: number
  sub?: string
  info?: string
}) {
  const color = colorForPct(pct, yellow, red)
  const bar = barColor(pct, yellow, red)
  return (
    <div className={`rounded-xl p-4 ${color}`}>
      <div className="text-xs font-semibold uppercase tracking-wide opacity-70 flex items-center gap-1.5">
        <span>{label}</span>
        {info && <InfoTip text={info} />}
      </div>
      <div className="text-2xl font-bold mt-1">
        {value}
        {unit && <span className="text-sm font-normal opacity-70 ml-1">{unit}</span>}
      </div>
      <div className="w-full h-1.5 bg-white/60 rounded-full mt-2 overflow-hidden">
        <div className={`h-full ${bar} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {sub && <div className="text-xs opacity-70 mt-1">{sub}</div>}
    </div>
  )
}

function LiveCard({ data }: { data: VmStatsResponse }) {
  const live = data.live
  if (!live) {
    return (
      <div className="glass-card p-6">
        <div className="text-red-600">VM stats unreachable: {data.live_error}</div>
        <div className="text-xs text-gray-500 mt-2">
          Make sure vm-stats systemd service is running on openclaw-prod and APP_VM_STATS_TOKEN
          matches.
        </div>
      </div>
    )
  }
  const cpu = live.cpu
  const mem = live.memory
  const diskRoot = live.disk?.root
  const diskData = live.disk?.data
  const docker = live.docker
  const uptimeDays = live.uptime_seconds ? Math.floor(live.uptime_seconds / 86400) : 0
  const uptimeHours = live.uptime_seconds ? Math.floor((live.uptime_seconds % 86400) / 3600) : 0

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">
          Live — <span className="font-mono text-sm text-gray-600">{live.hostname}</span>
        </h2>
        <div className="text-xs text-gray-500">
          up {uptimeDays}d {uptimeHours}h · updates every 10s
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {cpu && (
          <MetricTile
            label="CPU"
            value={cpu.percent.toFixed(1)}
            unit="%"
            pct={cpu.percent}
            yellow={60}
            red={80}
            sub={`${cpu.cores} cores · load ${cpu.load_avg_1m}`}
            info="VM-wide CPU utilisation across all cores. Load avg is the 1-minute run-queue length — values above core count mean processes are waiting."
          />
        )}
        {mem && (
          <MetricTile
            label="RAM"
            value={mem.percent.toFixed(1)}
            unit="%"
            pct={mem.percent}
            yellow={65}
            red={85}
            sub={`${(mem.used_mb / 1024).toFixed(1)}G / ${(mem.total_mb / 1024).toFixed(1)}G`}
            info="Physical memory in use across the host (containers + system). High values increase the risk of OOM-killing OpenClaw containers."
          />
        )}
        {diskRoot && (
          <MetricTile
            label="Disk /"
            value={diskRoot.percent.toFixed(1)}
            unit="%"
            pct={diskRoot.percent}
            yellow={60}
            red={80}
            sub={`${diskRoot.used_gb}G / ${diskRoot.total_gb}G`}
            info="Boot disk: OS, /opt/agentleh (compose, scripts, plugins, .env), /opt/whisper-* (HF model cache ~1.5G), Docker images & layers. Filling it blocks deploys. 7-day snapshot retention."
          />
        )}
        {diskData && diskData.total_gb > 0 && (
          <MetricTile
            label="Disk /data"
            value={diskData.percent.toFixed(1)}
            unit="%"
            pct={diskData.percent}
            yellow={60}
            red={80}
            sub={`${diskData.used_gb}G / ${diskData.total_gb}G`}
            info="Dedicated data PD: per-agent OpenClaw state under /data/agents/{id}/ — workspace, MEMORY.md, sessions. Grows with conversation history. 14-day daily snapshots via openclaw-data-daily."
          />
        )}
        {docker && (
          <MetricTile
            label="Containers"
            value={docker.running}
            unit={`/ ${docker.total}`}
            pct={(docker.running / 25) * 100}
            yellow={60}
            red={80}
            sub={`${docker.running} running`}
            info="Docker containers on this VM (running / total). One per agent (OpenClaw) plus shared services like Vector. Bar is scaled against a soft cap of 25."
          />
        )}
      </div>
    </div>
  )
}

const CHART_GRID = '#e5e7eb'
const AXIS_TICK = { fill: '#6b7280', fontSize: 11 }
const AXIS_LINE = { stroke: '#e5e7eb' }

const CHART_COLORS = {
  cpu: '#3b82f6',         // blue   — VM CPU
  ram: '#8b5cf6',         // purple — VM RAM
  disk: '#f59e0b',        // amber  — VM disk
  containers: '#10b981',  // green  — VM containers
  llm: '#3b82f6',         // blue   — LLM / chat / input tokens
  search: '#10b981',      // green  — grounding search
  tts: '#f59e0b',         // amber  — voice / TTS
  embedding: '#ec4899',   // pink   — memory-search embeddings
  output: '#8b5cf6',      // purple — output tokens
  cached: '#f59e0b',      // amber  — cached tokens
  events: '#0ea5e9',      // sky    — request volume
  cost: '#ef4444',        // red    — money
  latency: '#6366f1',     // indigo — latency
  spend: '#0ea5e9',       // sky    — top-agents spend bars
  model: '#6366f1',       // indigo — model breakdown bars
} as const

const CHART_MARGIN = { top: 10, right: 12, left: -10, bottom: 0 }

const tooltipStyle = {
  background: 'rgba(255,255,255,0.97)',
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  fontSize: 12,
  padding: '8px 10px',
  boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
}
const tooltipLabelStyle = { color: '#374151', fontWeight: 600, marginBottom: 4 }
const tooltipItemStyle = { padding: 0 }
const tooltipCursor = { fill: '#6b7280', opacity: 0.06 }
const legendStyle = { fontSize: 12, paddingTop: 8 }

function fmtHourLabel(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function fmtHourOnly(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit' }) + ':00'
}

function fmtCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function fmtUsdMicros(micros: number, digits = 4): string {
  return `$${(micros / 1_000_000).toFixed(digits)}`
}

function UsageTile({
  label,
  value,
  sub,
  accent,
  info,
}: {
  label: string
  value: string
  sub?: string
  accent: string
  info?: string
}) {
  return (
    <div className="rounded-xl p-4 bg-white border border-gray-100 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1.5">
        <span>{label}</span>
        {info && <InfoTip text={info} />}
      </div>
      <div className="text-2xl font-bold mt-1" style={{ color: accent }}>
        {value}
      </div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  )
}

function TodayUsageTotals({ totals }: { totals: VmStatsResponse['today_totals'] }) {
  if (!totals || totals.requests === 0) {
    return (
      <div className="glass-card p-6 text-sm text-gray-500">
        No LLM or search activity in the last 24 hours.
      </div>
    )
  }
  const llmShare = totals.cost_micros > 0
    ? Math.round((totals.llm_cost_micros / totals.cost_micros) * 100)
    : 0
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-xl font-bold">Usage — last 24 hours</h2>
        <div className="text-xs text-gray-500">via agentleh-meter</div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <UsageTile
          label="Requests"
          value={fmtCompactNumber(totals.requests)}
          sub={`${fmtCompactNumber(totals.llm_requests)} LLM · ${fmtCompactNumber(totals.search_requests)} search · ${fmtCompactNumber(totals.embedding_requests)} embed`}
          accent="#0ea5e9"
          info="Total upstream calls routed through agentleh-meter in the last 24 hours: chat completions (kind=llm), grounding-search queries (kind=search), and memory-search embeddings (kind=embedding)."
        />
        <UsageTile
          label="Input tokens"
          value={fmtCompactNumber(totals.input_tokens)}
          sub={
            totals.cached_tokens > 0
              ? `${fmtCompactNumber(totals.cached_tokens)} cached`
              : 'sent to model'
          }
          accent="#3b82f6"
          info="Prompt tokens billed by the upstream LLM in the last 24h. Sudden growth without matching output growth usually means context bloat (compaction failing or runaway memory)."
        />
        <UsageTile
          label="Output tokens"
          value={fmtCompactNumber(totals.output_tokens)}
          sub="generated"
          accent="#8b5cf6"
          info="Completion tokens generated by the model in the last 24h. Reflects how much the agents are actually saying back to users."
        />
        <UsageTile
          label="Search queries"
          value={fmtCompactNumber(totals.search_queries)}
          sub="grounding"
          accent="#10b981"
          info="Gemini grounding-search queries in the last 24h. Each query is billed at $14/1k (Gemini 3) — high volume here is the usual cost-spike culprit."
        />
        <UsageTile
          label="Cost"
          value={fmtUsdMicros(totals.cost_micros, 3)}
          sub={`${fmtUsdMicros(totals.llm_cost_micros, 3)} LLM · ${fmtUsdMicros(totals.search_cost_micros, 3)} search · ${fmtUsdMicros(totals.embedding_cost_micros, 3)} embed · ${llmShare}% LLM`}
          accent="#ef4444"
          info="Total cost across all agents in the last 24h, billed by the upstream Google API and recorded by agentleh-meter. Split by kind in the sub-line."
        />
      </div>
    </div>
  )
}

function CostByKindChart({ hours }: { hours: VmStatsResponse['cost_by_kind_per_hour'] }) {
  if (hours.length === 0) {
    return (
      <div className="glass-card p-6 text-sm text-gray-500">
        No cost data in the last 24 hours.
      </div>
    )
  }
  const data = hours.map((h) => ({
    hour: fmtHourOnly(h.hour),
    llm: Number(h.llm_cost_micros) / 1_000_000,
    search: Number(h.search_cost_micros) / 1_000_000,
    embedding: Number(h.embedding_cost_micros) / 1_000_000,
  }))
  const totalLlm = data.reduce((a, b) => a + b.llm, 0)
  const totalSearch = data.reduce((a, b) => a + b.search, 0)
  const totalEmbedding = data.reduce((a, b) => a + b.embedding, 0)
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-semibold">Cost by kind — last 24h</h3>
          <InfoTip text="Per-hour stacked cost split between LLM (chat completions, per-token), grounding search (per-query, ~$14/1k on Gemini 3), and memory-search embeddings (per-token on gemini-embedding-001, ~$0.15/Mtok). Grounding search is usually the biggest cost lever." />
        </div>
        <div className="text-xs text-gray-600">
          <span className="font-mono font-semibold" style={{ color: CHART_COLORS.llm }}>${totalLlm.toFixed(4)}</span>
          {' '}LLM ·{' '}
          <span className="font-mono font-semibold" style={{ color: CHART_COLORS.search }}>${totalSearch.toFixed(4)}</span>
          {' '}search ·{' '}
          <span className="font-mono font-semibold" style={{ color: CHART_COLORS.embedding }}>${totalEmbedding.toFixed(4)}</span>
          {' '}embed
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={CHART_MARGIN} barCategoryGap="20%">
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="hour" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} minTickGap={28} />
          <YAxis
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `$${Number(v).toFixed(3)}`}
            width={56}
            padding={{ top: 8 }}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
            cursor={tooltipCursor}
            formatter={(v) => `$${Number(v).toFixed(4)}`}
          />
          <Legend wrapperStyle={legendStyle} iconType="circle" />
          <Bar dataKey="llm" name="LLM" stackId="cost" fill={CHART_COLORS.llm} maxBarSize={48} isAnimationActive={false} />
          <Bar dataKey="search" name="Search" stackId="cost" fill={CHART_COLORS.search} maxBarSize={48} isAnimationActive={false} />
          <Bar dataKey="embedding" name="Embedding" stackId="cost" fill={CHART_COLORS.embedding} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function TokensThroughputChart({ hours }: { hours: VmStatsResponse['tokens_per_hour'] }) {
  if (hours.length === 0) {
    return (
      <div className="glass-card p-6 text-sm text-gray-500">
        No token data in the last 24 hours.
      </div>
    )
  }
  const data = hours.map((h) => ({
    hour: fmtHourOnly(h.hour),
    input: Number(h.input_tokens),
    output: Number(h.output_tokens),
    cached: Number(h.cached_tokens),
  }))
  const totalInput = data.reduce((a, b) => a + b.input, 0)
  const totalOutput = data.reduce((a, b) => a + b.output, 0)
  const ratio = totalOutput > 0 ? (totalInput / totalOutput).toFixed(1) : '∞'
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-semibold">Token throughput — last 24h</h3>
          <InfoTip text="Per-hour input vs output tokens for LLM calls. Watch the gap — input climbing without output climbing means context bloat (compaction failing or runaway memory)." />
        </div>
        <div className="text-xs text-gray-600">
          ratio in/out <span className="font-mono font-semibold">{ratio}x</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data} margin={CHART_MARGIN}>
          <defs>
            <linearGradient id="inputFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.llm} stopOpacity={0.45} />
              <stop offset="100%" stopColor={CHART_COLORS.llm} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="outputFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.output} stopOpacity={0.45} />
              <stop offset="100%" stopColor={CHART_COLORS.output} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="hour" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} minTickGap={28} />
          <YAxis
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => fmtCompactNumber(Number(v))}
            width={48}
            padding={{ top: 8 }}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
            cursor={{ stroke: '#9ca3af', strokeWidth: 1, strokeDasharray: '3 3' }}
            formatter={(v) => Number(v).toLocaleString()}
          />
          <Legend wrapperStyle={legendStyle} iconType="circle" />
          <Area type="monotone" dataKey="input" name="Input" stroke={CHART_COLORS.llm} strokeWidth={2} fill="url(#inputFill)" activeDot={{ r: 4 }} isAnimationActive={false} />
          <Area type="monotone" dataKey="output" name="Output" stroke={CHART_COLORS.output} strokeWidth={2} fill="url(#outputFill)" activeDot={{ r: 4 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function ModelBreakdownCard({ rows }: { rows: VmStatsResponse['model_breakdown_7d'] }) {
  if (rows.length === 0) {
    return (
      <div className="glass-card p-6">
        <h3 className="text-base font-semibold mb-3">Cost by model — last 7 days</h3>
        <div className="text-sm text-gray-500">No model usage in the last 7 days.</div>
      </div>
    )
  }
  // One bar per (model, kind) so the kind is honest in the chart, not buried
  // in a footnote. Most models have one kind so this collapses to one bar each.
  const chartData = rows
    .slice()
    .sort((a, b) => Number(b.cost_micros) - Number(a.cost_micros))
    .map((r) => ({
      model: r.model,
      kind: r.kind,
      usd: Number(r.cost_micros) / 1_000_000,
      events: Number(r.events),
      tokens: Number(r.total_tokens),
      // include kind in the y-axis label only if a model has both
      label: r.model,
    }))
  const maxUsd = Math.max(...chartData.map((d) => d.usd), 0.001)
  const chartHeight = Math.max(160, chartData.length * 36 + 30)
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-semibold">Cost by model — last 7 days</h3>
          <InfoTip text="Per-(model, kind) spend over the last 7 days. Bar color encodes kind: blue = LLM/chat, green = grounding search, amber = voice/TTS, pink = memory-search embeddings. Any unexpected model at the top means an accidental fallback — fix it before it compounds." />
        </div>
        <div className="text-xs text-gray-500">
          <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: CHART_COLORS.llm }} />LLM
          <span className="inline-block w-2 h-2 rounded-full mr-1 ml-2 align-middle" style={{ background: CHART_COLORS.search }} />Search
          <span className="inline-block w-2 h-2 rounded-full mr-1 ml-2 align-middle" style={{ background: CHART_COLORS.tts }} />TTS
          <span className="inline-block w-2 h-2 rounded-full mr-1 ml-2 align-middle" style={{ background: CHART_COLORS.embedding }} />Embed
        </div>
      </div>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 80, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} horizontal={false} />
          <XAxis
            type="number"
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            domain={[0, Math.ceil(maxUsd * 1.15 * 100) / 100]}
            tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ ...AXIS_TICK, fontFamily: 'ui-monospace, monospace', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={210}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
            cursor={tooltipCursor}
            formatter={(v, name) =>
              name === 'Spend' ? `$${Number(v).toFixed(4)}` : Number(v).toLocaleString()
            }
          />
          <Bar dataKey="usd" name="Spend" radius={[0, 6, 6, 0]} maxBarSize={26} isAnimationActive={false}>
            {chartData.map((row, i) => (
              <Cell
                key={`${row.model}-${row.kind}-${i}`}
                fill={
                  row.kind === 'search' ? CHART_COLORS.search
                  : row.kind === 'tts' ? CHART_COLORS.tts
                  : row.kind === 'embedding' ? CHART_COLORS.embedding
                  : CHART_COLORS.llm
                }
              />
            ))}
            <LabelList
              dataKey="usd"
              position="right"
              formatter={(v: unknown) => `$${Number(v).toFixed(4)}`}
              style={{ fill: '#374151', fontSize: 11, fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <table className="w-full text-xs mt-3">
        <thead className="text-gray-500">
          <tr>
            <th className="text-left p-1">Model</th>
            <th className="text-left p-1">Kind</th>
            <th className="text-right p-1">Spend</th>
            <th className="text-right p-1">Events</th>
            <th className="text-right p-1">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {chartData.map((m, i) => (
            <tr key={`${m.model}-${m.kind}-${i}`} className="border-t">
              <td className="p-1 font-mono">{m.model}</td>
              <td className="p-1">
                <span
                  className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
                  style={{
                    background: m.kind === 'search' ? '#dcfce7' : '#dbeafe',
                    color: m.kind === 'search' ? '#166534' : '#1e40af',
                  }}
                >
                  {m.kind}
                </span>
              </td>
              <td className="p-1 text-right font-mono">${m.usd.toFixed(4)}</td>
              <td className="p-1 text-right text-gray-500">{m.events.toLocaleString()}</td>
              <td className="p-1 text-right text-gray-500">{m.tokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HistoryCharts({ history }: { history: VmStatsResponse['history'] }) {
  if (history.length === 0) {
    return (
      <div className="glass-card p-6 text-sm text-gray-500">
        No historical samples yet. The vm-stats-sampler writes one row every 60s —
        data starts accumulating right after the timer is enabled.
      </div>
    )
  }
  const histData = history.map((r) => ({
    time: fmtHourLabel(r.ts),
    cpu: Number(r.cpu_percent ?? 0),
    ram: Number(r.memory_percent ?? 0),
    disk: Number(r.disk_data_pct ?? r.disk_root_pct ?? 0),
    containers: Number(r.containers_run ?? 0),
  }))
  const maxContainers = Math.max(5, ...histData.map((r) => r.containers))
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold">VM history — last 24 hours</h3>
        <span className="text-xs text-gray-500">{history.length} samples · 60s cadence</span>
      </div>
      <div className="space-y-6">
        <div>
          <div className="text-xs text-gray-600 mb-2">CPU · RAM · Disk (%)</div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={histData} margin={CHART_MARGIN}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
              <XAxis dataKey="time" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} minTickGap={32} />
              <YAxis
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tickFormatter={(v) => `${v}%`}
                width={40}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={tooltipLabelStyle}
                itemStyle={tooltipItemStyle}
                cursor={{ stroke: '#9ca3af', strokeWidth: 1, strokeDasharray: '3 3' }}
                formatter={(v) => `${Number(v).toFixed(1)}%`}
              />
              <Legend wrapperStyle={legendStyle} iconType="circle" />
              <Line type="monotone" dataKey="cpu" name="CPU" stroke={CHART_COLORS.cpu} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
              <Line type="monotone" dataKey="ram" name="RAM" stroke={CHART_COLORS.ram} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
              <Line type="monotone" dataKey="disk" name="Disk" stroke={CHART_COLORS.disk} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div>
          <div className="text-xs text-gray-600 mb-2">Running containers (agents only)</div>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={histData} margin={CHART_MARGIN}>
              <defs>
                <linearGradient id="containersFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_COLORS.containers} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={CHART_COLORS.containers} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
              <XAxis dataKey="time" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} minTickGap={32} />
              <YAxis
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                domain={[0, maxContainers]}
                allowDecimals={false}
                width={40}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={tooltipLabelStyle}
                itemStyle={tooltipItemStyle}
                cursor={{ stroke: '#9ca3af', strokeWidth: 1, strokeDasharray: '3 3' }}
              />
              <Area type="monotone" dataKey="containers" name="Containers" stroke={CHART_COLORS.containers} strokeWidth={2} fill="url(#containersFill)" activeDot={{ r: 4 }} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

function TrafficChart({ events }: { events: VmStatsResponse['events_per_hour'] }) {
  if (events.length === 0) {
    return (
      <div className="glass-card p-6 text-sm text-gray-500">
        No meter traffic in the last 24 hours.
      </div>
    )
  }
  const trafficData = events.map((r) => ({
    hour: fmtHourOnly(r.hour),
    events: Number(r.events),
    costUsd: Number(r.cost_micros) / 1_000_000,
  }))
  const totalEvents = trafficData.reduce((a, b) => a + b.events, 0)
  const totalCost = trafficData.reduce((a, b) => a + b.costUsd, 0)
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-semibold">Meter traffic — last 24h</h3>
          <InfoTip text="Total request volume (bars, left axis) and total cost (line, right axis) per hour. Volume is the dominant signal; the line shows whether the cost is correlated." />
        </div>
        <div className="text-xs text-gray-600">
          <span className="font-mono font-semibold">{fmtCompactNumber(totalEvents)}</span> events ·{' '}
          <span className="font-mono font-semibold">${totalCost.toFixed(4)}</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={trafficData} margin={CHART_MARGIN} barCategoryGap="20%">
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="hour" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} minTickGap={28} />
          <YAxis
            yAxisId="left"
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
            tickFormatter={(v) => fmtCompactNumber(Number(v))}
            width={44}
            padding={{ top: 8 }}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
            width={56}
            padding={{ top: 8 }}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
            cursor={tooltipCursor}
            formatter={(v, name) =>
              name === 'Cost' ? `$${Number(v).toFixed(4)}` : Number(v).toLocaleString()
            }
          />
          <Legend wrapperStyle={legendStyle} iconType="circle" />
          <Bar yAxisId="left" dataKey="events" name="Events" fill={CHART_COLORS.events} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false} />
          <Line yAxisId="right" type="monotone" dataKey="costUsd" name="Cost" stroke={CHART_COLORS.cost} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function MeterLatencyCard({ latency }: { latency: VmStatsResponse['meter_latency_1h'] }) {
  if (!latency || latency.n === 0) {
    return (
      <div className="glass-card p-6 text-sm text-gray-500">
        No meter activity in the last hour.
      </div>
    )
  }
  const data = [
    { name: 'p50', ms: latency.p50 ?? 0 },
    { name: 'p95', ms: latency.p95 ?? 0 },
    { name: 'p99', ms: latency.p99 ?? 0 },
  ]
  const maxMs = Math.max(...data.map((d) => d.ms), 1)
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-semibold">Meter latency — last 1h</h3>
          <InfoTip text="Round-trip latency through agentleh-meter for successful upstream calls (status 200) over the last hour. p50 = median, p99 = tail. Sustained p99 above 5s usually means the upstream Google API is degraded." />
        </div>
        <div className="text-xs text-gray-500">
          n = <span className="font-mono font-semibold">{latency.n.toLocaleString()}</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <BarChart data={data} layout="vertical" margin={{ top: 5, right: 60, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} horizontal={false} />
          <XAxis
            type="number"
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            domain={[0, Math.ceil(maxMs * 1.15)]}
            tickFormatter={(v) => `${v}ms`}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ ...AXIS_TICK, fontWeight: 600 }}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
            cursor={tooltipCursor}
            formatter={(v) => `${Number(v).toLocaleString()}ms`}
          />
          <Bar dataKey="ms" fill={CHART_COLORS.latency} radius={[0, 6, 6, 0]} maxBarSize={28} isAnimationActive={false}>
            <LabelList
              dataKey="ms"
              position="right"
              formatter={(v: unknown) => `${Number(v).toLocaleString()}ms`}
              style={{ fill: '#374151', fontSize: 11, fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function TopAgentsCard({ agents }: { agents: VmStatsResponse['top_agents'] }) {
  if (agents.length === 0) {
    return (
      <div className="glass-card p-6">
        <h3 className="text-base font-semibold mb-3">Top agents — last 30 days</h3>
        <div className="text-sm text-gray-500">No usage yet.</div>
      </div>
    )
  }
  const chartData = agents
    .slice()
    .sort((a, b) => b.cost_micros - a.cost_micros)
    .map((a) => ({
      agent: a.agent_id,
      usd: a.cost_micros / 1_000_000,
      events: a.events,
      tokens: Number(a.total_tokens),
    }))
  const maxUsd = Math.max(...chartData.map((d) => d.usd), 0.001)
  const chartHeight = Math.max(140, chartData.length * 36 + 30)
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-semibold">Top agents — last 30 days</h3>
          <InfoTip text="Top 5 agents by total cost over the last 30 days. The bar shows $ spend; the table below has events and tokens for each." />
        </div>
        <div className="text-xs text-gray-500">by spend</div>
      </div>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 72, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} horizontal={false} />
          <XAxis
            type="number"
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            domain={[0, Math.ceil(maxUsd * 1.15 * 100) / 100]}
            tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
          />
          <YAxis
            type="category"
            dataKey="agent"
            tick={{ ...AXIS_TICK, fontFamily: 'ui-monospace, monospace', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={140}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
            cursor={tooltipCursor}
            formatter={(v, name) =>
              name === 'Spend' ? `$${Number(v).toFixed(4)}` : Number(v).toLocaleString()
            }
          />
          <Bar dataKey="usd" name="Spend" fill={CHART_COLORS.spend} radius={[0, 6, 6, 0]} maxBarSize={26} isAnimationActive={false}>
            <LabelList
              dataKey="usd"
              position="right"
              formatter={(v: unknown) => `$${Number(v).toFixed(4)}`}
              style={{ fill: '#374151', fontSize: 11, fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <table className="w-full text-xs mt-3">
        <thead className="text-gray-500">
          <tr>
            <th className="text-left p-1">Agent</th>
            <th className="text-right p-1">Spend</th>
            <th className="text-right p-1">Events</th>
            <th className="text-right p-1">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {chartData.map((a) => (
            <tr key={a.agent} className="border-t">
              <td className="p-1 font-mono">{a.agent}</td>
              <td className="p-1 text-right font-mono">${a.usd.toFixed(4)}</td>
              <td className="p-1 text-right text-gray-500">{a.events}</td>
              <td className="p-1 text-right text-gray-500">{a.tokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ContainersCard({
  containers,
}: {
  containers: Array<{ name: string; image: string; state: string; status: string }>
}) {
  return (
    <div className="glass-card p-6">
      <h3 className="text-base font-semibold mb-3">Docker containers</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="p-1">Name</th>
            <th className="p-1">Image</th>
            <th className="p-1">State</th>
            <th className="p-1">Status</th>
          </tr>
        </thead>
        <tbody>
          {containers.map((c) => (
            <tr key={c.name} className="border-t">
              <td className="p-1 font-mono">{c.name}</td>
              <td className="p-1 text-gray-500 truncate max-w-xs">{c.image}</td>
              <td className="p-1">
                <span
                  className={
                    c.state === 'running'
                      ? 'text-green-600'
                      : c.state === 'exited'
                        ? 'text-red-600'
                        : 'text-gray-500'
                  }
                >
                  {c.state}
                </span>
              </td>
              <td className="p-1 text-gray-500">{c.status}</td>
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
