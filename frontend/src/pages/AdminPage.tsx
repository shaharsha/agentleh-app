import { useEffect, useState } from 'react'
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
  const [tab, setTab] = useState<'agents' | 'users' | 'plans' | 'stats'>('agents')

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

// Simple inline SVG sparkline. No chart library.
function Sparkline({
  points,
  color = '#3b82f6',
  label,
  max = 100,
}: {
  points: number[]
  color?: string
  label?: string
  max?: number
}) {
  const width = 300
  const height = 60
  if (points.length === 0) {
    return <div className="text-xs text-gray-400 h-[60px] flex items-center">no data</div>
  }
  const step = width / Math.max(1, points.length - 1)
  const path = points
    .map((v, i) => {
      const x = i * step
      const y = height - (Math.min(max, Math.max(0, v)) / max) * height
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const last = points[points.length - 1]
  return (
    <div>
      {label && (
        <div className="text-xs text-gray-600 mb-1 flex items-center justify-between">
          <span>{label}</span>
          <span className="font-mono">{last.toFixed(1)}</span>
        </div>
      )}
      <svg width={width} height={height} className="w-full">
        <path d={path} fill="none" stroke={color} strokeWidth={1.8} />
        <path d={`${path} L${width},${height} L0,${height} Z`} fill={color} opacity={0.08} />
      </svg>
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
  const cpu = history.map((r) => Number(r.cpu_percent ?? 0))
  const mem = history.map((r) => Number(r.memory_percent ?? 0))
  const disk = history.map((r) => Number(r.disk_data_pct ?? r.disk_root_pct ?? 0))
  const containers = history.map((r) => Number(r.containers_run ?? 0))
  const maxContainers = Math.max(25, Math.max(...containers, 1))
  return (
    <div className="glass-card p-6">
      <h3 className="text-base font-semibold mb-3">Last 24 hours</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Sparkline points={cpu} color="#3b82f6" label="CPU %" />
        <Sparkline points={mem} color="#8b5cf6" label="RAM %" />
        <Sparkline points={disk} color="#f59e0b" label="Disk %" />
        <Sparkline points={containers} color="#10b981" label="Containers" max={maxContainers} />
      </div>
    </div>
  )
}

function TrafficChart({ events }: { events: VmStatsResponse['events_per_hour'] }) {
  if (events.length === 0) return null
  const counts = events.map((r) => Number(r.events))
  const costs = events.map((r) => Number(r.cost_micros) / 1_000_000)
  const maxCount = Math.max(...counts, 1)
  const maxCost = Math.max(...costs, 0.001)
  const totalCost = costs.reduce((a, b) => a + b, 0)
  const totalEvents = counts.reduce((a, b) => a + b, 0)
  return (
    <div className="glass-card p-6">
      <h3 className="text-base font-semibold mb-3">Meter traffic — last 24h</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Sparkline points={counts} color="#0ea5e9" label="Events / hour" max={maxCount * 1.1} />
        <Sparkline points={costs} color="#ef4444" label="Cost ($) / hour" max={maxCost * 1.1} />
      </div>
      <div className="mt-3 text-xs text-gray-600">
        24h totals: <span className="font-mono">{totalEvents}</span> events ·{' '}
        <span className="font-mono">${totalCost.toFixed(4)}</span>
      </div>
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
  return (
    <div className="glass-card p-6">
      <h3 className="text-base font-semibold mb-3">Meter latency (last 1h)</h3>
      <div className="space-y-1 text-sm font-mono">
        <div className="flex justify-between">
          <span className="text-gray-500">n</span>
          <span>{latency.n}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">p50</span>
          <span>{latency.p50 ?? '—'}ms</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">p95</span>
          <span>{latency.p95 ?? '—'}ms</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">p99</span>
          <span>{latency.p99 ?? '—'}ms</span>
        </div>
      </div>
    </div>
  )
}

function TopAgentsCard({ agents }: { agents: VmStatsResponse['top_agents'] }) {
  return (
    <div className="glass-card p-6">
      <h3 className="text-base font-semibold mb-3">Top agents — last 30 days ($ spend)</h3>
      {agents.length === 0 ? (
        <div className="text-sm text-gray-500">No usage yet.</div>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {agents.map((a) => (
              <tr key={a.agent_id} className="border-t">
                <td className="p-1 font-mono">{a.agent_id}</td>
                <td className="p-1 text-right font-mono">
                  ${(a.cost_micros / 1_000_000).toFixed(4)}
                </td>
                <td className="p-1 text-right text-gray-500">{a.events} evt</td>
                <td className="p-1 text-right text-gray-500">
                  {Number(a.total_tokens).toLocaleString()}t
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
