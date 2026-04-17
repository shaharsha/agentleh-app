import { useEffect, useMemo, useState } from 'react'
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
  deleteAgent,
  redeemCoupon,
  previewCoupon,
  CouponApiError,
  type CouponPreview,
} from '../lib/api'
import parsePhoneNumberFromString from 'libphonenumber-js'
import { useI18n, type Bilingual } from '../lib/i18n'
import { planLabel, statusLabel } from '../lib/labels'
import TenantName from '../components/TenantName'
import IntegrationsPanel from '../components/IntegrationsPanel'
import UsageTab from '../components/UsageTab'
import AuditTab from '../components/AuditTab'
import VoicePicker from '../components/VoicePicker'
import { microsToUsd } from '../lib/format'

interface Props {
  tenantId: number
  subpage: 'dashboard' | 'members' | 'settings' | 'usage' | 'audit'
  onNavigate: (path: string) => void
  onTenantsChanged: () => void
}

type Tab = 'dashboard' | 'members' | 'settings' | 'usage' | 'audit'

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

  // reload({ silent: true }) refetches in the background without flipping
  // the loading flag — keeps the UI mounted so the user doesn't see a
  // "Loading workspace…" screen every time something changes (e.g. after
  // creating an agent). Full-screen loader only fires on the initial
  // mount where we have nothing to show.
  const reload = async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true)
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
      if (!opts.silent) setLoading(false)
    }
  }

  const reloadSilent = () => { reload({ silent: true }) }

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
        : tab === 'usage'
          ? { he: 'שימוש', en: 'Usage' }
          : tab === 'audit'
            ? { he: 'יומן אירועים', en: 'Audit log' }
            : { he: 'הגדרות', en: 'Settings' }

  const tabButton = (tab: Tab) => (
    <button
      key={tab}
      onClick={() => setTab(tab)}
      className={`snap-start shrink-0 px-4 py-3 min-h-[44px] text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
        activeTab === tab
          ? 'border-indigo-600 text-indigo-600'
          : 'border-transparent text-text-muted hover:text-text-primary'
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
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="mb-5 sm:mb-6">
        <h1 className="text-[clamp(20px,5vw,24px)] font-bold text-text-primary break-words">
          <TenantName tenant={tenant} />
        </h1>
        <p className="text-sm text-text-muted mt-1">
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

      {/* Scroll-snap tab bar — bleeds to page edge on mobile so the
          trailing edge hints at more tabs when the row overflows. */}
      <div className="border-b border-border-light mb-6 flex gap-1 sm:gap-2 overflow-x-auto snap-x snap-mandatory scrollbar-hide -mx-4 sm:mx-0 px-4 sm:px-0">
        {tabButton('dashboard')}
        {tabButton('members')}
        {tabButton('usage')}
        {isAdminOrOwner && tabButton('audit')}
        {tabButton('settings')}
      </div>

      {activeTab === 'dashboard' && (
        <DashboardTab
          tenantId={tenantId}
          dashboard={dashboard}
          agents={agents}
          isAdminOrOwner={isAdminOrOwner}
          onChanged={reloadSilent}
          onNavigate={onNavigate}
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
          onChanged={reloadSilent}
        />
      )}
      {activeTab === 'usage' && <UsageTab tenantId={tenantId} />}
      {activeTab === 'audit' && isAdminOrOwner && <AuditTab tenantId={tenantId} />}
      {activeTab === 'settings' && (
        <SettingsTab
          tenantId={tenantId}
          tenant={tenant}
          members={members}
          isOwner={isOwner}
          onChanged={reloadSilent}
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
  onNavigate,
}: {
  tenantId: number
  dashboard: any
  agents: any[]
  isAdminOrOwner: boolean
  onChanged: () => void
  onNavigate: (path: string) => void
}) {
  const { t, dir } = useI18n()
  const subscription = dashboard?.subscription
  const totals = dashboard?.totals

  const [showNewAgent, setShowNewAgent] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [newAgentGender, setNewAgentGender] = useState<'female' | 'male'>('female')
  const [newAgentVoice, setNewAgentVoice] = useState('')
  const [newAgentPhone, setNewAgentPhone] = useState('')
  // Details about the *end user* this agent will chat with — separate
  // from the tenant admin filling out this form. Needed for Hebrew
  // grammar (agents conjugate verbs based on the addressee's gender),
  // and for personalization in the OpenClaw workspace prompt.
  const [newAgentUserName, setNewAgentUserName] = useState('')
  const [newAgentUserGender, setNewAgentUserGender] = useState<'' | 'female' | 'male'>('')
  const [phoneBlurred, setPhoneBlurred] = useState(false)
  const [provisioning, setProvisioning] = useState(false)
  const [provisionError, setProvisionError] = useState<string | null>(null)

  // Phone parsing: accept any format (Israeli local, international). Default
  // region IL so `050-123-4567` → +972501234567. Users can still paste any
  // country if they include the leading `+`.
  //
  // `asYouType` reformats the literal input as the user types so they see
  // digits grouped naturally. On blur we commit the formatted international
  // version (e.g. "+972 50 123 4567") to the input. The compact E.164 form
  // (no spaces) is what the backend stores — shown as a muted preview
  // below so users understand what we're saving.
  const parsedPhone = useMemo(() => {
    const raw = newAgentPhone.trim()
    if (!raw) return null
    return parsePhoneNumberFromString(raw, 'IL') ?? null
  }, [newAgentPhone])
  const phoneE164 = parsedPhone?.isValid() ? parsedPhone.number : null

  const handlePhoneBlur = () => {
    setPhoneBlurred(true)
    if (parsedPhone?.isValid()) {
      // Pretty-print in the input so the user's "0501234567" becomes
      // "+972 50 123 4567" — WYSIWYG with what we'll save (minus the spaces).
      setNewAgentPhone(parsedPhone.formatInternational())
    }
  }

  // Real progress driven by the NDJSON stream from the backend:
  //   { step: N, total: M, label: "..." }
  // step ≤ 0 means "connecting / waiting for first event"
  const [progress, setProgress] = useState<{ step: number; total: number; label: string }>({
    step: 0,
    total: 5,
    label: '',
  })

  // Translate backend English labels → bilingual display. The step number
  // is the source of truth; label text is for screen readers / fallback.
  // The VM emits sub-step labels like "Waiting for agent to be ready (3/30)"
  // during the health check; we surface those verbatim so the user sees
  // continuous activity even during the long wait.
  function stepLabel(_step: number, _total: number, rawLabel: string): { he: string; en: string } {
    const match = /Waiting for agent to be ready(?:\s*\((\d+)\/(\d+)\))?/.exec(rawLabel)
    if (match) {
      const sub = match[1] ? ` (${match[1]}/${match[2]})` : ''
      return { he: `בודק תקינות${sub}…`, en: `Waiting for agent to be ready${sub}…` }
    }
    if (/Preparing workspace/i.test(rawLabel)) return { he: 'מכין סביבת עבודה…', en: 'Preparing workspace…' }
    if (/Setting up database/i.test(rawLabel)) return { he: 'מעדכן בסיס נתונים…', en: 'Setting up database…' }
    if (/Starting container/i.test(rawLabel)) return { he: 'מפעיל קונטיינר…', en: 'Starting container…' }
    if (/welcome message/i.test(rawLabel)) return { he: 'שולח הודעת ברוכים הבאים…', en: 'Sending welcome message…' }
    return { he: rawLabel, en: rawLabel }
  }

  // Default label for a step that is not yet the active one (we haven't
  // seen its progress event yet). Keeps the checklist readable.
  function defaultStepLabel(step: number): string {
    return (
      [
        'Preparing workspace',
        'Setting up database',
        'Starting container',
        'Waiting for agent to be ready',
        'Sending welcome message',
      ][step - 1] || `Step ${step}`
    )
  }

  // Weighted progress — step 4 (health-check wait) dominates the real
  // elapsed time (~60-90s out of ~80-100s total), so give it a matching
  // slice of the bar. Never show 100% while still provisioning; reserve
  // the final % for the "done" moment when the success event arrives.
  //
  //   step 0 (connecting)    →  3%
  //   step 1 (workspace)     → 15%
  //   step 2 (database)      → 25%
  //   step 3 (container up)  → 35%
  //   step 4 (N/30 ticks)    → 35% + (N/30) * 50%  (up to 85%)
  //   step 5 (welcome send)  → 92%
  //   result(success)        → 100%
  const subMatch = /\((\d+)\/(\d+)\)/.exec(progress.label || '')
  const subTick = subMatch ? parseInt(subMatch[1], 10) : 0
  const subTotal = subMatch ? parseInt(subMatch[2], 10) : 30

  let progressPct: number
  if (!provisioning) {
    progressPct = 0
  } else if (progress.step === 0) {
    progressPct = 3
  } else if (progress.step === 1) {
    progressPct = 15
  } else if (progress.step === 2) {
    progressPct = 25
  } else if (progress.step === 3) {
    progressPct = 35
  } else if (progress.step === 4) {
    const sub = subTotal > 0 ? Math.min(1, subTick / subTotal) : 0
    progressPct = Math.round(35 + sub * 50)
  } else {
    progressPct = 92
  }

  async function handleProvision() {
    if (!newAgentName.trim() || !phoneE164) return
    setProvisioning(true)
    setProvisionError(null)
    setProgress({ step: 0, total: 5, label: 'Connecting…' })
    try {
      await provisionTenantAgent(
        tenantId,
        {
          agent_name: newAgentName.trim(),
          agent_gender: newAgentGender,
          phone: phoneE164,
          user_name: newAgentUserName.trim() || undefined,
          user_gender: newAgentUserGender || undefined,
          // Optional — backend falls back to the gender-matched default
          // (Kore for female, Puck for male) when omitted.
          tts_voice_name: newAgentVoice || undefined,
        },
        (p) => {
          setProgress({ step: p.step, total: p.total, label: p.label })
        },
      )
      setNewAgentName('')
      setNewAgentVoice('')
      setNewAgentPhone('')
      setNewAgentUserName('')
      setNewAgentUserGender('')
      setPhoneBlurred(false)
      setShowNewAgent(false)
      onChanged()
    } catch (err) {
      setProvisionError((err as Error).message)
    } finally {
      setProvisioning(false)
    }
  }

  // ── Agent deletion state ──
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function handleDeleteAgent() {
    if (!deletingAgentId) return
    setDeleteInProgress(true)
    setDeleteError(null)
    try {
      await deleteAgent(tenantId, deletingAgentId)
      setDeletingAgentId(null)
      onChanged()
    } catch (err) {
      setDeleteError((err as Error).message)
    } finally {
      setDeleteInProgress(false)
    }
  }

  // Numbers + currencies stay in LTR because the bidi algorithm flips
  // "$1.23" in RTL context in confusing ways. We wrap them in dir="ltr"
  // spans so they always read left-to-right.
  const num = (v: string) => <span dir="ltr">{v}</span>

  // Manage-plan drawer (redeem-coupon modal). Surfaces from the
  // Subscription card or from the no-active-subscription banner. Owner/
  // admin only — the redeem endpoint enforces this server-side.
  const [showRedeem, setShowRedeem] = useState(false)

  return (
    <div className="space-y-6">
      <div className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {t({ he: 'מנוי', en: 'Subscription' })}
          </h2>
          {isAdminOrOwner && (
            <button
              onClick={() => setShowRedeem(true)}
              className="px-3 py-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-800"
            >
              {subscription
                ? t({ he: 'נהל / שדרג', en: 'Manage / upgrade' })
                : t({ he: 'הפעל תוכנית', en: 'Activate plan' })}
            </button>
          )}
        </div>
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
          <div className="space-y-3">
            <p className="text-sm text-gray-500">
              {t({
                he: 'אין מנוי פעיל. כדי ליצור סוכנים יש להפעיל תוכנית באמצעות קוד קופון.',
                en: 'No active subscription. Activate a plan with a coupon code to create agents.',
              })}
            </p>
            {isAdminOrOwner && (
              <button
                onClick={() => setShowRedeem(true)}
                className="px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
              >
                {t({ he: 'הפעל תוכנית', en: 'Activate plan' })}
              </button>
            )}
          </div>
        )}
      </div>

      {showRedeem && (
        <RedeemCouponModal
          tenantId={tenantId}
          onClose={() => setShowRedeem(false)}
          onRedeemed={() => {
            setShowRedeem(false)
            onChanged()
          }}
        />
      )}

      <div className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {t({ he: 'סוכנים', en: 'Agents' })} ({agents.length})
          </h2>
          {isAdminOrOwner && subscription && (
            <button
              onClick={() => setShowNewAgent(!showNewAgent)}
              className="px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              {t({ he: 'סוכן חדש', en: 'New agent' })}
            </button>
          )}
          {isAdminOrOwner && !subscription && (
            <button
              onClick={() => setShowRedeem(true)}
              className="px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
              title={t({
                he: 'יש להפעיל תוכנית כדי ליצור סוכן',
                en: 'Activate a plan to create an agent',
              })}
            >
              {t({ he: 'הפעל תוכנית כדי להוסיף סוכן', en: 'Activate plan to add an agent' })}
            </button>
          )}
        </div>

        {showNewAgent && isAdminOrOwner && subscription && (
          <div className="mb-4 p-4 bg-gray-50 rounded-lg space-y-3">
            {provisioning ? (
              /* ── Real-time progress driven by backend NDJSON stream ── */
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm text-gray-700">
                  <span className="font-medium">
                    {t({ he: 'מקים סוכן…', en: 'Creating agent…' })}
                  </span>
                  <span className="tabular-nums text-gray-500">{progressPct}%</span>
                </div>
                {/* Long CSS transition (700ms) smooths out burst-delivered
                    events from GCP Cloud Run, which sometimes buffers a
                    few seconds of progress ticks before flushing them as
                    a batch. Without this the bar would teleport. */}
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-700 ease-out"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <ul className="space-y-2 text-sm">
                  {Array.from({ length: progress.total || 5 }).map((_, i) => {
                    const stepNum = i + 1
                    const done = progress.step > stepNum
                    const active = progress.step === stepNum
                    const label = active
                      ? stepLabel(stepNum, progress.total, progress.label)
                      : stepLabel(stepNum, progress.total, defaultStepLabel(stepNum))
                    // For the active health-check step (step 4, the long
                    // wait), extract the (N/30) sub-tick and render it as
                    // a small secondary bar so the user sees continuous
                    // motion during the 60-90s wait even when the main
                    // bar's range is small.
                    const isHealthStep = active && stepNum === 4 && subMatch
                    return (
                      <li key={i} className="flex items-start gap-2">
                        <div className="mt-0.5 shrink-0">
                          {done ? (
                            <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          ) : active ? (
                            <svg className="w-4 h-4 text-indigo-500 animate-spin" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                          ) : (
                            <div className="w-4 h-4 rounded-full border-2 border-gray-300" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className={done ? 'text-gray-400' : active ? 'text-gray-900 font-medium' : 'text-gray-400'}>
                            {t(label)}
                          </div>
                          {isHealthStep && (
                            <div className="mt-1 h-0.5 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-indigo-400 rounded-full transition-all duration-700 ease-out"
                                style={{ width: `${Math.round((subTick / subTotal) * 100)}%` }}
                              />
                            </div>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : (
              /* ── Agent creation form ── */
              <>
                {/* The user — who the agent will chat with on WhatsApp.
                    Separate from the tenant admin filling out this form
                    (who may be provisioning this agent for a colleague,
                    family member, or client). Gender is used for Hebrew
                    conjugation when the agent addresses them. */}
                <div className="pb-2">
                  <div className="text-xs font-semibold text-text-primary mb-2">
                    {t({ he: 'מי ישוחח עם הסוכן', en: "Who'll chat with this agent" })}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1">
                        {t({ he: 'שם המשתמש', en: 'User name' })}
                      </label>
                      <input
                        type="text"
                        value={newAgentUserName}
                        onChange={(e) => setNewAgentUserName(e.target.value)}
                        placeholder={t({ he: 'יוסי', en: 'e.g. Yossi' })}
                        dir={dir}
                        autoComplete="off"
                        className="input-glass w-full px-3 py-2.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1">
                        {t({ he: 'מגדר המשתמש', en: 'User gender' })}
                      </label>
                      <select
                        value={newAgentUserGender}
                        onChange={(e) => setNewAgentUserGender(e.target.value as '' | 'female' | 'male')}
                        className="input-glass w-full px-3 py-2.5 text-sm appearance-none"
                      >
                        <option value="">{t({ he: 'בחר…', en: 'Select…' })}</option>
                        <option value="female">{t({ he: 'נקבה', en: 'Female' })}</option>
                        <option value="male">{t({ he: 'זכר', en: 'Male' })}</option>
                      </select>
                    </div>
                  </div>
                  <p className="text-[11px] text-text-muted mt-1.5">
                    {t({
                      he: 'נשתמש במגדר כדי להתאים את פניית הסוכן בעברית (לשון זכר/נקבה).',
                      en: "Used so the agent addresses them with the correct Hebrew grammar.",
                    })}
                  </p>
                </div>

                {/* The agent itself */}
                <div className="text-xs font-semibold text-text-primary">
                  {t({ he: 'פרטי הסוכן', en: 'Agent details' })}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1">
                      {t({ he: 'שם הסוכן', en: 'Agent name' })}
                    </label>
                    <input
                      type="text"
                      value={newAgentName}
                      onChange={(e) => setNewAgentName(e.target.value)}
                      placeholder={t({ he: 'שולי', en: 'e.g. Shuli' })}
                      dir={dir}
                      autoComplete="off"
                      className="input-glass w-full px-3 py-2.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1">
                      {t({ he: 'מין הסוכן', en: 'Agent gender' })}
                    </label>
                    <select
                      value={newAgentGender}
                      onChange={(e) => setNewAgentGender(e.target.value as 'female' | 'male')}
                      className="input-glass w-full px-3 py-2.5 text-sm appearance-none"
                    >
                      <option value="female">{t({ he: 'נקבה', en: 'Female' })}</option>
                      <option value="male">{t({ he: 'זכר', en: 'Male' })}</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">
                    {t({ he: 'מספר הטלפון של הסוכן', en: "Agent's phone number" })}
                  </label>
                  <input
                    type="tel"
                    value={newAgentPhone}
                    onChange={(e) => {
                      setNewAgentPhone(e.target.value)
                      if (phoneBlurred) setPhoneBlurred(false)
                    }}
                    onBlur={handlePhoneBlur}
                    placeholder="050-123-4567"
                    autoComplete="tel"
                    inputMode="tel"
                    dir="ltr"
                    aria-invalid={phoneBlurred && !!newAgentPhone.trim() && !phoneE164}
                    aria-describedby="new-agent-phone-help"
                    className="input-glass w-full px-3 py-2.5 text-sm"
                  />
                  {phoneE164 ? (
                    <p id="new-agent-phone-help" className="text-[11px] text-text-muted mt-1">
                      {t({ he: 'יישמר כ-', en: 'Will save as ' })}
                      <span dir="ltr" className="font-mono text-text-primary">{phoneE164}</span>
                    </p>
                  ) : phoneBlurred && newAgentPhone.trim() ? (
                    <p id="new-agent-phone-help" className="text-[11px] text-red-600 mt-1">
                      {t({
                        he: 'מספר לא תקין — נסה שוב (למשל 050-123-4567)',
                        en: 'Not a valid phone number — try again (e.g. 050-123-4567)',
                      })}
                    </p>
                  ) : (
                    <p id="new-agent-phone-help" className="text-[11px] text-text-muted mt-1">
                      {t({
                        he: 'מספר ישראלי או בינלאומי, כל פורמט. לא המספר המשותף של Agentiko.',
                        en: "Israeli or international, any format. Not Agentiko's shared number.",
                      })}
                    </p>
                  )}
                </div>

                {/* Voice picker — matches the onboarding experience. Backend
                    defaults to the gender-matched voice (Kore/Puck) when
                    tts_voice_name is omitted, so the picker stays optional
                    even though we surface it as a default-selected choice. */}
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">
                    {t({ he: 'הקול של הסוכן', en: "Agent's voice" })}
                  </label>
                  <p className="text-[11px] text-text-muted mb-2">
                    {t({
                      he: 'לחץ על קול כדי לשמוע דגימה ולבחור אותו. הסוכן ישתמש בקול הזה בהודעות קוליות בוואטסאפ.',
                      en: "Tap a voice to preview and select it. Your agent uses it for WhatsApp voice messages.",
                    })}
                  </p>
                  <VoicePicker
                    value={newAgentVoice}
                    onChange={setNewAgentVoice}
                    lockedGender={newAgentGender}
                  />
                </div>

                {provisionError && (
                  <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 p-3 rounded">{provisionError}</div>
                )}
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    onClick={handleProvision}
                    disabled={!newAgentName.trim() || !phoneE164}
                    className="btn-brand btn-md flex-1 sm:flex-none disabled:opacity-50"
                  >
                    {t({ he: 'צור סוכן', en: 'Create agent' })}
                  </button>
                  <button
                    onClick={() => setShowNewAgent(false)}
                    className="btn-secondary btn-md"
                  >
                    {t({ he: 'ביטול', en: 'Cancel' })}
                  </button>
                </div>
              </>
            )}
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
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-1 bg-green-50 text-green-700 dark:text-green-300 rounded">
                      {t(statusLabel(a.status))}
                    </span>
                    {isAdminOrOwner && (
                      <button
                        onClick={() => { setDeletingAgentId(a.agent_id); setDeleteError(null) }}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        {t({ he: 'מחיקה', en: 'Delete' })}
                      </button>
                    )}
                  </div>
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
        <div className="bg-surface border border-border rounded-xl p-6">
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
          <button
            type="button"
            onClick={() => onNavigate(`/tenants/${tenantId}/usage`)}
            className="mt-4 text-sm text-indigo-600 hover:text-indigo-700 cursor-pointer"
          >
            {t({ he: 'פירוט מלא לפי סוכן ←', en: '→ Full breakdown by agent' })}
          </button>
        </div>
      )}

      {/* ── Delete Agent Confirmation Modal ── */}
      {deletingAgentId && (
        <DeleteAgentModal
          agentId={deletingAgentId}
          agentName={agents.find((a) => a.agent_id === deletingAgentId)?.agent_name || deletingAgentId}
          inProgress={deleteInProgress}
          error={deleteError}
          onConfirm={handleDeleteAgent}
          onCancel={() => { setDeletingAgentId(null); setDeleteError(null) }}
        />
      )}
    </div>
  )
}


function DeleteAgentModal({
  agentId,
  agentName,
  inProgress,
  error,
  onConfirm,
  onCancel,
}: {
  agentId: string
  agentName: string
  inProgress: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [confirmText, setConfirmText] = useState('')
  const confirmed = confirmText === agentId

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={inProgress ? undefined : onCancel} />
      {/* Modal */}
      <div className="relative bg-surface rounded-xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
        {/* Warning icon */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              {t({ he: 'מחיקת סוכן', en: 'Delete agent' })}
            </h3>
            <p className="text-sm text-gray-500" dir="auto">{agentName}</p>
          </div>
        </div>

        <p className="text-sm text-gray-700">
          {t({
            he: 'פעולה זו תמחק לצמיתות את הסוכן, הקונטיינר שלו, כל הנתונים וההגדרות. גיבוי ישמר ב-GCS למשך 90 יום. לא ניתן לבטל פעולה זו.',
            en: 'This will permanently delete the agent, its container, all data and configuration. A backup will be saved to GCS for 90 days. This cannot be undone.',
          })}
        </p>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            {t({
              he: 'הקלד את מזהה הסוכן לאישור:',
              en: 'Type the agent ID to confirm:',
            })}
          </label>
          <div className="text-xs text-gray-400 font-mono mb-1.5" dir="ltr">{agentId}</div>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={agentId}
            dir="ltr"
            disabled={inProgress}
            className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500"
          />
        </div>

        {error && (
          <div className="text-sm text-red-700 dark:text-red-300 bg-red-50 p-3 rounded">{error}</div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={inProgress}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
          >
            {t({ he: 'ביטול', en: 'Cancel' })}
          </button>
          <button
            onClick={onConfirm}
            disabled={!confirmed || inProgress}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
          >
            {inProgress && (
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {inProgress
              ? t({ he: 'מוחק…', en: 'Deleting…' })
              : t({ he: 'מחק לצמיתות', en: 'Delete permanently' })}
          </button>
        </div>
      </div>
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
      <div className="bg-surface border border-border rounded-xl p-6">
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
              <div className="text-sm text-green-700 dark:text-green-300 bg-green-50 p-3 rounded">
                {t({ he: 'ההזמנה נשלחה. קישור גיבוי: ', en: 'Email sent. Backup link: ' })}
                <a href={inviteLink} dir="ltr" className="underline break-all">
                  {inviteLink}
                </a>
              </div>
            )}
            {inviteStatus === 'link-only' && inviteLink && (
              <div className="text-sm text-amber-800 dark:text-amber-300 bg-amber-50 p-3 rounded">
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
        <div className="bg-surface border border-border rounded-xl p-6">
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
      <div className="bg-surface border border-border rounded-xl p-6">
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
        <div className="bg-surface border border-border rounded-xl p-6">
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
        <div className="bg-surface border border-red-200 rounded-xl p-6">
          <h2 className="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">
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

// ─── Redeem-coupon modal (used from the Subscription card) ─────────────
//
// Matches RedeemCouponPage's behaviour but lives inline so existing
// tenants can extend / upgrade without leaving the dashboard. Posts
// against the tenant_id of the page they're currently viewing — the
// server still enforces owner/admin role.

function RedeemCouponModal({
  tenantId,
  onClose,
  onRedeemed,
}: {
  tenantId: number
  onClose: () => void
  onRedeemed: () => void
}) {
  const { t } = useI18n()
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<CouponPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [redeeming, setRedeeming] = useState(false)
  const [redeemError, setRedeemError] = useState<string | null>(null)

  useEffect(() => {
    const trimmed = code.trim()
    if (trimmed.length < 6) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    const handle = setTimeout(async () => {
      try {
        const p = await previewCoupon(trimmed, tenantId)
        setPreview(p)
        setPreviewError(null)
      } catch (e) {
        setPreview(null)
        if (e instanceof CouponApiError) {
          setPreviewError(e.code)
        } else {
          setPreviewError('preview_failed')
        }
      }
    }, 350)
    return () => clearTimeout(handle)
  }, [code, tenantId])

  const errorMsgHe = (key: string): string => ({
    coupon_not_found: 'הקוד שהזנת לא קיים',
    coupon_disabled: 'הקופון הושבת',
    coupon_expired: 'הקופון פג תוקף',
    coupon_not_yet_valid: 'הקופון עדיין לא פעיל',
    coupon_exhausted: 'הקופון נוצל במלואו',
    coupon_already_redeemed: 'כבר השתמשת בקופון הזה',
    invalid_plan: 'תוכנית הקופון אינה תקפה',
    rate_limited: 'יותר מדי ניסיונות — נסה שוב בעוד דקה',
  }[key] || `שגיאה: ${key}`)

  const errorMsgEn = (key: string): string => ({
    coupon_not_found: 'Coupon code not found',
    coupon_disabled: 'Coupon is disabled',
    coupon_expired: 'Coupon has expired',
    coupon_not_yet_valid: 'Coupon is not yet active',
    coupon_exhausted: 'Coupon has been fully redeemed',
    coupon_already_redeemed: 'You have already redeemed this coupon',
    invalid_plan: 'Coupon plan is invalid',
    rate_limited: 'Too many attempts — try again in a minute',
  }[key] || `Error: ${key}`)

  async function handleSubmit() {
    setRedeeming(true)
    setRedeemError(null)
    try {
      await redeemCoupon(code.trim(), tenantId)
      onRedeemed()
    } catch (e) {
      if (e instanceof CouponApiError) {
        setRedeemError(e.code)
      } else {
        setRedeemError('redeem_failed')
      }
    } finally {
      setRedeeming(false)
    }
  }

  const canRedeem = !!preview && !preview.already_redeemed_by_user && !redeeming

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-xl max-w-md w-full p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">
            {t({ he: 'הפעלת קוד קופון', en: 'Redeem coupon code' })}
          </h3>
          <button onClick={onClose} className="text-gray-500 text-2xl">×</button>
        </div>

        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={t({ he: 'הזן קוד קופון', en: 'Enter coupon code' })}
          className="input-glass w-full font-mono tracking-wider uppercase"
          dir="ltr"
          autoFocus
        />

        {previewError && (
          <div className="p-3 rounded-lg bg-red-50 text-red-700 dark:text-red-300 text-sm">
            {t({ he: errorMsgHe(previewError), en: errorMsgEn(previewError) })}
          </div>
        )}

        {preview && !previewError && (
          <div className="p-4 rounded-lg bg-gray-50 border border-gray-200">
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">
              {t({ he: 'קופון זוהה', en: 'Coupon recognized' })}
            </div>
            <div className="text-base font-semibold">{preview.plan.name_he}</div>
            <div className="text-sm text-gray-600 mt-1">
              {preview.duration_days} {t({ he: 'ימים', en: 'days' })} ·{' '}
              {preview.schedule.kind === 'immediate' &&
                t({ he: 'יופעל מיד', en: 'activates immediately' })}
              {preview.schedule.kind === 'renewal' &&
                t({ he: 'יתווסף לתום התקופה', en: 'queued at period end' })}
              {preview.schedule.kind === 'upgrade_immediate' &&
                t({ he: 'שדרוג מיידי', en: 'immediate upgrade' })}
              {preview.schedule.kind === 'downgrade_queued' &&
                t({ he: 'יופעל בתום התקופה', en: 'starts at period end' })}
            </div>
            {preview.schedule.kind === 'upgrade_immediate' && (
              <div className="mt-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 rounded p-2">
                {t({
                  he: 'התוכנית הפעילה כעת תוחלף מיד.',
                  en: 'Your current active plan will be replaced immediately.',
                })}
              </div>
            )}
            {preview.already_redeemed_by_user && (
              <div className="mt-2 text-xs text-red-700 dark:text-red-300">
                {t({ he: 'כבר השתמשת בקוד זה.', en: 'You have already redeemed this code.' })}
              </div>
            )}
          </div>
        )}

        {redeemError && (
          <div className="p-3 rounded-lg bg-red-50 text-red-700 dark:text-red-300 text-sm">
            {t({ he: errorMsgHe(redeemError), en: errorMsgEn(redeemError) })}
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={!canRedeem}
          className="w-full px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {redeeming
            ? t({ he: 'מפעיל…', en: 'Redeeming…' })
            : t({ he: 'הפעל', en: 'Redeem' })}
        </button>
      </div>
    </div>
  )
}

