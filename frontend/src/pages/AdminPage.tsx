import { useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  getAdminOverview,
  getAdminAgentDetail,
  getAdminVmStats,
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

type AdminTab = 'agents' | 'users' | 'plans' | 'stats'
const VALID_TABS: readonly AdminTab[] = ['agents', 'users', 'plans', 'stats']

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
          onSelect={setSelectedAgentId}
          onRotateKey={handleRotateKey}
        />
      )}

      {tab === 'users' && (
        <UsersTab users={overview.users} onPromote={handlePromote} />
      )}

      {tab === 'plans' && <PlansTab plans={overview.plans} />}

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
      <HistoryCharts history={data.history} />
      <TrafficChart events={data.events_per_hour} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MeterLatencyCard latency={data.meter_latency_1h} />
        <TopAgentsCard agents={data.top_agents} />
      </div>
      <ContainersCard containers={data.live?.docker?.containers || []} />
    </div>
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
}: {
  label: string
  value: string | number
  unit?: string
  pct: number
  yellow: number
  red: number
  sub?: string
}) {
  const color = colorForPct(pct, yellow, red)
  const bar = barColor(pct, yellow, red)
  return (
    <div className={`rounded-xl p-4 ${color}`}>
      <div className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</div>
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
          />
        )}
      </div>
    </div>
  )
}

const CHART_GRID = '#e5e7eb'
const AXIS_TICK = { fill: '#6b7280', fontSize: 11 }

const tooltipStyle = {
  background: 'rgba(255,255,255,0.95)',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  fontSize: 12,
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
}

function fmtHourLabel(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
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
  const maxContainers = Math.max(25, ...histData.map((r) => r.containers))
  return (
    <div className="glass-card p-6">
      <h3 className="text-base font-semibold mb-3">Last 24 hours</h3>
      <div className="space-y-6">
        <div>
          <div className="text-xs text-gray-600 mb-2">CPU · RAM · Disk (%)</div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={histData} margin={{ top: 5, right: 12, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
              <XAxis dataKey="time" tick={AXIS_TICK} minTickGap={32} />
              <YAxis tick={AXIS_TICK} domain={[0, 100]} unit="%" />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v).toFixed(1)}%`} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="cpu" name="CPU" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="ram" name="RAM" stroke="#8b5cf6" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="disk" name="Disk" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div>
          <div className="text-xs text-gray-600 mb-2">Running containers</div>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={histData} margin={{ top: 5, right: 12, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="containersFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
              <XAxis dataKey="time" tick={AXIS_TICK} minTickGap={32} />
              <YAxis tick={AXIS_TICK} domain={[0, maxContainers]} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Area type="monotone" dataKey="containers" name="Containers" stroke="#10b981" strokeWidth={2} fill="url(#containersFill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

function TrafficChart({ events }: { events: VmStatsResponse['events_per_hour'] }) {
  if (events.length === 0) return null
  const trafficData = events.map((r) => ({
    hour: new Date(r.hour).toLocaleTimeString('en-GB', { hour: '2-digit' }) + ':00',
    events: Number(r.events),
    costUsd: Number(r.cost_micros) / 1_000_000,
  }))
  const totalEvents = trafficData.reduce((a, b) => a + b.events, 0)
  const totalCost = trafficData.reduce((a, b) => a + b.costUsd, 0)
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold">Meter traffic — last 24h</h3>
        <div className="text-xs text-gray-600">
          <span className="font-mono">{totalEvents}</span> events ·{' '}
          <span className="font-mono">${totalCost.toFixed(4)}</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={trafficData} margin={{ top: 5, right: 12, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
          <XAxis dataKey="hour" tick={AXIS_TICK} minTickGap={28} />
          <YAxis yAxisId="left" tick={AXIS_TICK} allowDecimals={false} />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={AXIS_TICK}
            tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v, name) =>
              name === 'Cost' ? `$${Number(v).toFixed(4)}` : Number(v).toLocaleString()
            }
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar yAxisId="left" dataKey="events" name="Events" fill="#0ea5e9" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="right" type="monotone" dataKey="costUsd" name="Cost" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} />
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
  return (
    <div className="glass-card p-6">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold">Meter latency (last 1h)</h3>
        <div className="text-xs text-gray-500">
          n = <span className="font-mono">{latency.n}</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={data} layout="vertical" margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} horizontal={false} />
          <XAxis type="number" tick={AXIS_TICK} unit="ms" />
          <YAxis type="category" dataKey="name" tick={AXIS_TICK} width={36} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${v}ms`} />
          <Bar dataKey="ms" fill="#6366f1" radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function TopAgentsCard({ agents }: { agents: VmStatsResponse['top_agents'] }) {
  if (agents.length === 0) {
    return (
      <div className="glass-card p-6">
        <h3 className="text-base font-semibold mb-3">Top agents — last 30 days ($ spend)</h3>
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
  const chartHeight = Math.max(120, chartData.length * 28 + 40)
  return (
    <div className="glass-card p-6">
      <h3 className="text-base font-semibold mb-3">Top agents — last 30 days ($ spend)</h3>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} horizontal={false} />
          <XAxis type="number" tick={AXIS_TICK} tickFormatter={(v) => `$${Number(v).toFixed(2)}`} />
          <YAxis type="category" dataKey="agent" tick={{ ...AXIS_TICK, fontFamily: 'ui-monospace, monospace' }} width={120} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v, name) =>
              name === 'Spend' ? `$${Number(v).toFixed(4)}` : Number(v).toLocaleString()
            }
          />
          <Bar dataKey="usd" name="Spend" fill="#0ea5e9" radius={[0, 4, 4, 0]} isAnimationActive={false} />
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
