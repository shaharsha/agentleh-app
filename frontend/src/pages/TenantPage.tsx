import { useEffect, useState } from 'react'
import type { TenantDetail, TenantRole } from '../lib/types'
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
import { useI18n, type Bilingual } from '../lib/i18n'
import { planLabel, statusLabel } from '../lib/labels'
import TenantName from '../components/TenantName'
import IntegrationsPanel from '../components/IntegrationsPanel'

interface Props {
  tenantId: number
  subpage: 'dashboard' | 'members' | 'settings'
  onNavigate: (path: string) => void
  onTenantsChanged: () => void
}

type Tab = 'dashboard' | 'members' | 'settings'

/**
 * Unified tenant page with three tabs. Fully bilingual via useI18n:
 * every visible string is a t({he, en}) call so the page flips
 * between Hebrew and English with the language switcher in the nav,
 * and direction follows <html dir> automatically (no dir="ltr"
 * overrides). User-supplied names (tenant, agent, member) use
 * dir="auto" so Hebrew + Latin both render per the first strong
 * directional character regardless of the active UI language.
 */
export default function TenantPage({ tenantId, subpage, onNavigate, onTenantsChanged }: Props) {
  const { t } = useI18n()
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

  // After the Google OAuth callback redirects back here with
  // ?google=connected|denied|error, surface a toast-like alert, reload
  // so the integrations panel flips state, and clear the query param so
  // a page refresh doesn't re-trigger.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const googleParam = params.get('google')
    if (!googleParam) return

    if (googleParam === 'connected') {
      window.alert(
        t({ he: 'חשבון גוגל חובר בהצלחה!', en: 'Google account connected!' }),
      )
      reload()
    } else if (googleParam === 'denied') {
      window.alert(
        t({
          he: 'החיבור לגוגל לא הושלם. ניתן לנסות שוב.',
          en: 'Google connect was cancelled. You can try again.',
        }),
      )
    } else if (googleParam === 'error') {
      window.alert(
        t({
          he: 'שגיאה בחיבור לגוגל. נסה שוב.',
          en: 'Google connect failed. Try again.',
        }),
      )
    }

    params.delete('google')
    const newQuery = params.toString()
    const newUrl = `${window.location.pathname}${newQuery ? '?' + newQuery : ''}`
    window.history.replaceState({}, '', newUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return (
      <div className="p-8 text-gray-500">
        {t({ he: 'טוען סביבת עבודה…', en: 'Loading workspace…' })}
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-8 text-red-600">
        {t({ he: 'שגיאה: ', en: 'Error: ' })}
        {error}
      </div>
    )
  }
  if (!detail) return null

  const { tenant, members, agents, pending_invites } = detail
  const isAdminOrOwner = tenant.role === 'admin' || tenant.role === 'owner'
  const isOwner = tenant.role === 'owner'

  const setTab = (tab: Tab) =>
    onNavigate(`/tenants/${tenantId}${tab === 'dashboard' ? '' : '/' + tab}`)

  const tabLabel = (tab: Tab): Bilingual =>
    tab === 'dashboard'
      ? { he: 'לוח בקרה', en: 'Dashboard' }
      : tab === 'members'
        ? { he: 'חברים', en: 'Members' }
        : { he: 'הגדרות', en: 'Settings' }

  const tabButton = (tab: Tab) => (
    <button
      key={tab}
      onClick={() => setTab(tab)}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
        activeTab === tab
          ? 'border-indigo-600 text-indigo-600'
          : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {t(tabLabel(tab))}
      {tab === 'members' && ` (${members.length})`}
    </button>
  )

  const roleText = (role: TenantRole): string =>
    t(
      role === 'owner'
        ? { he: 'בעלים', en: 'owner' }
        : role === 'admin'
          ? { he: 'מנהל', en: 'admin' }
          : { he: 'חבר', en: 'member' },
    )

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          <TenantName tenant={tenant} />
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {t({
            he: `${members.length} ${members.length === 1 ? 'חבר' : 'חברים'} · ${agents.length} ${
              agents.length === 1 ? 'סוכן' : 'סוכנים'
            } · התפקיד שלך: `,
            en: `${members.length} member${members.length !== 1 ? 's' : ''} · ${agents.length} agent${
              agents.length !== 1 ? 's' : ''
            } · your role: `,
          })}
          <span className="font-medium">{roleText(tenant.role)}</span>
        </p>
      </div>

      <div className="border-b border-gray-200 mb-6 flex gap-2">
        {tabButton('dashboard')}
        {tabButton('members')}
        {tabButton('settings')}
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
  const { t, dir } = useI18n()
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

  // Numbers + currencies stay in LTR because the bidi algorithm flips
  // "$1.23" in RTL context in confusing ways. We wrap them in dir="ltr"
  // spans so they always read left-to-right.
  const microsToUsd = (m: number | null | undefined) => {
    if (m == null) return '—'
    return `$${(m / 1_000_000).toFixed(2)}`
  }
  const num = (v: string) => <span dir="ltr">{v}</span>

  return (
    <div className="space-y-6">
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {t({ he: 'מנוי', en: 'Subscription' })}
        </h2>
        {subscription ? (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-gray-500">{t({ he: 'תכנית', en: 'Plan' })}</div>
              <div className="font-medium text-gray-900">
                {t(planLabel(subscription.plan_id))}
              </div>
            </div>
            <div>
              <div className="text-gray-500">{t({ he: 'סטטוס', en: 'Status' })}</div>
              <div className="font-medium text-gray-900">
                {t(statusLabel(subscription.status))}
              </div>
            </div>
            <div>
              <div className="text-gray-500">
                {t({ he: 'שימוש בתקופה הנוכחית', en: 'Used this period' })}
              </div>
              <div className="font-medium text-gray-900">
                {num(microsToUsd(subscription.used_micros))}{' / '}
                {num(microsToUsd(subscription.base_allowance_micros))}
              </div>
            </div>
            <div>
              <div className="text-gray-500">{t({ he: 'חריגה', en: 'Overage' })}</div>
              <div className="font-medium text-gray-900">
                {num(microsToUsd(subscription.overage_used_micros))}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            {t({ he: 'אין מנוי פעיל.', en: 'No active subscription.' })}
          </p>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {t({ he: 'סוכנים', en: 'Agents' })} ({agents.length})
          </h2>
          {isAdminOrOwner && (
            <button
              onClick={() => setShowNewAgent(!showNewAgent)}
              className="px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              {t({ he: 'סוכן חדש', en: 'New agent' })}
            </button>
          )}
        </div>

        {showNewAgent && isAdminOrOwner && (
          <div className="mb-4 p-4 bg-gray-50 rounded-lg space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {t({ he: 'שם הסוכן', en: 'Agent name' })}
                </label>
                {/* Explicit dir from useI18n instead of dir="auto": an
                    empty input with dir="auto" falls back to parent
                    direction for the VALUE, but the placeholder still
                    renders via the ::placeholder pseudo-element whose
                    direction rules don't always honor auto-detect, so
                    Hebrew placeholders ended up LTR-aligned. Following
                    the active UI language is predictable and matches
                    the user's expectation on keystroke. */}
                <input
                  type="text"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  placeholder={t({ he: 'שולי', en: 'e.g. Shuli' })}
                  dir={dir}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {t({ he: 'מין', en: 'Gender' })}
                </label>
                <select
                  value={newAgentGender}
                  onChange={(e) => setNewAgentGender(e.target.value as 'female' | 'male')}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg"
                >
                  <option value="female">{t({ he: 'נקבה', en: 'Female' })}</option>
                  <option value="male">{t({ he: 'זכר', en: 'Male' })}</option>
                </select>
              </div>
            </div>
            {/* The phone field is the END USER's phone — the person who
                will send WhatsApp messages to this agent — NOT the
                agent's phone (there's no such thing; our Meta WABA
                business number is a single shared endpoint for all
                inbound traffic and the bridge routes by the sender's
                phone number to the right agent). Labels reflect that
                explicitly to avoid the "why isn't this my business
                number" confusion we had on dev. */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {t({
                  he: 'מספר הוואטסאפ של המשתמש',
                  en: "User's WhatsApp number",
                })}
              </label>
              <input
                type="tel"
                value={newAgentPhone}
                onChange={(e) => setNewAgentPhone(e.target.value)}
                placeholder="+972501234567"
                dir="ltr"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <p className="text-[11px] text-gray-500 mt-1">
                {t({
                  he: 'המספר שממנו ישלח המשתמש הודעות לסוכן (פורמט בינלאומי, לדוגמה +972501234567). לא המספר המשותף של Agentiko.',
                  en: 'The number the user will message this agent from (E.164, e.g. +972501234567). Not Agentiko\'s shared business number.',
                })}
              </p>
            </div>
            {provisionError && (
              <div className="text-sm text-red-700 bg-red-50 p-3 rounded">{provisionError}</div>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleProvision}
                disabled={provisioning || !newAgentName.trim() || !newAgentPhone.trim()}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {provisioning
                  ? t({ he: 'מקים… (30–60 שניות)', en: 'Provisioning… (30–60s)' })
                  : t({ he: 'צור סוכן', en: 'Create agent' })}
              </button>
              <button
                onClick={() => setShowNewAgent(false)}
                disabled={provisioning}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                {t({ he: 'ביטול', en: 'Cancel' })}
              </button>
            </div>
          </div>
        )}

        {agents.length === 0 ? (
          <p className="text-sm text-gray-500">
            {t({ he: 'אין עדיין סוכנים.', en: 'No agents yet.' })}
          </p>
        ) : (
          <div className="divide-y divide-gray-100">
            {agents.map((a) => (
              <div key={a.agent_id} className="py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-gray-900" dir="auto">
                      {a.agent_name}
                    </div>
                    <div className="text-xs text-gray-500 font-mono" dir="ltr">
                      {a.agent_id}
                    </div>
                  </div>
                  <span className="text-xs px-2 py-1 bg-green-50 text-green-700 rounded">
                    {t(statusLabel(a.status))}
                  </span>
                </div>
                <IntegrationsPanel
                  tenantId={tenantId}
                  agentId={a.agent_id}
                  onChange={onChanged}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {totals && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            {t({ he: 'פירוט שימוש', en: 'Usage breakdown' })}
          </h2>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-gray-500">{t({ he: 'מודל שפה', en: 'LLM' })}</div>
              <div className="font-medium">{num(microsToUsd(totals.llm_micros))}</div>
            </div>
            <div>
              <div className="text-gray-500">{t({ he: 'חיפוש', en: 'Search' })}</div>
              <div className="font-medium">{num(microsToUsd(totals.search_micros))}</div>
            </div>
            <div>
              <div className="text-gray-500">{t({ he: 'קול', en: 'Voice (TTS)' })}</div>
              <div className="font-medium">{num(microsToUsd(totals.tts_micros))}</div>
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
  const { t } = useI18n()
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
    if (!confirm(t({ he: 'לבטל את ההזמנה?', en: 'Revoke this invite?' }))) return
    try {
      await revokeInvite(tenantId, inviteId)
      onChanged()
    } catch (err) {
      alert(t({ he: 'נכשל: ', en: 'Failed: ' }) + (err as Error).message)
    }
  }

  async function handleRemove(userId: number) {
    if (!confirm(t({ he: 'להסיר חבר/ה?', en: 'Remove this member?' }))) return
    try {
      await removeMember(tenantId, userId)
      onChanged()
    } catch (err) {
      alert(t({ he: 'נכשל: ', en: 'Failed: ' }) + (err as Error).message)
    }
  }

  async function handleChangeRole(userId: number, newRole: 'admin' | 'member') {
    try {
      await changeMemberRole(tenantId, userId, newRole)
      onChanged()
    } catch (err) {
      alert(t({ he: 'נכשל: ', en: 'Failed: ' }) + (err as Error).message)
    }
  }

  const roleOptionLabel = (role: 'admin' | 'member') =>
    t(role === 'admin' ? { he: 'מנהל', en: 'Admin' } : { he: 'חבר', en: 'Member' })

  return (
    <div className="space-y-6">
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {t({ he: 'חברים', en: 'Members' })} ({members.length})
          </h2>
          {isAdminOrOwner && (
            <button
              onClick={() => setShowInvite(!showInvite)}
              className="px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              {t({ he: 'הזמנה', en: 'Invite' })}
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
                dir="ltr"
                className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg"
              >
                <option value="member">{roleOptionLabel('member')}</option>
                <option value="admin">{roleOptionLabel('admin')}</option>
              </select>
              <button
                onClick={handleInvite}
                disabled={inviteStatus === 'sending'}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {inviteStatus === 'sending'
                  ? t({ he: 'שולח…', en: 'Sending…' })
                  : t({ he: 'שליחת הזמנה', en: 'Send invite' })}
              </button>
            </div>
            {inviteStatus === 'sent' && inviteLink && (
              <div className="text-sm text-green-700 bg-green-50 p-3 rounded">
                {t({ he: 'ההזמנה נשלחה. קישור גיבוי: ', en: 'Email sent. Backup link: ' })}
                <a href={inviteLink} dir="ltr" className="underline break-all">
                  {inviteLink}
                </a>
              </div>
            )}
            {inviteStatus === 'link-only' && inviteLink && (
              <div className="text-sm text-amber-800 bg-amber-50 p-3 rounded">
                {t({
                  he: 'שליחת המייל נכשלה. העתק/י את הקישור לשיתוף ידני:',
                  en: 'Email failed to send. Copy this link to share manually:',
                })}
                <br />
                <a href={inviteLink} dir="ltr" className="underline break-all">
                  {inviteLink}
                </a>
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
                <div className="font-medium text-gray-900" dir="auto">
                  {m.full_name || m.email}
                </div>
                <div className="text-xs text-gray-500" dir="ltr">
                  {m.email}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-gray-600 uppercase">
                  {t(
                    m.role === 'owner'
                      ? { he: 'בעלים', en: 'owner' }
                      : m.role === 'admin'
                        ? { he: 'מנהל', en: 'admin' }
                        : { he: 'חבר', en: 'member' },
                  )}
                </span>
                {isOwner && m.user_id !== ownerUserId && (
                  <>
                    <select
                      value={m.role}
                      onChange={(e) => handleChangeRole(m.user_id, e.target.value as 'admin' | 'member')}
                      className="text-xs border border-gray-300 rounded px-2 py-1"
                    >
                      <option value="member">{roleOptionLabel('member')}</option>
                      <option value="admin">{roleOptionLabel('admin')}</option>
                    </select>
                    <button
                      onClick={() => handleRemove(m.user_id)}
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      {t({ he: 'הסרה', en: 'Remove' })}
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
            {t({ he: 'הזמנות ממתינות', en: 'Pending invites' })} ({pendingInvites.length})
          </h2>
          <div className="divide-y divide-gray-100">
            {pendingInvites.map((i) => (
              <div key={i.id} className="py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium text-gray-900" dir="ltr">
                    {i.email}
                  </div>
                  <div className="text-xs text-gray-500">
                    {roleOptionLabel(i.role)} ·{' '}
                    {t({ he: 'תוקף עד ', en: 'expires ' })}
                    {new Date(i.expires_at).toLocaleDateString('en-GB')}
                  </div>
                </div>
                {isAdminOrOwner && (
                  <button
                    onClick={() => handleRevoke(i.id)}
                    className="text-xs text-red-600 hover:text-red-800"
                  >
                    {t({ he: 'ביטול', en: 'Revoke' })}
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
  const { t } = useI18n()
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
    if (
      !confirm(
        t({
          he: `למחוק את "${tenant.name}"? פעולה זו אינה ניתנת לביטול.`,
          en: `Delete workspace "${tenant.name}"? This cannot be undone.`,
        }),
      )
    )
      return
    try {
      await deleteTenant(tenantId)
      onDeleted()
    } catch (err) {
      alert(t({ he: 'נכשל: ', en: 'Failed: ' }) + (err as Error).message)
    }
  }

  async function handleTransfer(userId: number) {
    const member = members.find((m) => m.user_id === userId)
    if (!member) return
    if (
      !confirm(
        t({
          he: `להעביר בעלות אל ${member.full_name || member.email}? תהיה/י למנהל/ת.`,
          en: `Transfer ownership to ${member.full_name || member.email}? You will become an admin.`,
        }),
      )
    )
      return
    try {
      await transferTenantOwner(tenantId, userId)
      onChanged()
    } catch (err) {
      alert(t({ he: 'נכשל: ', en: 'Failed: ' }) + (err as Error).message)
    }
  }

  const otherMembers = members.filter((m) => m.user_id !== tenant.owner_user_id)

  return (
    <div className="space-y-6">
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {t({ he: 'כללי', en: 'General' })}
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t({ he: 'שם סביבת העבודה', en: 'Workspace name' })}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              dir="auto"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              disabled={!isOwner}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t({ he: 'אימייל לחיוב', en: 'Billing email' })}
            </label>
            <input
              type="email"
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
              dir="ltr"
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
              {saving
                ? t({ he: 'שומר…', en: 'Saving…' })
                : t({ he: 'שמירת שינויים', en: 'Save changes' })}
            </button>
          )}
        </div>
      </div>

      {isOwner && otherMembers.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            {t({ he: 'העברת בעלות', en: 'Transfer ownership' })}
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            {t({
              he: 'הפוך חבר/ת צוות אחר/ת לבעלים של סביבת העבודה. את/ה תהפוך/י למנהל/ת.',
              en: "Make another member the owner of this workspace. You'll become an admin.",
            })}
          </p>
          <div className="space-y-2">
            {otherMembers.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium text-gray-900" dir="auto">
                    {m.full_name || m.email}
                  </div>
                  <div className="text-xs text-gray-500" dir="ltr">
                    {m.email}
                  </div>
                </div>
                <button
                  onClick={() => handleTransfer(m.user_id)}
                  className="text-sm text-indigo-600 hover:text-indigo-800"
                >
                  {t({ he: 'העברה', en: 'Transfer' })}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {isOwner && (
        <div className="bg-white border border-red-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-red-900 mb-2">
            {t({ he: 'אזור מסוכן', en: 'Danger zone' })}
          </h2>
          <p className="text-sm text-gray-600 mb-4">
            {t({
              he: 'מחיקת סביבת העבודה מסירה את כל הסוכנים, החברים וההזמנות. חובה שתהיה לך לפחות סביבת עבודה אחת נוספת.',
              en: 'Deleting this workspace removes all agents, members, and invites. You must own at least one other workspace first.',
            })}
          </p>
          <button
            onClick={handleDelete}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700"
          >
            {t({ he: 'מחיקת סביבת העבודה', en: 'Delete workspace' })}
          </button>
        </div>
      )}
    </div>
  )
}
