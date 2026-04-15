import { useEffect, useState } from 'react'
import type { TenantDetail } from '../lib/types'
import {
  getTenantDashboard,
  getTenantDetail,
  createInvite,
  revokeInvite,
  removeMember,
  changeMemberRole,
  updateTenant,
  deleteTenant,
  transferTenantOwner,
  provisionTenantAgent,
} from '../lib/api'

interface Props {
  tenantId: number
  subpage: 'dashboard' | 'members' | 'settings'
  onNavigate: (path: string) => void
  onTenantsChanged: () => void
}

type Tab = 'dashboard' | 'members' | 'settings'

/**
 * Unified tenant page with three tabs. Keeping dashboard/members/settings
 * in one component (instead of three separate pages) means we fetch tenant
 * detail once per tab switch instead of unmount/remount churn, and the
 * nav is always in context.
 */
export default function TenantPage({ tenantId, subpage, onNavigate, onTenantsChanged }: Props) {
  const [detail, setDetail] = useState<TenantDetail | null>(null)
  const [dashboard, setDashboard] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const activeTab: Tab = (subpage || 'dashboard') as Tab

  const reload = async () => {
    setLoading(true)
    setError(null)
    try {
      const [d, dash] = await Promise.all([
        getTenantDetail(tenantId),
        getTenantDashboard(tenantId).catch(() => null),
      ])
      setDetail(d)
      setDashboard(dash)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  if (loading) return <div className="p-8 text-gray-500">Loading workspace...</div>
  if (error) return <div className="p-8 text-red-600">Error: {error}</div>
  if (!detail) return null

  const { tenant, members, agents, pending_invites } = detail
  const isAdminOrOwner = tenant.role === 'admin' || tenant.role === 'owner'
  const isOwner = tenant.role === 'owner'

  const setTab = (t: Tab) => onNavigate(`/tenants/${tenantId}${t === 'dashboard' ? '' : '/' + t}`)

  const tabButton = (t: Tab, label: string) => (
    <button
      key={t}
      onClick={() => setTab(t)}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        activeTab === t
          ? 'border-indigo-600 text-indigo-600'
          : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        {/* dir="auto" lets the browser pick RTL vs LTR per-element from
            the first strong directional character, so Hebrew names
            render right-aligned and English names render left-aligned
            without mixing in the same line. */}
        <h1 className="text-2xl font-bold text-gray-900" dir="auto">
          {tenant.name}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {members.length} member{members.length !== 1 ? 's' : ''} · {agents.length} agent
          {agents.length !== 1 ? 's' : ''} · your role: <span className="font-medium">{tenant.role}</span>
        </p>
      </div>

      <div className="border-b border-gray-200 mb-6 flex gap-2">
        {tabButton('dashboard', 'Dashboard')}
        {tabButton('members', `Members (${members.length})`)}
        {tabButton('settings', 'Settings')}
      </div>

      {activeTab === 'dashboard' && (
        <DashboardTab
          tenantId={tenantId}
          dashboard={dashboard}
          agents={agents}
          isAdminOrOwner={isAdminOrOwner}
          onChanged={reload}
        />
      )}
      {activeTab === 'members' && (
        <MembersTab
          tenantId={tenantId}
          members={members}
          pendingInvites={pending_invites}
          isAdminOrOwner={isAdminOrOwner}
          isOwner={isOwner}
          ownerUserId={tenant.owner_user_id}
          onChanged={reload}
        />
      )}
      {activeTab === 'settings' && (
        <SettingsTab
          tenantId={tenantId}
          tenant={tenant}
          members={members}
          isOwner={isOwner}
          onChanged={reload}
          onDeleted={() => {
            onTenantsChanged()
            onNavigate('/')
          }}
        />
      )}
    </div>
  )
}

// ─── Dashboard tab ────────────────────────────────────────────────────

function DashboardTab({
  tenantId,
  dashboard,
  agents,
  isAdminOrOwner,
  onChanged,
}: {
  tenantId: number
  dashboard: any
  agents: any[]
  isAdminOrOwner: boolean
  onChanged: () => void
}) {
  const subscription = dashboard?.subscription
  const totals = dashboard?.totals

  const [showNewAgent, setShowNewAgent] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [newAgentGender, setNewAgentGender] = useState<'female' | 'male'>('female')
  const [newAgentPhone, setNewAgentPhone] = useState('')
  const [provisioning, setProvisioning] = useState(false)
  const [provisionError, setProvisionError] = useState<string | null>(null)

  async function handleProvision() {
    if (!newAgentName.trim() || !newAgentPhone.trim()) return
    setProvisioning(true)
    setProvisionError(null)
    try {
      await provisionTenantAgent(tenantId, {
        agent_name: newAgentName.trim(),
        agent_gender: newAgentGender,
        phone: newAgentPhone.trim(),
      })
      setNewAgentName('')
      setNewAgentPhone('')
      setShowNewAgent(false)
      onChanged()
    } catch (err) {
      setProvisionError((err as Error).message)
    } finally {
      setProvisioning(false)
    }
  }

  const microsToUsd = (m: number | null | undefined) => {
    if (m == null) return '—'
    return `$${(m / 1_000_000).toFixed(2)}`
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Subscription</h2>
        {subscription ? (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-gray-500">Plan</div>
              <div className="font-medium text-gray-900">{subscription.plan_id || '—'}</div>
            </div>
            <div>
              <div className="text-gray-500">Status</div>
              <div className="font-medium text-gray-900">{subscription.status || '—'}</div>
            </div>
            <div>
              <div className="text-gray-500">Used this period</div>
              <div className="font-medium text-gray-900">
                {microsToUsd(subscription.used_micros)} /{' '}
                {microsToUsd(subscription.base_allowance_micros)}
              </div>
            </div>
            <div>
              <div className="text-gray-500">Overage</div>
              <div className="font-medium text-gray-900">
                {microsToUsd(subscription.overage_used_micros)}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">No active subscription.</p>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Agents ({agents.length})
          </h2>
          {isAdminOrOwner && (
            <button
              onClick={() => setShowNewAgent(!showNewAgent)}
              className="px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              New agent
            </button>
          )}
        </div>

        {showNewAgent && isAdminOrOwner && (
          <div className="mb-4 p-4 bg-gray-50 rounded-lg space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Agent name
                </label>
                <input
                  type="text"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  placeholder="שולי / barber"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Gender
                </label>
                <select
                  value={newAgentGender}
                  onChange={(e) =>
                    setNewAgentGender(e.target.value as 'female' | 'male')
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg"
                >
                  <option value="female">נקבה / female</option>
                  <option value="male">זכר / male</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                WhatsApp phone (E.164, e.g. +972501234567)
              </label>
              <input
                type="tel"
                value={newAgentPhone}
                onChange={(e) => setNewAgentPhone(e.target.value)}
                placeholder="+972501234567"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            {provisionError && (
              <div className="text-sm text-red-700 bg-red-50 p-3 rounded">
                {provisionError}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleProvision}
                disabled={
                  provisioning || !newAgentName.trim() || !newAgentPhone.trim()
                }
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {provisioning
                  ? 'Provisioning... (30–60s)'
                  : 'Create agent'}
              </button>
              <button
                onClick={() => setShowNewAgent(false)}
                disabled={provisioning}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {agents.length === 0 ? (
          <p className="text-sm text-gray-500">No agents yet.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {agents.map((a) => (
              <div key={a.agent_id} className="py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-900">{a.agent_name}</div>
                  <div className="text-xs text-gray-500 font-mono">{a.agent_id}</div>
                </div>
                <span className="text-xs px-2 py-1 bg-green-50 text-green-700 rounded">
                  {a.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {totals && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Usage breakdown</h2>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-gray-500">LLM</div>
              <div className="font-medium">{microsToUsd(totals.llm_micros)}</div>
            </div>
            <div>
              <div className="text-gray-500">Search</div>
              <div className="font-medium">{microsToUsd(totals.search_micros)}</div>
            </div>
            <div>
              <div className="text-gray-500">TTS</div>
              <div className="font-medium">{microsToUsd(totals.tts_micros)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Members tab ──────────────────────────────────────────────────────

function MembersTab({
  tenantId,
  members,
  pendingInvites,
  isAdminOrOwner,
  isOwner,
  ownerUserId,
  onChanged,
}: {
  tenantId: number
  members: any[]
  pendingInvites: any[]
  isAdminOrOwner: boolean
  isOwner: boolean
  ownerUserId: number
  onChanged: () => void
}) {
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [inviteStatus, setInviteStatus] = useState<string | null>(null)
  const [inviteLink, setInviteLink] = useState<string | null>(null)

  async function handleInvite() {
    if (!inviteEmail.trim()) return
    setInviteStatus('sending')
    try {
      const result = await createInvite(tenantId, inviteEmail.trim(), inviteRole)
      setInviteLink(result.accept_url)
      setInviteStatus(result.email_sent ? 'sent' : 'link-only')
      setInviteEmail('')
      onChanged()
    } catch (err) {
      setInviteStatus('error:' + (err as Error).message)
    }
  }

  async function handleRevoke(inviteId: number) {
    if (!confirm('Revoke this invite?')) return
    try {
      await revokeInvite(tenantId, inviteId)
      onChanged()
    } catch (err) {
      alert('Failed: ' + (err as Error).message)
    }
  }

  async function handleRemove(userId: number) {
    if (!confirm('Remove this member?')) return
    try {
      await removeMember(tenantId, userId)
      onChanged()
    } catch (err) {
      alert('Failed: ' + (err as Error).message)
    }
  }

  async function handleChangeRole(userId: number, newRole: 'admin' | 'member') {
    try {
      await changeMemberRole(tenantId, userId, newRole)
      onChanged()
    } catch (err) {
      alert('Failed: ' + (err as Error).message)
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Members ({members.length})</h2>
          {isAdminOrOwner && (
            <button
              onClick={() => setShowInvite(!showInvite)}
              className="px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              Invite
            </button>
          )}
        </div>

        {showInvite && isAdminOrOwner && (
          <div className="mb-4 p-4 bg-gray-50 rounded-lg space-y-3">
            <div className="flex gap-2">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="name@example.com"
                className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={handleInvite}
                disabled={inviteStatus === 'sending'}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {inviteStatus === 'sending' ? 'Sending...' : 'Send invite'}
              </button>
            </div>
            {inviteStatus === 'sent' && inviteLink && (
              <div className="text-sm text-green-700 bg-green-50 p-3 rounded">
                Email sent. Backup link: <a href={inviteLink} className="underline break-all">{inviteLink}</a>
              </div>
            )}
            {inviteStatus === 'link-only' && inviteLink && (
              <div className="text-sm text-amber-800 bg-amber-50 p-3 rounded">
                Email failed to send. Copy this link to share manually:<br />
                <a href={inviteLink} className="underline break-all">{inviteLink}</a>
              </div>
            )}
            {inviteStatus?.startsWith('error:') && (
              <div className="text-sm text-red-700 bg-red-50 p-3 rounded">
                {inviteStatus.slice(6)}
              </div>
            )}
          </div>
        )}

        <div className="divide-y divide-gray-100">
          {members.map((m) => (
            <div key={m.user_id} className="py-3 flex items-center justify-between">
              <div>
                <div className="font-medium text-gray-900">{m.full_name || m.email}</div>
                <div className="text-xs text-gray-500">{m.email}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-gray-600 uppercase">{m.role}</span>
                {isOwner && m.user_id !== ownerUserId && (
                  <>
                    <select
                      value={m.role}
                      onChange={(e) => handleChangeRole(m.user_id, e.target.value as 'admin' | 'member')}
                      className="text-xs border border-gray-300 rounded px-2 py-1"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button
                      onClick={() => handleRemove(m.user_id)}
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {pendingInvites.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Pending invites ({pendingInvites.length})
          </h2>
          <div className="divide-y divide-gray-100">
            {pendingInvites.map((i) => (
              <div key={i.id} className="py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-900">{i.email}</div>
                  <div className="text-xs text-gray-500">
                    {i.role} · expires {new Date(i.expires_at).toLocaleDateString()}
                  </div>
                </div>
                {isAdminOrOwner && (
                  <button
                    onClick={() => handleRevoke(i.id)}
                    className="text-xs text-red-600 hover:text-red-800"
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Settings tab ─────────────────────────────────────────────────────

function SettingsTab({
  tenantId,
  tenant,
  members,
  isOwner,
  onChanged,
  onDeleted,
}: {
  tenantId: number
  tenant: any
  members: any[]
  isOwner: boolean
  onChanged: () => void
  onDeleted: () => void
}) {
  const [name, setName] = useState(tenant.name)
  const [billingEmail, setBillingEmail] = useState(tenant.billing_email || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await updateTenant(tenantId, { name, billing_email: billingEmail })
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete workspace "${tenant.name}"? This cannot be undone.`)) return
    try {
      await deleteTenant(tenantId)
      onDeleted()
    } catch (err) {
      alert('Failed: ' + (err as Error).message)
    }
  }

  async function handleTransfer(userId: number) {
    const member = members.find((m) => m.user_id === userId)
    if (!member) return
    if (!confirm(`Transfer ownership to ${member.full_name || member.email}? You will become an admin.`)) return
    try {
      await transferTenantOwner(tenantId, userId)
      onChanged()
    } catch (err) {
      alert('Failed: ' + (err as Error).message)
    }
  }

  const otherMembers = members.filter((m) => m.user_id !== tenant.owner_user_id)

  return (
    <div className="space-y-6">
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">General</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Workspace name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              disabled={!isOwner}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Billing email</label>
            <input
              type="email"
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              disabled={!isOwner}
            />
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          {isOwner && (
            <button
              onClick={handleSave}
              disabled={saving || (name === tenant.name && billingEmail === tenant.billing_email)}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save changes'}
            </button>
          )}
        </div>
      </div>

      {isOwner && otherMembers.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Transfer ownership</h2>
          <p className="text-sm text-gray-500 mb-4">
            Make another member the owner of this workspace. You'll become an admin.
          </p>
          <div className="space-y-2">
            {otherMembers.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium text-gray-900">{m.full_name || m.email}</div>
                  <div className="text-xs text-gray-500">{m.email}</div>
                </div>
                <button
                  onClick={() => handleTransfer(m.user_id)}
                  className="text-sm text-indigo-600 hover:text-indigo-800"
                >
                  Transfer
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {isOwner && (
        <div className="bg-white border border-red-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-red-900 mb-2">Danger zone</h2>
          <p className="text-sm text-gray-600 mb-4">
            Deleting this workspace removes all agents, members, and invites. You must own at
            least one other workspace first.
          </p>
          <button
            onClick={handleDelete}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
          >
            Delete workspace
          </button>
        </div>
      )}
    </div>
  )
}
