import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  adminListTenants,
  adminSetCouponDisabled,
  getAdminOverview,
  getAdminAgentDetail,
  getAdminLlmAnalytics,
  getAdminVmStats,
  type AdminLlmAnalytics,
  deleteAgent,
  rotateMeterKey,
  setAgentModel,
  setUserRole,
  type AdminCouponRedemptionRow,
  type AdminCouponRow,
  type AdminTenantRow,
  type AgentModel,
} from '../lib/api'
import type {
  AdminOverview,
  AdminAgentRow,
  AdminUserRow,
  AdminAgentDetail,
  UsageEvent,
} from '../lib/types'
import { useI18n } from '../lib/i18n'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { DeleteAgentModal } from '../components/DeleteAgentModal'
import { SwitchModelModal } from '../components/SwitchModelModal'
import { MoreVerticalIcon } from '../components/icons'

type AdminTab = 'agents' | 'users' | 'plans' | 'coupons' | 'tenants' | 'stats'
const VALID_TABS: readonly AdminTab[] = ['agents', 'users', 'plans', 'coupons', 'tenants', 'stats']

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

// Chat model choices for the admin dropdown. Keep in lockstep with the
// four other places the allowlist lives:
//   app/api/routes/admin.py             _ALLOWED_MODELS
//   agent-config/ops/create-agent.sh    --model case/esac
//   agent-config/ops/provision-api.py   ALLOWED_MODELS
//   agent-config/openclaw/openclaw.json agents.defaults.models + providers catalog
// A divergence at any one point creates silent drift bugs.
const MODEL_OPTIONS: ReadonlyArray<{ value: AgentModel; label: string; hint?: string }> = [
  {
    value: 'google/gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    hint: 'default, proven on Nylas 2-phase flow',
  },
  {
    value: 'metered-openrouter/google/gemma-4-31b-it',
    label: 'Gemma 4 31B (OpenRouter)',
    hint: 'cheaper, production quotas via OpenRouter → DeepInfra',
  },
  {
    value: 'google/gemma-4-31b-it',
    label: 'Gemma 4 31B (AI Studio)',
    hint: '30 RPM cap on AI Studio free tier — unusable for prod',
  },
]

function fmtModel(model: string | null | undefined): string {
  if (!model) return 'Flash (default)'
  const opt = MODEL_OPTIONS.find((o) => o.value === model)
  return opt ? opt.label : model
}

export default function AdminPage() {
  const { t } = useI18n()
  useDocumentTitle(t({ he: 'ניהול', en: 'Admin' }))
  const [loading, setLoading] = useState(true)
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [agentDetail, setAgentDetail] = useState<AdminAgentDetail | null>(null)
  const [tab, setTab] = useState<AdminTab>(readTabFromUrl)
  // Delete-agent modal state. Superadmin-scoped: a single agent at a time,
  // confirmed via the shared DeleteAgentModal (same UX tenant admins see on
  // their own /tenants/{id} page).
  const [deletingAgent, setDeletingAgent] = useState<{
    agent_id: string
    agent_name: string | null
    tenant_id: number
  } | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Model-switch modal state. Intentionally separate from delete state so
  // a stale modal close doesn't cross-talk. The dropdown's onChange sets
  // this; the modal's Confirm button runs the API call.
  const [switchingModel, setSwitchingModel] = useState<{
    agent_id: string
    agent_name: string | null
    from: string | null
    to: AgentModel
  } | null>(null)
  const [switchInProgress, setSwitchInProgress] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)

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

  // Two-step delete: click button → open modal (this handler). The modal's
  // Confirm button calls handleConfirmDeleteAgent below. This keeps the
  // single-responsibility shape of the tenant-side flow and avoids the
  // native prompt()/alert() chrome in the admin panel.
  //
  // Reuses DELETE /api/tenants/{tid}/agents/{aid} via the superadmin
  // role-hierarchy bypass in get_active_tenant_member — no dedicated
  // admin endpoint needed.
  function handleDeleteAgent(
    agentId: string,
    tenantId: number | null,
    agentName: string | null,
  ) {
    if (tenantId == null) {
      // Legacy rows predating the tenants migration — no clean delete
      // path from the admin panel. Inline alert is acceptable here since
      // the modal would be misleading (would suggest we can delete when
      // we can't).
      alert(
        `Cannot delete "${agentId}" from the admin panel — this agent has ` +
          `no tenant_id (legacy row). SSH to the VM and run ` +
          `/opt/agentleh/delete-agent.sh manually.`,
      )
      return
    }
    setDeletingAgent({ agent_id: agentId, agent_name: agentName, tenant_id: tenantId })
    setDeleteError(null)
  }

  async function handleConfirmDeleteAgent() {
    if (!deletingAgent) return
    setDeleteInProgress(true)
    setDeleteError(null)
    try {
      await deleteAgent(deletingAgent.tenant_id, deletingAgent.agent_id)
      setDeletingAgent(null)
      await reload()
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeleteInProgress(false)
    }
  }

  // Two-step switch: dropdown onChange → open modal (this handler). The
  // modal's Confirm button calls handleConfirmSwitchModel below. Same
  // pattern as delete; keeps the native chrome out of the admin panel.
  function handleSwitchModel(
    agentId: string,
    currentModel: string | null,
    newModel: AgentModel,
  ) {
    if ((currentModel ?? 'google/gemini-3-flash-preview') === newModel) {
      return // no-op — already there
    }
    const agent = overview?.agents.find((a) => a.agent_id === agentId) ?? null
    setSwitchingModel({
      agent_id: agentId,
      agent_name: agent?.agent_name ?? null,
      from: currentModel,
      to: newModel,
    })
    setSwitchError(null)
  }

  async function handleConfirmSwitchModel() {
    if (!switchingModel) return
    setSwitchInProgress(true)
    setSwitchError(null)
    try {
      await setAgentModel(switchingModel.agent_id, switchingModel.to)
      setSwitchingModel(null)
      await reload()
    } catch (e) {
      setSwitchError((e as Error).message)
    } finally {
      setSwitchInProgress(false)
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
      <div className="p-8 text-text-muted">
        {t({ he: 'טוען את לוח הבקרה…', en: 'Loading admin panel…' })}
      </div>
    )
  }

  if (error && !overview) {
    return (
      <div className="p-8 text-danger">
        {t({ he: 'שגיאה', en: 'Error' })}: {error}
        {error.includes('superadmin_required') && (
          <div className="mt-4 text-text-primary">
            {t({
              he: 'נדרש role=',
              en: 'You need ',
            })}
            <code>role='superadmin'</code>
            {t({
              he: ' ברשומת app_users כדי לגשת לדף הזה.',
              en: ' on your app_users row to access this page.',
            })}
          </div>
        )}
      </div>
    )
  }

  if (!overview) return null

  // Bilingual labels for the top-level tabs. The inner tab contents
  // (Agents table, Coupons CRUD, Stats charts) stay in their current
  // mix of Hebrew + English — they're dense superadmin tools with many
  // column headers and the translation ROI doesn't justify the churn.
  const tabLabels: Record<AdminTab, { he: string; en: string }> = {
    agents: { he: 'סוכנים', en: 'Agents' },
    users: { he: 'משתמשים', en: 'Users' },
    plans: { he: 'תוכניות', en: 'Plans' },
    coupons: { he: 'קופונים', en: 'Coupons' },
    tenants: { he: 'סביבות עבודה', en: 'Tenants' },
    stats: { he: 'סטטיסטיקות', en: 'Stats' },
  }

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[clamp(22px,5.5vw,30px)] font-bold">
          {t({ he: 'ניהול', en: 'Admin' })}
        </h1>
        <button
          onClick={reload}
          className="btn-secondary btn-sm shrink-0"
        >
          {t({ he: 'רענון', en: 'Refresh' })}
        </button>
      </div>

      <div className="flex gap-1 sm:gap-2 border-b overflow-x-auto snap-x snap-mandatory scrollbar-hide -mx-4 px-4 sm:mx-0 sm:px-0">
        {(['agents', 'users', 'plans', 'coupons', 'tenants'] as const).map((name) => {
          // Coupons + tenants load on tab mount via their own components,
          // so the parent overview doesn't carry counts for them.
          const count =
            name === 'coupons' || name === 'tenants'
              ? null
              : (overview[name] as unknown[]).length
          return (
            <button
              key={name}
              onClick={() => setTab(name)}
              className={`snap-start shrink-0 px-4 py-3 min-h-[44px] whitespace-nowrap text-sm ${
                tab === name
                  ? 'border-b-2 border-blue-600 text-info font-semibold'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {t(tabLabels[name])}{count !== null ? ` (${count})` : ''}
            </button>
          )
        })}
        <button
          onClick={() => setTab('stats')}
          className={`snap-start shrink-0 px-4 py-3 min-h-[44px] whitespace-nowrap text-sm ${
            tab === 'stats'
              ? 'border-b-2 border-blue-600 text-info font-semibold'
              : 'text-text-muted hover:text-text-primary'
          }`}
        >
          {t({ he: 'סטטיסטיקות (לחנונים)', en: 'Stats (for nerds)' })}
        </button>
      </div>

      {tab === 'agents' && (
        <AgentsTab
          agents={overview.agents}
          plans={overview.plans}
          onSelect={setSelectedAgentId}
          onRotateKey={handleRotateKey}
          onSwitchModel={handleSwitchModel}
          onDelete={handleDeleteAgent}
          onGranted={reload}
        />
      )}

      {tab === 'users' && (
        <UsersTab users={overview.users} onPromote={handlePromote} />
      )}

      {tab === 'plans' && <PlansTab plans={overview.plans} />}

      {tab === 'coupons' && <CouponsTab plans={overview.plans} />}

      {tab === 'tenants' && <TenantsTab />}

      {tab === 'stats' && <StatsTab />}

      {selectedAgentId && (
        <AgentDetailModal
          detail={agentDetail}
          onClose={() => setSelectedAgentId(null)}
        />
      )}

      {switchingModel && (
        <SwitchModelModal
          agentId={switchingModel.agent_id}
          agentName={switchingModel.agent_name || switchingModel.agent_id}
          fromLabel={fmtModel(switchingModel.from)}
          toLabel={fmtModel(switchingModel.to)}
          inProgress={switchInProgress}
          error={switchError}
          onConfirm={handleConfirmSwitchModel}
          onCancel={() => {
            setSwitchingModel(null)
            setSwitchError(null)
          }}
        />
      )}

      {deletingAgent && (
        <DeleteAgentModal
          agentId={deletingAgent.agent_id}
          agentName={deletingAgent.agent_name || deletingAgent.agent_id}
          inProgress={deleteInProgress}
          error={deleteError}
          onConfirm={handleConfirmDeleteAgent}
          onCancel={() => {
            setDeletingAgent(null)
            setDeleteError(null)
          }}
          // Superadmin-specific banner — emphasize this is a cross-tenant
          // action so the operator doesn't delete by muscle memory.
          extraWarning={{
            he: 'פעולת סופר־אדמין: הסוכן שייך ללקוח אחר. וודא שזה המכוון.',
            en: 'Superadmin action: this agent belongs to a customer tenant. Confirm this is intentional.',
          }}
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
  onSwitchModel,
  onDelete,
  onGranted,
}: {
  agents: AdminAgentRow[]
  plans: AdminOverview['plans']
  onSelect: (id: string) => void
  onRotateKey: (id: string) => void
  onSwitchModel: (id: string, current: string | null, next: AgentModel) => void
  onDelete: (id: string, tenantId: number | null, agentName: string | null) => void
  onGranted: () => void
}) {
  const [grantTenantId, setGrantTenantId] = useState<number | null>(null)

  return (
    <div className="glass-card">
      {/* Mobile: stacked cards, one per agent. Matches the desktop
          information hierarchy (identity → owner → plan/model → usage
          → status → actions) but stacks vertically for touch targets. */}
      <ul className="md:hidden divide-y divide-border-light">
        {agents.map((a) => {
          const cap = (a.base_allowance_micros || 0) + (a.overage_cap_micros || 0)
          return (
            <li key={a.agent_id} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <AgentIdentity agentId={a.agent_id} agentName={a.agent_name} />
                <div className="flex items-center gap-1 shrink-0">
                  <StatusPill label={a.subscription_status || 'none'} tone={subscriptionTone(a.subscription_status)} />
                  <RowActionsMenu
                    agent={a}
                    onSelect={onSelect}
                    onRotateKey={onRotateKey}
                    onGrantPlan={() => a.tenant_id != null && setGrantTenantId(a.tenant_id)}
                    onDelete={onDelete}
                  />
                </div>
              </div>

              <div className="text-xs text-text-secondary truncate">
                <bdi>{a.user_email || <span className="text-text-muted">—</span>}</bdi>
                {a.created_by_email && a.created_by_email !== a.user_email && (
                  <span className="text-text-muted">
                    {' '}· created by <bdi>{a.created_by_email}</bdi>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <PlanPill name={a.plan_name_he} />
                <ModelSelect
                  agent={a}
                  onSwitchModel={onSwitchModel}
                  className="flex-1 min-w-[140px]"
                />
              </div>

              <UsageCell used={a.agent_used_micros} cap={cap} />
            </li>
          )
        })}
        {agents.length === 0 && (
          <li className="p-6 text-center text-sm text-text-muted">No agents yet.</li>
        )}
      </ul>

      {/* Desktop: 6-column table. Was 10 columns; consolidated:
          - Tenant owner + Created by → single Owner cell (creator shown
            only when it differs from the tenant owner)
          - Used / Cap / % → single Usage cell with inline progress bar
          - Four stacked action buttons → one kebab menu
          This fits comfortably on a laptop without horizontal scroll. */}
      <div className="hidden md:block admin-table-wrap">
        <table className="w-full text-sm">
          <thead className="bg-surface-soft text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th className="text-start px-4 py-3 font-medium">Agent</th>
              <th className="text-start px-4 py-3 font-medium">Owner</th>
              <th className="text-start px-4 py-3 font-medium">Plan</th>
              <th className="text-start px-4 py-3 font-medium">Model</th>
              <th className="text-start px-4 py-3 font-medium">Usage</th>
              <th className="text-start px-4 py-3 font-medium">Status</th>
              <th className="w-10 px-2 py-3" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const cap = (a.base_allowance_micros || 0) + (a.overage_cap_micros || 0)
              return (
                <tr key={a.agent_id} className="border-t border-border-light hover:bg-surface-soft/60 align-middle">
                  <td className="px-4 py-3">
                    <AgentIdentity agentId={a.agent_id} agentName={a.agent_name} />
                  </td>
                  <td className="px-4 py-3 min-w-0">
                    <div className="text-sm text-text-primary truncate max-w-[220px]" title={a.user_email || ''}>
                      <bdi>{a.user_email || <span className="text-text-muted">—</span>}</bdi>
                    </div>
                    {a.created_by_email && a.created_by_email !== a.user_email && (
                      <div
                        className="text-xs text-text-muted truncate max-w-[220px]"
                        title={`Provisioned by ${a.created_by_email}`}
                      >
                        via <bdi>{a.created_by_email}</bdi>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <PlanPill name={a.plan_name_he} />
                  </td>
                  <td className="px-4 py-3">
                    <ModelSelect agent={a} onSwitchModel={onSwitchModel} />
                  </td>
                  <td className="px-4 py-3 min-w-[200px]">
                    <UsageCell used={a.agent_used_micros} cap={cap} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill label={a.subscription_status || 'none'} tone={subscriptionTone(a.subscription_status)} />
                  </td>
                  <td className="px-2 py-3">
                    <RowActionsMenu
                      agent={a}
                      onSelect={onSelect}
                      onRotateKey={onRotateKey}
                      onGrantPlan={() => a.tenant_id != null && setGrantTenantId(a.tenant_id)}
                      onDelete={onDelete}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

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

// ─── AgentsTab sub-components ─────────────────────────────────────────
// These exist only to keep the AgentsTab row shape readable. They carry
// no state beyond their own menu-open flag (RowActionsMenu), and take
// plain props so the render logic stays trivial to follow.

function AgentIdentity({
  agentId,
  agentName,
}: {
  agentId: string
  agentName: string | null
}) {
  return (
    <div className="min-w-0 max-w-[200px]">
      <div
        className="font-mono text-xs text-text-primary truncate"
        title={agentId}
      >
        {agentId}
      </div>
      {agentName && (
        <div
          className="text-xs text-text-muted truncate mt-0.5"
          title={agentName}
        >
          <bdi>{agentName}</bdi>
        </div>
      )}
    </div>
  )
}

function PlanPill({ name }: { name: string | null }) {
  if (!name) return <span className="text-text-muted text-sm">—</span>
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-brand/10 text-brand text-xs font-medium whitespace-nowrap">
      <bdi>{name}</bdi>
    </span>
  )
}

type Tone = 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'muted'

function tonedClasses(tone: Tone): { dot: string; text: string; bg: string } {
  switch (tone) {
    case 'success':
      return { dot: 'bg-success', text: 'text-success', bg: 'bg-success/10' }
    case 'danger':
      return { dot: 'bg-danger', text: 'text-danger', bg: 'bg-danger/10' }
    case 'warning':
      return { dot: 'bg-warning', text: 'text-warning', bg: 'bg-warning/10' }
    case 'info':
      return { dot: 'bg-info', text: 'text-info', bg: 'bg-info/10' }
    case 'neutral':
      return { dot: 'bg-text-secondary', text: 'text-text-secondary', bg: 'bg-text-secondary/10' }
    case 'muted':
    default:
      return { dot: 'bg-text-muted', text: 'text-text-muted', bg: 'bg-surface-soft' }
  }
}

/** Dot + label. For state ("active", "expired", "complete"…). */
function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  const c = tonedClasses(tone)
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap">
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} aria-hidden="true" />
      <span className={c.text}>{label}</span>
    </span>
  )
}

/** Solid tinted pill. For categorical values ("business plan", "admin role"). */
function TonedPill({
  label,
  tone,
  title,
}: {
  label: string
  tone: Tone
  title?: string
}) {
  const c = tonedClasses(tone)
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${c.bg} ${c.text}`}
      title={title}
    >
      <bdi>{label}</bdi>
    </span>
  )
}

function subscriptionTone(s: string | null): Tone {
  if (s === 'active') return 'success'
  if (s === 'exhausted') return 'danger'
  if (s === 'paused') return 'warning'
  return 'muted'
}

function couponStatusTone(s: string): Tone {
  if (s === 'active') return 'success'
  if (s === 'expired') return 'danger'
  if (s === 'exhausted') return 'warning'
  if (s === 'pending') return 'info'
  return 'muted'
}

function onboardingTone(s: string): Tone {
  if (s === 'complete') return 'success'
  if (s === 'plan_active') return 'info'
  if (s === 'pending') return 'warning'
  return 'muted'
}

function roleTone(r: string): Tone {
  if (r === 'superadmin') return 'info'
  if (r === 'admin') return 'neutral'
  return 'muted'
}

function ModelSelect({
  agent,
  onSwitchModel,
  className = '',
}: {
  agent: AdminAgentRow
  onSwitchModel: (id: string, current: string | null, next: AgentModel) => void
  className?: string
}) {
  const isDefault = agent.model == null
  return (
    <select
      value={agent.model ?? 'google/gemini-3-flash-preview'}
      onChange={(e) =>
        onSwitchModel(agent.agent_id, agent.model, e.target.value as AgentModel)
      }
      className={`text-xs bg-surface border border-border rounded-md px-2 py-1 ${
        isDefault ? 'italic text-text-secondary' : ''
      } ${className}`}
      title={isDefault ? 'Inherits system default' : undefined}
      aria-label={`Chat model for ${agent.agent_id}`}
    >
      {MODEL_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}

function UsageCell({ used, cap }: { used: number | null; cap: number }) {
  const pctNum =
    used != null && cap > 0 ? Math.min(100, (used / cap) * 100) : 0
  const barColor =
    pctNum >= 90 ? 'bg-danger' : pctNum >= 70 ? 'bg-warning' : 'bg-brand'
  const pctColor =
    pctNum >= 90 ? 'text-danger' : pctNum >= 70 ? 'text-warning' : 'text-text-secondary'

  return (
    <div className="min-w-[160px]">
      <div className="flex items-baseline justify-between gap-2 tabular-nums">
        <span className="font-mono text-xs text-text-primary">
          {fmtUsd(used)}
          <span className="text-text-muted"> / {fmtUsd(cap || null)}</span>
        </span>
        <span className={`text-xs font-medium ${pctColor}`}>
          {pct(used, cap || null)}
        </span>
      </div>
      {cap > 0 && (
        <div className="mt-1.5 h-1 rounded-full bg-surface-soft dark:bg-white/10 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${pctNum}%` }}
            role="progressbar"
            aria-valuenow={Math.round(pctNum)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      )}
    </div>
  )
}

function RowActionsMenu({
  agent,
  onSelect,
  onRotateKey,
  onGrantPlan,
  onDelete,
}: {
  agent: AdminAgentRow
  onSelect: (id: string) => void
  onRotateKey: (id: string) => void
  onGrantPlan: () => void
  onDelete: (id: string, tenantId: number | null, agentName: string | null) => void
}) {
  const { dir } = useI18n()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null)

  // The menu renders through a portal to document.body so it can escape
  // the table's `overflow-x: auto` clipping. Position is computed from
  // the trigger's bounding rect on open, then pinned via `position: fixed`.
  // Scroll / resize close it — a floating menu that drifts away from its
  // anchor is worse than one that closes.
  useLayoutEffect(() => {
    if (!open) return
    const btn = buttonRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    setPos({
      top: rect.bottom + 4,
      ...(dir === 'rtl'
        ? { left: rect.left }
        : { right: window.innerWidth - rect.right }),
    })
  }, [open, dir])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        buttonRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return
      }
      setOpen(false)
    }
    const onScrollOrResize = () => setOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    // Capture phase: catches scroll inside the table wrap too.
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open])

  const deletable = agent.tenant_id != null

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 inline-flex items-center justify-center rounded-full text-text-secondary hover:bg-surface-soft hover:text-text-primary cursor-pointer"
        aria-label={`Actions for ${agent.agent_id}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVerticalIcon className="w-[18px] h-[18px]" />
      </button>

      {open && pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed w-44 bg-surface rounded-lg shadow-[0_8px_32px_rgb(14_19_32/0.18)] border border-border z-50 overflow-hidden"
            style={pos}
            role="menu"
          >
            <MenuItem
              onClick={() => {
                setOpen(false)
                onSelect(agent.agent_id)
              }}
            >
              Details
            </MenuItem>
            <MenuItem
              onClick={() => {
                setOpen(false)
                onRotateKey(agent.agent_id)
              }}
            >
              Rotate key
            </MenuItem>
            {agent.tenant_id != null && (
              <MenuItem
                onClick={() => {
                  setOpen(false)
                  onGrantPlan()
                }}
              >
                Grant plan
              </MenuItem>
            )}
            <div className="border-t border-border-light" />
            <MenuItem
              onClick={() => {
                setOpen(false)
                onDelete(agent.agent_id, agent.tenant_id, agent.agent_name)
              }}
              disabled={!deletable}
              danger
              title={
                deletable
                  ? undefined
                  : 'Legacy row without tenant_id — delete via VM CLI'
              }
            >
              Delete
            </MenuItem>
          </div>,
          document.body,
        )}
    </>
  )
}

function MenuItem({
  children,
  onClick,
  disabled = false,
  danger = false,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  title?: string
}) {
  const base =
    'w-full text-start px-3 py-2 text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed'
  const variant = danger
    ? 'text-danger hover:bg-danger/10'
    : 'text-text-primary hover:bg-surface-soft'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      role="menuitem"
      className={`${base} ${variant}`}
    >
      {children}
    </button>
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
      <div className="bg-surface rounded-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">Grant plan to tenant {tenantId}</h3>
          <button onClick={onClose} className="text-text-muted text-2xl">×</button>
        </div>
        <div className="space-y-3">
          <label className="block">
            <div className="text-xs font-semibold mb-1">Plan</div>
            <select value={planId} onChange={(e) => setPlanId(e.target.value)} className="input-glass w-full px-3 py-2.5 text-sm appearance-none">
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
              className="input-glass w-full px-3 py-2.5 text-sm"
            />
          </label>
          <p className="text-xs text-text-muted">
            Logged as an admin grant (coupon_id=NULL, granted_by_admin=you). Same supersession rules
            as a coupon: upgrades take effect immediately, downgrades and same-plan renewals queue
            at the current period end.
          </p>
          {error && <div className="text-sm text-danger dark:text-red-300 bg-danger-light rounded-lg p-2">{error}</div>}
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

  if (loading) return <div className="p-6 text-text-muted">Loading coupons…</div>

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

      {error && <div className="p-3 bg-danger-light text-danger dark:text-red-300 rounded-lg text-sm">{error}</div>}

      <div className="glass-card">
        {/* Mobile: stacked cards, mirrors desktop row shape. */}
        <ul className="md:hidden divide-y divide-border-light">
          {coupons.map((c) => {
            const status = couponStatus(c)
            return (
              <li key={c.id} className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <code className="font-mono text-sm text-text-primary break-all">{c.code}</code>
                    {c.notes && (
                      <div className="text-xs text-text-muted mt-0.5 truncate" title={c.notes}>
                        {c.notes}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <StatusPill label={status} tone={couponStatusTone(status)} />
                    <CouponRowActionsMenu
                      coupon={c}
                      onOpenRedemptions={() => setOpenRedemptionsFor(c)}
                      onToggle={() => handleToggle(c)}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <TonedPill
                    label={c.plan_name_he || c.plan_id}
                    tone="info"
                    title={c.plan_id}
                  />
                  <span className="text-xs text-text-muted">
                    {c.duration_days} days · {c.redemption_count}/{c.max_redemptions ?? '∞'} used
                  </span>
                </div>
                <div className="text-xs text-text-muted" dir="ltr">
                  Valid until{' '}
                  {c.valid_until ? new Date(c.valid_until).toLocaleDateString('en-GB') : '—'}
                </div>
              </li>
            )
          })}
          {coupons.length === 0 && (
            <li className="p-6 text-center text-sm text-text-muted">
              No coupons yet — tap "New coupon" to mint one.
            </li>
          )}
        </ul>

        {/* Desktop: 7-column table. Was 8 (Notes merged into Code cell). */}
        <div className="hidden md:block admin-table-wrap">
          <table className="w-full text-sm">
            <thead className="bg-surface-soft text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th className="text-start px-4 py-3 font-medium">Code</th>
                <th className="text-start px-4 py-3 font-medium">Plan</th>
                <th className="text-end px-4 py-3 font-medium">Days</th>
                <th className="text-end px-4 py-3 font-medium">Used / Cap</th>
                <th className="text-start px-4 py-3 font-medium">Status</th>
                <th className="text-start px-4 py-3 font-medium">Valid until</th>
                <th className="w-10 px-2 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {coupons.map((c) => {
                const status = couponStatus(c)
                return (
                  <tr key={c.id} className="border-t border-border-light hover:bg-surface-soft/60 align-middle">
                    <td className="px-4 py-3 min-w-0">
                      <code className="font-mono text-xs text-text-primary">{c.code}</code>
                      {c.notes && (
                        <div
                          className="text-xs text-text-muted truncate max-w-[240px] mt-0.5"
                          title={c.notes}
                        >
                          {c.notes}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <TonedPill
                        label={c.plan_name_he || c.plan_id}
                        tone="info"
                        title={c.plan_id}
                      />
                    </td>
                    <td className="px-4 py-3 text-end tabular-nums font-mono text-xs">
                      {c.duration_days}
                    </td>
                    <td className="px-4 py-3 text-end tabular-nums font-mono text-xs">
                      {c.redemption_count}
                      <span className="text-text-muted">/{c.max_redemptions ?? '∞'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill label={status} tone={couponStatusTone(status)} />
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted tabular-nums" dir="ltr">
                      {c.valid_until ? new Date(c.valid_until).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="px-2 py-3">
                      <CouponRowActionsMenu
                        coupon={c}
                        onOpenRedemptions={() => setOpenRedemptionsFor(c)}
                        onToggle={() => handleToggle(c)}
                      />
                    </td>
                  </tr>
                )
              })}
              {coupons.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-text-muted">
                    No coupons yet — click "New coupon" to mint one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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

function CouponRowActionsMenu({
  coupon,
  onOpenRedemptions,
  onToggle,
}: {
  coupon: AdminCouponRow
  onOpenRedemptions: () => void
  onToggle: () => void
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { dir } = useI18n()
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const btn = buttonRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    setPos({
      top: rect.bottom + 4,
      ...(dir === 'rtl'
        ? { left: rect.left }
        : { right: window.innerWidth - rect.right }),
    })
  }, [open, dir])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScrollOrResize = () => setOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open])

  const isDisabled = !!coupon.disabled_at

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 inline-flex items-center justify-center rounded-full text-text-secondary hover:bg-surface-soft hover:text-text-primary cursor-pointer"
        aria-label={`Actions for coupon ${coupon.code}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVerticalIcon className="w-[18px] h-[18px]" />
      </button>

      {open && pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed w-44 bg-surface rounded-lg shadow-[0_8px_32px_rgb(14_19_32/0.18)] border border-border z-50 overflow-hidden"
            style={pos}
            role="menu"
          >
            <MenuItem
              onClick={() => {
                setOpen(false)
                onOpenRedemptions()
              }}
            >
              View redemptions
            </MenuItem>
            <div className="border-t border-border-light" />
            <MenuItem
              onClick={() => {
                setOpen(false)
                onToggle()
              }}
              danger={!isDisabled}
            >
              {isDisabled ? 'Re-enable' : 'Disable'}
            </MenuItem>
          </div>,
          document.body,
        )}
    </>
  )
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
            <code className="font-mono bg-success-light text-success dark:text-green-300 px-2 py-1 rounded">
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
                className="input-glass w-full px-3 py-2.5 text-sm font-mono uppercase"
              />
            </label>
            <label className="block">
              <div className="text-xs font-semibold mb-1">Plan</div>
              <select value={planId} onChange={(e) => setPlanId(e.target.value)} className="input-glass w-full px-3 py-2.5 text-sm appearance-none">
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
                className="input-glass w-full px-3 py-2.5 text-sm"
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
                className="input-glass w-full px-3 py-2.5 text-sm"
              />
            </label>
            <label className="block">
              <div className="text-xs font-semibold mb-1">Valid until</div>
              <input
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
                className="input-glass w-full px-3 py-2.5 text-sm"
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
              className="input-glass w-full px-3 py-2.5 text-sm"
              placeholder="Internal note — who/why this coupon was created"
            />
          </label>
          {error && <div className="text-sm text-danger dark:text-red-300 bg-danger-light rounded-lg p-2">{error}</div>}
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
        className="bg-surface rounded-xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">
            Redemptions — <code className="font-mono text-base">{coupon.code}</code>
          </h3>
          <button onClick={onClose} className="text-text-muted text-2xl">×</button>
        </div>
        {loading ? (
          <div className="text-text-muted">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-text-muted">No redemptions yet.</div>
        ) : (
          <div className="admin-table-wrap">
            <table className="w-full text-sm">
              <thead className="bg-surface-soft">
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
                    <td className="p-2 text-xs text-text-muted">
                      {new Date(r.period_start).toLocaleDateString('en-GB')} →{' '}
                      {new Date(r.period_end).toLocaleDateString('en-GB')}
                    </td>
                    <td className="p-2 text-xs text-text-muted">
                      {new Date(r.redeemed_at).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
    <div className="glass-card admin-table-wrap">
      <table className="w-full text-sm">
        <thead className="bg-surface-soft text-xs uppercase tracking-wide text-text-muted">
          <tr>
            <th className="text-start px-4 py-3 font-medium">User</th>
            <th className="text-start px-4 py-3 font-medium">Role</th>
            <th className="text-start px-4 py-3 font-medium">Status</th>
            <th className="text-end px-4 py-3 font-medium">Agents</th>
            <th className="text-start px-4 py-3 font-medium">Joined</th>
            <th className="w-10 px-2 py-3" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-t border-border-light hover:bg-surface-soft/60 align-middle">
              <td className="px-4 py-3 min-w-0">
                <div className="font-medium text-text-primary truncate max-w-[260px]" title={u.full_name || u.email}>
                  {u.full_name || u.email}
                </div>
                {u.full_name && (
                  <div className="text-xs text-text-muted truncate max-w-[260px]" title={u.email}>
                    {u.email}
                  </div>
                )}
              </td>
              <td className="px-4 py-3">
                <TonedPill label={u.role} tone={roleTone(u.role)} />
              </td>
              <td className="px-4 py-3">
                <StatusPill label={u.onboarding_status} tone={onboardingTone(u.onboarding_status)} />
              </td>
              <td className="px-4 py-3 text-end tabular-nums font-mono text-xs">
                {u.agent_count}
              </td>
              <td className="px-4 py-3 text-xs text-text-muted tabular-nums" dir="ltr">
                {fmtDate(u.created_at)}
              </td>
              <td className="px-2 py-3">
                <UserRowActionsMenu user={u} onPromote={onPromote} />
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-text-muted">
                No users yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function UserRowActionsMenu({
  user,
  onPromote,
}: {
  user: AdminUserRow
  onPromote: (user: AdminUserRow) => void
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { dir } = useI18n()
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const btn = buttonRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    setPos({
      top: rect.bottom + 4,
      ...(dir === 'rtl'
        ? { left: rect.left }
        : { right: window.innerWidth - rect.right }),
    })
  }, [open, dir])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScrollOrResize = () => setOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open])

  const isSuperadmin = user.role === 'superadmin'

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 inline-flex items-center justify-center rounded-full text-text-secondary hover:bg-surface-soft hover:text-text-primary cursor-pointer"
        aria-label={`Actions for ${user.email}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVerticalIcon className="w-[18px] h-[18px]" />
      </button>

      {open && pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed w-44 bg-surface rounded-lg shadow-[0_8px_32px_rgb(14_19_32/0.18)] border border-border z-50 overflow-hidden"
            style={pos}
            role="menu"
          >
            <MenuItem
              onClick={() => {
                setOpen(false)
                onPromote(user)
              }}
              danger={isSuperadmin}
            >
              {isSuperadmin ? 'Demote to user' : 'Promote to superadmin'}
            </MenuItem>
          </div>,
          document.body,
        )}
    </>
  )
}

function PlansTab({ plans }: { plans: AdminOverview['plans'] }) {
  return (
    <div className="glass-card admin-table-wrap">
      <table className="w-full text-sm">
        <thead className="bg-surface-soft text-xs uppercase tracking-wide text-text-muted">
          <tr>
            <th className="text-start px-4 py-3 font-medium">Plan</th>
            <th className="text-end px-4 py-3 font-medium">Price</th>
            <th className="text-start px-4 py-3 font-medium">Mode</th>
            <th className="text-end px-4 py-3 font-medium">Base allowance</th>
            <th className="text-end px-4 py-3 font-medium">Overage cap</th>
            <th className="text-end px-4 py-3 font-medium">RPM</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr
              key={p.plan_id}
              className="border-t border-border-light hover:bg-surface-soft/60 align-middle"
            >
              <td className="px-4 py-3">
                <div className="font-medium text-text-primary">
                  <bdi>{p.name_he}</bdi>
                </div>
                <code className="text-xs text-text-muted font-mono">
                  {p.plan_id}
                </code>
              </td>
              <td className="px-4 py-3 text-end tabular-nums">
                <span className="font-mono text-xs">
                  ₪{(p.price_ils_cents / 100).toFixed(0)}
                </span>
              </td>
              <td className="px-4 py-3">
                <TonedPill
                  label={billingModeLabel(p.billing_mode)}
                  tone={billingModeTone(p.billing_mode)}
                  title={p.billing_mode}
                />
              </td>
              <td className="px-4 py-3 text-end font-mono text-xs tabular-nums">
                {fmtUsd(p.base_allowance_micros)}
              </td>
              <td className="px-4 py-3 text-end font-mono text-xs tabular-nums">
                {p.default_overage_cap_micros && p.default_overage_cap_micros > 0
                  ? fmtUsd(p.default_overage_cap_micros)
                  : <span className="text-text-muted">—</span>}
              </td>
              <td className="px-4 py-3 text-end font-mono text-xs tabular-nums">
                {p.rate_limit_rpm}
              </td>
            </tr>
          ))}
          {plans.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-text-muted">
                No plans configured.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function billingModeLabel(mode: string): string {
  if (mode === 'plan_hardblock') return 'hard block'
  if (mode === 'plan_overage') return 'overage'
  if (mode === 'wallet') return 'wallet'
  return mode
}

function billingModeTone(mode: string): Tone {
  if (mode === 'plan_hardblock') return 'warning'
  if (mode === 'plan_overage') return 'success'
  if (mode === 'wallet') return 'info'
  return 'muted'
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
  capacity: {
    agents_remaining: number
    binding_constraint: 'ram' | 'cpu' | 'boot_disk' | 'data_disk'
    per_constraint: {
      ram: number
      cpu: number
      boot_disk: number
      data_disk: number
    }
    assumptions: {
      typical_agent_mb: number
      reserved_overhead_mb: number
      safety_margin_mb: number
      load_per_agent: number
      boot_disk_agent_gb: number
      data_disk_agent_gb: number
    }
  } | null
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
    tts_requests: number
    stt_requests: number
    embedding_requests: number
    input_tokens: number
    output_tokens: number
    cached_tokens: number
    search_queries: number
    cost_micros: number
    llm_cost_micros: number
    search_cost_micros: number
    tts_cost_micros: number
    stt_cost_micros: number
    embedding_cost_micros: number
  } | null
  cost_by_kind_per_hour: Array<{
    hour: string
    llm_cost_micros: number
    search_cost_micros: number
    tts_cost_micros: number
    stt_cost_micros: number
    embedding_cost_micros: number
    llm_events: number
    search_events: number
    tts_events: number
    stt_events: number
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
    kind: 'llm' | 'search' | 'tts' | 'stt' | 'embedding'
    events: number
    cost_micros: number
    total_tokens: number
  }>
}

function StatsTab() {
  const [data, setData] = useState<VmStatsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // LLM analytics load independently so VM-side errors don't block them
  // and vice versa. Window defaults to 7 days to match the existing
  // model_breakdown_7d card.
  const [llmWindow, setLlmWindow] = useState<7 | 30 | 90>(7)
  const [llm, setLlm] = useState<AdminLlmAnalytics | null>(null)
  const [llmErr, setLlmErr] = useState<string | null>(null)

  async function load() {
    try {
      const r = await getAdminVmStats()
      setData(r)
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function loadLlm() {
    try {
      const r = await getAdminLlmAnalytics(llmWindow)
      setLlm(r)
      setLlmErr(null)
    } catch (e) {
      setLlmErr((e as Error).message)
    }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 10_000) // auto-refresh every 10s
    return () => clearInterval(id)
  }, [])

  // LLM analytics is heavier (aggregates across usage_events). Reload when
  // window changes + every 60s.
  useEffect(() => {
    loadLlm()
    const id = setInterval(loadLlm, 60_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llmWindow])

  if (err) return <div className="p-6 text-danger">Error: {err}</div>
  if (!data) return <div className="p-6 text-text-muted">Loading…</div>

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

      {/* ── LLM analytics (migration 029) ─────────────────────────── */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text-primary">LLM analytics</h2>
        <div className="flex gap-1 text-xs">
          {([7, 30, 90] as const).map((w) => (
            <button
              key={w}
              onClick={() => setLlmWindow(w)}
              className={
                llmWindow === w
                  ? 'px-2 py-1 rounded bg-brand text-white'
                  : 'px-2 py-1 rounded bg-surface-soft text-text-secondary hover:bg-surface'
              }
            >
              {w}d
            </button>
          ))}
        </div>
      </div>
      {llmErr && (
        <div className="glass-card p-4 text-sm text-danger">Analytics error: {llmErr}</div>
      )}
      {llm ? (
        <div className="space-y-4">
          <CostPerModelCard rows={llm.cost_per_model} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ThinkingBurnCard rows={llm.thinking_burn} />
            <TruncationRateCard rows={llm.truncation_rate} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ToolFrequencyCard rows={llm.tool_frequency} />
            <ErrorRateCard rows={llm.error_rate} />
          </div>
          <ConversationShapeCard shape={llm.conversation_shape} />
        </div>
      ) : (
        !llmErr && <div className="glass-card p-4 text-sm text-text-muted">Loading analytics…</div>
      )}

      <ContainersCard containers={data.live?.docker?.containers || []} />
    </div>
  )
}

// ─── LLM analytics cards ───────────────────────────────────────────────

function CostPerModelCard({ rows }: { rows: AdminLlmAnalytics['cost_per_model'] }) {
  if (!rows.length) return <EmptyCard title="Cost per model" />
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Cost per model</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-surface-soft text-text-secondary">
            <tr>
              <th className="text-left p-2">Upstream</th>
              <th className="text-left p-2">Model</th>
              <th className="text-right p-2">Calls</th>
              <th className="text-right p-2">Input tok</th>
              <th className="text-right p-2">Output tok</th>
              <th className="text-right p-2">Cached tok</th>
              <th className="text-right p-2">Avg latency</th>
              <th className="text-right p-2">$ spent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t tabular-nums">
                <td className="p-2">{r.upstream}</td>
                <td className="p-2 font-mono text-[11px]">{r.model}</td>
                <td className="p-2 text-right">{r.events}</td>
                <td className="p-2 text-right">{r.input_tokens.toLocaleString()}</td>
                <td className="p-2 text-right">{r.output_tokens.toLocaleString()}</td>
                <td className="p-2 text-right text-text-muted">{r.cached_tokens.toLocaleString()}</td>
                <td className="p-2 text-right">{r.avg_latency_ms}ms</td>
                <td className="p-2 text-right font-medium">{fmtUsd(r.cost_micros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ThinkingBurnCard({ rows }: { rows: AdminLlmAnalytics['thinking_burn'] }) {
  if (!rows.length) return <EmptyCard title="Thinking-token burn" hint="no thinking-enabled calls yet" />
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Thinking-token burn</h3>
      <p className="text-[11px] text-text-muted mb-2">
        Share of output that's hidden reasoning (Gemini thoughts / OpenAI reasoning_tokens).
      </p>
      <table className="w-full text-xs">
        <thead className="bg-surface-soft text-text-secondary">
          <tr>
            <th className="text-left p-2">Model</th>
            <th className="text-right p-2">Calls</th>
            <th className="text-right p-2">Avg thoughts</th>
            <th className="text-right p-2">Avg output</th>
            <th className="text-right p-2">% thoughts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t tabular-nums">
              <td className="p-2 font-mono text-[11px]">{r.model}</td>
              <td className="p-2 text-right">{r.events}</td>
              <td className="p-2 text-right">{r.avg_thoughts ?? '—'}</td>
              <td className="p-2 text-right">{r.avg_output ?? '—'}</td>
              <td className="p-2 text-right font-medium">
                {r.thoughts_share_pct != null ? `${r.thoughts_share_pct}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TruncationRateCard({ rows }: { rows: AdminLlmAnalytics['truncation_rate'] }) {
  if (!rows.length) return <EmptyCard title="Truncation rate" hint="no finish_reason data yet" />
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Truncation rate (finish=length)</h3>
      <p className="text-[11px] text-text-muted mb-2">
        Replies cut off by max_tokens. High % → consider bumping the model's maxTokens.
      </p>
      <table className="w-full text-xs">
        <thead className="bg-surface-soft text-text-secondary">
          <tr>
            <th className="text-left p-2">Model</th>
            <th className="text-right p-2">Total</th>
            <th className="text-right p-2">Truncated</th>
            <th className="text-right p-2">%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t tabular-nums">
              <td className="p-2 font-mono text-[11px]">{r.model}</td>
              <td className="p-2 text-right">{r.total}</td>
              <td className="p-2 text-right">{r.truncated}</td>
              <td className={`p-2 text-right font-medium ${r.pct != null && r.pct > 10 ? 'text-danger' : ''}`}>
                {r.pct != null ? `${r.pct}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ToolFrequencyCard({ rows }: { rows: AdminLlmAnalytics['tool_frequency'] }) {
  if (!rows.length) return <EmptyCard title="Tool calls" hint="no tool calls in window" />
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Top tools called</h3>
      <table className="w-full text-xs">
        <thead className="bg-surface-soft text-text-secondary">
          <tr>
            <th className="text-left p-2">Tool</th>
            <th className="text-right p-2">Calls</th>
            <th className="text-right p-2">Agents</th>
            <th className="text-right p-2">Models</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t tabular-nums">
              <td className="p-2 font-mono text-[11px]">{r.tool_name}</td>
              <td className="p-2 text-right font-medium">{r.calls}</td>
              <td className="p-2 text-right">{r.distinct_agents}</td>
              <td className="p-2 text-right">{r.distinct_models}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ErrorRateCard({ rows }: { rows: AdminLlmAnalytics['error_rate'] }) {
  if (!rows.length) return <EmptyCard title="Error rate" hint="no LLM traffic in window" />
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Error rate (HTTP ≥ 400)</h3>
      <table className="w-full text-xs">
        <thead className="bg-surface-soft text-text-secondary">
          <tr>
            <th className="text-left p-2">Upstream</th>
            <th className="text-left p-2">Model</th>
            <th className="text-right p-2">Total</th>
            <th className="text-right p-2">Errors</th>
            <th className="text-right p-2">%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t tabular-nums">
              <td className="p-2">{r.upstream}</td>
              <td className="p-2 font-mono text-[11px]">{r.model}</td>
              <td className="p-2 text-right">{r.total}</td>
              <td className="p-2 text-right">{r.errors}</td>
              <td className={`p-2 text-right font-medium ${r.pct != null && r.pct > 1 ? 'text-danger' : ''}`}>
                {r.pct != null ? `${r.pct}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ConversationShapeCard({ shape }: { shape: AdminLlmAnalytics['conversation_shape'] }) {
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-2">Conversation length</h3>
      <p className="text-[11px] text-text-muted mb-3">
        Message count per turn (includes history). Runaway p99 = expensive context that may be hurting quality.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm tabular-nums">
        <Metric label="Turns measured" value={shape.turns_measured.toLocaleString()} />
        <Metric label="p50" value={shape.p50_messages ?? '—'} />
        <Metric label="p95" value={shape.p95_messages ?? '—'} />
        <Metric label="p99" value={shape.p99_messages ?? '—'} />
        <Metric label="Max" value={shape.max_messages ?? '—'} />
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="text-lg font-semibold text-text-primary">{value}</div>
    </div>
  )
}

function EmptyCard({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-2">{title}</h3>
      <div className="text-xs text-text-muted">{hint ?? 'No data in window.'}</div>
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
        className="cursor-help opacity-60 hover:opacity-100 focus:opacity-100 focus:outline-none select-none text-text-muted text-[12px] leading-none"
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
          className={`absolute z-50 top-full mt-2 ${bubbleSide} w-64 max-w-[80vw] rounded-lg bg-text-primary text-surface text-xs font-normal normal-case leading-relaxed px-3 py-2 shadow-xl pointer-events-none`}
        >
          <span
            className={`absolute -top-1 ${arrowSide} w-2 h-2 bg-text-primary rotate-45`}
          />
          {text}
        </span>
      )}
    </span>
  )
}

function colorForPct(pct: number, yellow: number, red: number): string {
  if (pct >= red) return 'text-danger dark:text-red-400 bg-danger-light dark:bg-danger/10'
  if (pct >= yellow) return 'text-warning dark:text-yellow-400 bg-warning-light dark:bg-warning/10'
  return 'text-success dark:text-green-400 bg-success-light dark:bg-success/10'
}

function barColor(pct: number, yellow: number, red: number): string {
  if (pct >= red) return 'bg-danger'
  if (pct >= yellow) return 'bg-warning'
  return 'bg-success'
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
      <div className="w-full h-1.5 bg-black/10 dark:bg-white/10 rounded-full mt-2 overflow-hidden">
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
        <div className="text-danger">VM stats unreachable: {data.live_error}</div>
        <div className="text-xs text-text-muted mt-2">
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
          Live — <span className="font-mono text-sm text-text-secondary">{live.hostname}</span>
        </h2>
        <div className="text-xs text-text-muted">
          up {uptimeDays}d {uptimeHours}h · updates every 10s
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
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
        {data.capacity && (
          <MetricTile
            label="Agents left"
            value={data.capacity.agents_remaining}
            pct={Math.max(0, 100 - data.capacity.agents_remaining * 40)}
            yellow={55}
            red={85}
            sub={`${data.capacity.binding_constraint.replace('_', ' ')}-bound`}
            info={`How many more OpenClaw agents fit before this VM needs a resize. Min across 4 constraints — RAM (${data.capacity.per_constraint.ram}), CPU (${data.capacity.per_constraint.cpu}), boot disk (${data.capacity.per_constraint.boot_disk}), /data (${data.capacity.per_constraint.data_disk}). Assumes ~${(data.capacity.assumptions.typical_agent_mb / 1024).toFixed(1)} G RAM per typical agent plus ${(data.capacity.assumptions.reserved_overhead_mb / 1024).toFixed(1)} G fixed overhead (OS + whisper + docker). Heuristic — tune if it's ever wrong in prod.`}
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
  tts: '#f59e0b',         // amber  — voice / TTS (outgoing voice)
  stt: '#14b8a6',         // teal   — transcription / STT (incoming voice)
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
    <div className="rounded-xl p-4 bg-surface border border-border-light shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-text-muted flex items-center gap-1.5">
        <span>{label}</span>
        {info && <InfoTip text={info} />}
      </div>
      <div className="text-2xl font-bold mt-1" style={{ color: accent }}>
        {value}
      </div>
      {sub && <div className="text-xs text-text-muted mt-1">{sub}</div>}
    </div>
  )
}

function TodayUsageTotals({ totals }: { totals: VmStatsResponse['today_totals'] }) {
  if (!totals || totals.requests === 0) {
    return (
      <div className="glass-card p-6 text-sm text-text-muted">
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
        <div className="text-xs text-text-muted">via agentleh-meter</div>
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
          sub={`${fmtUsdMicros(totals.llm_cost_micros, 3)} LLM · ${fmtUsdMicros(totals.search_cost_micros, 3)} search · ${fmtUsdMicros(totals.tts_cost_micros, 3)} TTS · ${fmtUsdMicros(totals.stt_cost_micros, 3)} STT · ${fmtUsdMicros(totals.embedding_cost_micros, 3)} embed · ${llmShare}% LLM`}
          accent="#ef4444"
          info="Total cost across all agents in the last 24h, billed by the upstream (Gemini for LLM/search/embed, Cloud TTS for voice, ElevenLabs for STT) and recorded by agentleh-meter. Split by kind in the sub-line."
        />
      </div>
    </div>
  )
}

function CostByKindChart({ hours }: { hours: VmStatsResponse['cost_by_kind_per_hour'] }) {
  if (hours.length === 0) {
    return (
      <div className="glass-card p-6 text-sm text-text-muted">
        No cost data in the last 24 hours.
      </div>
    )
  }
  const data = hours.map((h) => ({
    hour: fmtHourOnly(h.hour),
    llm: Number(h.llm_cost_micros) / 1_000_000,
    search: Number(h.search_cost_micros) / 1_000_000,
    tts: Number(h.tts_cost_micros) / 1_000_000,
    stt: Number(h.stt_cost_micros) / 1_000_000,
    embedding: Number(h.embedding_cost_micros) / 1_000_000,
  }))
  const totalLlm = data.reduce((a, b) => a + b.llm, 0)
  const totalSearch = data.reduce((a, b) => a + b.search, 0)
  const totalTts = data.reduce((a, b) => a + b.tts, 0)
  const totalStt = data.reduce((a, b) => a + b.stt, 0)
  const totalEmbedding = data.reduce((a, b) => a + b.embedding, 0)
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-semibold">Cost by kind — last 24h</h3>
          <InfoTip text="Per-hour stacked cost split between LLM (chat completions, per-token), grounding search (per-query, ~$14/1k on Gemini 3), TTS (voice synthesis, per-character on Gemini-TTS), STT (voice transcription, per-second on ElevenLabs Scribe v2), and memory-search embeddings. Grounding search is usually the biggest cost lever." />
        </div>
        <div className="text-xs text-text-secondary">
          <span className="font-mono font-semibold" style={{ color: CHART_COLORS.llm }}>${totalLlm.toFixed(4)}</span>
          {' '}LLM ·{' '}
          <span className="font-mono font-semibold" style={{ color: CHART_COLORS.search }}>${totalSearch.toFixed(4)}</span>
          {' '}search ·{' '}
          <span className="font-mono font-semibold" style={{ color: CHART_COLORS.tts }}>${totalTts.toFixed(4)}</span>
          {' '}TTS ·{' '}
          <span className="font-mono font-semibold" style={{ color: CHART_COLORS.stt }}>${totalStt.toFixed(4)}</span>
          {' '}STT ·{' '}
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
          <Bar dataKey="tts" name="TTS" stackId="cost" fill={CHART_COLORS.tts} maxBarSize={48} isAnimationActive={false} />
          <Bar dataKey="stt" name="STT" stackId="cost" fill={CHART_COLORS.stt} maxBarSize={48} isAnimationActive={false} />
          <Bar dataKey="embedding" name="Embedding" stackId="cost" fill={CHART_COLORS.embedding} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function TokensThroughputChart({ hours }: { hours: VmStatsResponse['tokens_per_hour'] }) {
  if (hours.length === 0) {
    return (
      <div className="glass-card p-6 text-sm text-text-muted">
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
        <div className="text-xs text-text-secondary">
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
        <div className="text-sm text-text-muted">No model usage in the last 7 days.</div>
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
        <div className="text-xs text-text-muted">
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
                  : row.kind === 'stt' ? CHART_COLORS.stt
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
      <div className="admin-table-wrap mt-3">
      <table className="w-full text-xs">
        <thead className="text-text-muted">
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
                    background:
                      m.kind === 'search' ? '#dcfce7'
                      : m.kind === 'tts' ? '#fef3c7'
                      : m.kind === 'stt' ? '#ccfbf1'
                      : m.kind === 'embedding' ? '#fce7f3'
                      : '#dbeafe',
                    color:
                      m.kind === 'search' ? '#166534'
                      : m.kind === 'tts' ? '#92400e'
                      : m.kind === 'stt' ? '#115e59'
                      : m.kind === 'embedding' ? '#9d174d'
                      : '#1e40af',
                  }}
                >
                  {m.kind}
                </span>
              </td>
              <td className="p-1 text-right font-mono">${m.usd.toFixed(4)}</td>
              <td className="p-1 text-right text-text-muted">{m.events.toLocaleString()}</td>
              <td className="p-1 text-right text-text-muted">{m.tokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}

function HistoryCharts({ history }: { history: VmStatsResponse['history'] }) {
  if (history.length === 0) {
    return (
      <div className="glass-card p-6 text-sm text-text-muted">
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
        <span className="text-xs text-text-muted">{history.length} samples · 60s cadence</span>
      </div>
      <div className="space-y-6">
        <div>
          <div className="text-xs text-text-secondary mb-2">CPU · RAM · Disk (%)</div>
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
          <div className="text-xs text-text-secondary mb-2">Running containers (agents only)</div>
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
      <div className="glass-card p-6 text-sm text-text-muted">
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
        <div className="text-xs text-text-secondary">
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
      <div className="glass-card p-6 text-sm text-text-muted">
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
        <div className="text-xs text-text-muted">
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
        <div className="text-sm text-text-muted">No usage yet.</div>
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
        <div className="text-xs text-text-muted">by spend</div>
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
      <div className="admin-table-wrap mt-3">
      <table className="w-full text-xs">
        <thead className="text-text-muted">
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
              <td className="p-1 text-right text-text-muted">{a.events}</td>
              <td className="p-1 text-right text-text-muted">{a.tokens.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
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
      <div className="admin-table-wrap">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-text-muted">
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
              <td className="p-1 text-text-muted truncate max-w-xs">{c.image}</td>
              <td className="p-1">
                <span
                  className={
                    c.state === 'running'
                      ? 'text-success'
                      : c.state === 'exited'
                        ? 'text-danger'
                        : 'text-text-muted'
                  }
                >
                  {c.state}
                </span>
              </td>
              <td className="p-1 text-text-muted">{c.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
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
        className="bg-surface rounded-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold">Agent Detail</h2>
            <button onClick={onClose} className="text-text-muted text-2xl">
              ×
            </button>
          </div>
          {!detail ? (
            <div className="text-text-muted">Loading…</div>
          ) : (
            <>
              <div className="space-y-2 mb-4 text-sm">
                <div>
                  <strong>Agent ID:</strong>{' '}
                  <code>{detail.agent.agent_id}</code>
                </div>
                <div>
                  <strong>Tenant owner:</strong>{' '}
                  {detail.agent.user_email || '—'}
                </div>
                <div>
                  <strong>Created by:</strong>{' '}
                  {detail.agent.created_by_email || (
                    <span className="text-text-muted">— (pre-migration)</span>
                  )}
                </div>
                <div>
                  <strong>Gateway:</strong>{' '}
                  <code className="text-xs">{detail.agent.gateway_url}</code>
                </div>
              </div>

              <h3 className="font-semibold mt-4 mb-2">Recent usage events</h3>
              <div className="admin-table-wrap">
                <table className="w-full text-xs">
                  <thead className="bg-surface-soft">
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
                        <td className="p-2 text-text-muted">{fmtDate(e.ts)}</td>
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
                                ? 'text-success'
                                : 'text-danger'
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
                <div className="mt-4 p-3 bg-warning-light text-warning dark:text-yellow-300 text-sm rounded">
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

// ─── Tenants tab (T1.3 admin frontend) ──────────────────────────────────
// Cross-tenant list. Each row links into /tenants/{id} where the existing
// TenantContext resolver auto-grants superadmin access (no JWT minting).
// "View" is the impersonation lever — the superadmin sees the tenant's
// own UI exactly as a member would, plus their normal admin overlays.

function TenantsTab() {
  const { t } = useI18n()
  const [rows, setRows] = useState<AdminTenantRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    adminListTenants()
      .then((data) => { if (!cancelled) setRows(data.tenants) })
      .catch((err) => { if (!cancelled) setError((err as Error).message) })
    return () => { cancelled = true }
  }, [])

  if (error) {
    return (
      <div className="text-danger py-6">
        {t({ he: 'שגיאה: ', en: 'Error: ' })}{error}
      </div>
    )
  }
  if (rows === null) {
    return (
      <div className="text-text-muted py-6">
        {t({ he: 'טוען…', en: 'Loading…' })}
      </div>
    )
  }

  const q = filter.trim().toLowerCase()
  const visible = q
    ? rows.filter((r) =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.owner_email || '').toLowerCase().includes(q) ||
        (r.slug || '').toLowerCase().includes(q),
      )
    : rows

  function fmtDate(iso: string | null): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('en-GB')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t({ he: 'סינון לפי שם / אימייל / slug…', en: 'Filter by name / email / slug…' })}
          className="input-glass w-full max-w-sm px-3 py-2 text-sm"
        />
        <span className="text-sm text-text-muted shrink-0">
          {visible.length === rows.length
            ? t({ he: `${rows.length} סביבות`, en: `${rows.length} tenants` })
            : t({ he: `${visible.length} מתוך ${rows.length}`, en: `${visible.length} of ${rows.length}` })}
        </span>
      </div>

      <div className="glass-card admin-table-wrap">
        <table className="min-w-full text-sm">
          <thead className="bg-surface-soft text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th className="text-start px-4 py-3 font-medium">{t({ he: 'שם', en: 'Name' })}</th>
              <th className="text-start px-4 py-3 font-medium">{t({ he: 'בעלים', en: 'Owner' })}</th>
              <th className="text-start px-4 py-3 font-medium">{t({ he: 'תוכנית', en: 'Plan' })}</th>
              <th className="text-end px-4 py-3 font-medium">{t({ he: 'חברים', en: 'Members' })}</th>
              <th className="text-end px-4 py-3 font-medium">{t({ he: 'סוכנים', en: 'Agents' })}</th>
              <th className="text-start px-4 py-3 font-medium">{t({ he: 'מצב', en: 'Status' })}</th>
              <th className="text-start px-4 py-3 font-medium">{t({ he: 'תוקף עד', en: 'Period end' })}</th>
              <th className="w-10 px-2 py-3" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className="border-t border-border-light hover:bg-surface-soft/60 align-middle">
                <td className="px-4 py-3 min-w-0">
                  <div className="font-medium text-text-primary truncate max-w-[220px]" title={r.name}>
                    <bdi>{r.name}</bdi>
                  </div>
                  <code className="text-xs text-text-muted font-mono truncate max-w-[220px] block">
                    {r.slug}
                  </code>
                </td>
                <td className="px-4 py-3 min-w-0">
                  <div className="text-sm text-text-primary truncate max-w-[220px]" title={r.owner_full_name || r.owner_email || ''}>
                    <bdi>{r.owner_full_name || r.owner_email || `#${r.owner_user_id}`}</bdi>
                  </div>
                  {r.owner_full_name && r.owner_email && (
                    <div className="text-xs text-text-muted truncate max-w-[220px]" title={r.owner_email}>
                      <bdi>{r.owner_email}</bdi>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  {r.plan_id ? (
                    <TonedPill
                      label={r.plan_name_he || r.plan_id}
                      tone="info"
                      title={r.plan_id}
                    />
                  ) : (
                    <span className="text-text-muted italic text-xs">
                      {t({ he: 'אין תוכנית פעילה', en: 'No active plan' })}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-end tabular-nums font-mono text-xs">
                  {r.member_count}
                </td>
                <td className="px-4 py-3 text-end tabular-nums font-mono text-xs">
                  {r.agent_count}
                </td>
                <td className="px-4 py-3">
                  {r.subscription_status ? (
                    <StatusPill
                      label={r.subscription_status}
                      tone={subscriptionTone(r.subscription_status)}
                    />
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-text-muted tabular-nums" dir="ltr">
                  {fmtDate(r.subscription_period_end)}
                </td>
                <td className="px-2 py-3 text-end">
                  <a
                    href={`/tenants/${r.id}`}
                    className="inline-flex items-center justify-center w-8 h-8 rounded-full text-text-secondary hover:bg-surface-soft hover:text-brand transition-colors"
                    title={t({ he: 'פתח סביבה', en: 'Open workspace' })}
                    aria-label={t({ he: 'פתח סביבה', en: 'Open workspace' })}
                  >
                    <svg
                      className="w-[18px] h-[18px] rtl:-scale-x-100"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.75}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 12h14" />
                      <path d="M13 5l7 7-7 7" />
                    </svg>
                  </a>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-text-muted">
                  {t({ he: 'אין סביבות תואמות', en: 'No matching tenants' })}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-text-muted">
        {t({
          he: 'לחיצה על "פתח" מובילה לסביבת העבודה — אתה תראה אותה כפי שחבר רגיל רואה אותה (עם הרשאות superadmin).',
          en: '"Open" navigates into the workspace — you see it as a regular member would, with your superadmin overlay.',
        })}
      </p>
    </div>
  )
}
