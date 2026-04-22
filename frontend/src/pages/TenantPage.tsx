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
  checkPhoneAvailable,
  CouponApiError,
  type CouponPreview,
} from '../lib/api'
import parsePhoneNumberFromString from 'libphonenumber-js'
import { useI18n, type Bilingual } from '../lib/i18n'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { planLabel, statusLabel } from '../lib/labels'
import TenantName from '../components/TenantName'
import IntegrationsPanel from '../components/IntegrationsPanel'
import BridgesPanel from '../components/BridgesPanel'
import ChatPane from '../components/ChatPane'
import UsageTab from '../components/UsageTab'
import AuditTab from '../components/AuditTab'
import AgentScheduledTasksPanel from '../components/AgentScheduledTasksPanel'
import IntegrationsTab from '../components/IntegrationsTab'
import ProvisionProgressBar from '../components/ProvisionProgressBar'
import VoicePicker from '../components/VoicePicker'
import { RequiredMark } from '../components/RequiredMark'
import { DeleteAgentModal } from '../components/DeleteAgentModal'
import { microsToUsd } from '../lib/format'

interface Props {
  tenantId: number
  subpage: 'dashboard' | 'members' | 'settings' | 'usage' | 'audit' | 'integrations'
  onNavigate: (path: string) => void
  onTenantsChanged: () => void
}

type Tab = 'dashboard' | 'members' | 'settings' | 'usage' | 'audit' | 'integrations'

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

  // NB: hooks MUST run before the loading/error/null-detail early returns
  // below. Putting useDocumentTitle after those returns caused the hook
  // count to jump (7 → 8) between the loading render and the loaded
  // render, violating Rules of Hooks and crashing TenantPage whenever
  // the page mounted fresh (e.g. navigating in from onboarding).
  const tabLabel = (tab: Tab): Bilingual =>
    tab === 'dashboard'
      ? { he: 'לוח בקרה', en: 'Dashboard' }
      : tab === 'members'
        ? { he: 'חברים', en: 'Members' }
        : tab === 'usage'
          ? { he: 'שימוש', en: 'Usage' }
          : tab === 'audit'
            ? { he: 'יומן אירועים', en: 'Audit log' }
            : tab === 'integrations'
            ? { he: 'חיבורים', en: 'Integrations' }
            : { he: 'הגדרות', en: 'Settings' }

  const tenantDisplayName = detail?.tenant.name?.trim() || ''
  const activeTabLabel = t(tabLabel(activeTab))
  useDocumentTitle(
    tenantDisplayName ? `${tenantDisplayName} · ${activeTabLabel}` : activeTabLabel,
  )

  if (loading) {
    return (
      <div className="p-8 text-text-muted">
        {t({ he: 'טוען סביבת עבודה…', en: 'Loading workspace…' })}
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-8 text-danger">
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

  const tabButton = (tab: Tab) => (
    <button
      key={tab}
      onClick={() => setTab(tab)}
      className={`snap-start shrink-0 px-4 py-3 min-h-[44px] text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
        activeTab === tab
          ? 'border-brand text-brand'
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
        {tabButton('integrations')}
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
      {activeTab === 'integrations' && (
        <IntegrationsTab
          tenantId={tenantId}
          agents={agents.map(a => ({ agent_id: a.agent_id, agent_name: a.agent_name || a.agent_id }))}
          isAdminOrOwner={isAdminOrOwner}
        />
      )}
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
  // Duplicate-phone check: the create-agent form pre-flights the phone
  // against /api/agents/check-phone on blur so a collision with another
  // tenant's agent surfaces before the user hits submit. `null` = not
  // yet checked, `true` = available, `false` = taken. Checking state
  // mirrors the debounce window — submit stays disabled while we're
  // mid-flight so the user can't race the check.
  const [phoneAvailable, setPhoneAvailable] = useState<boolean | null>(null)
  const [phoneChecking, setPhoneChecking] = useState(false)
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

  // Reset the duplicate-check cache whenever the phone changes so the
  // old result doesn't get shown against a new number. The effect
  // below re-fetches after a debounce window.
  useEffect(() => {
    setPhoneAvailable(null)
  }, [phoneE164])

  // Debounced pre-flight duplicate-phone check. Only fires when the
  // parsed number is valid — invalid input shows its own error path
  // and there's no point hitting the server. 400ms debounce feels
  // responsive without spamming during fast typing.
  useEffect(() => {
    if (!phoneE164) return
    setPhoneChecking(true)
    const handle = setTimeout(async () => {
      try {
        const res = await checkPhoneAvailable(phoneE164)
        setPhoneAvailable(res.available)
      } catch {
        // Transient — submit's 409 fallback still catches real
        // conflicts. Don't block UX on a network blip.
        setPhoneAvailable(null)
      } finally {
        setPhoneChecking(false)
      }
    }, 400)
    return () => {
      clearTimeout(handle)
      setPhoneChecking(false)
    }
  }, [phoneE164])

  const handlePhoneBlur = () => {
    setPhoneBlurred(true)
    if (parsedPhone?.isValid()) {
      // Pretty-print in the input so the user's "0501234567" becomes
      // "+972 50 123 4567" — WYSIWYG with what we'll save (minus the spaces).
      setNewAgentPhone(parsedPhone.formatInternational())
    }
  }

  // Modal UX: Escape closes the new-agent modal, but only when not
  // mid-provisioning — the NDJSON stream would orphan otherwise.
  useEffect(() => {
    if (!showNewAgent) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !provisioning) setShowNewAgent(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showNewAgent, provisioning])

  // Lock body scroll while the modal is open so the background doesn't
  // scroll through the backdrop on tall forms.
  useEffect(() => {
    if (!showNewAgent) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [showNewAgent])

  // Real progress driven by the NDJSON stream from the backend:
  //   { step: N, total: M, label: "..." }
  // step ≤ 0 means "connecting / waiting for first event"
  const [progress, setProgress] = useState<{ step: number; total: number; label: string }>({
    step: 0,
    total: 5,
    label: '',
  })

  // Progress-bar translation + weighting lives in ProvisionProgressBar
  // so the onboarding flow renders identical progress.

  // Submit is allowed when:
  //   - the agent name is non-empty, AND
  //   - either the phone field is empty (create without a bridge), OR
  //     the phone is a valid E.164 AND not currently a duplicate.
  // We don't require phoneAvailable === true because a transient
  // /check-phone failure returns null — in that case we let the user
  // submit and rely on the backend 409 to catch real conflicts.
  const rawPhoneFilled = newAgentPhone.trim().length > 0
  const phoneIsOk =
    !rawPhoneFilled || (phoneE164 !== null && phoneAvailable !== false && !phoneChecking)
  const canProvision = newAgentName.trim().length > 0 && phoneIsOk

  async function handleProvision() {
    if (!canProvision) return
    setProvisioning(true)
    setProvisionError(null)
    // When creating without a phone, skip the "Sending welcome message"
    // tick so the progress bar ends at step 4/4 instead of 5/5.
    const totalSteps = phoneE164 ? 5 : 4
    setProgress({ step: 0, total: totalSteps, label: 'Connecting…' })
    try {
      await provisionTenantAgent(
        tenantId,
        {
          agent_name: newAgentName.trim(),
          agent_gender: newAgentGender,
          // Omit entirely (not empty string) when the user didn't enter
          // a phone — mirrors the backend's Optional[str] contract.
          phone: phoneE164 ?? undefined,
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
      setPhoneAvailable(null)
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

  // ── Web-chat slide-over state ──
  // Opened from BridgesPanel's "Open chat" action. A single slot — only
  // one chat at a time. Storing the full row lets us render the agent
  // name in the chat header without a separate lookup.
  const [chatAgent, setChatAgent] = useState<{ agent_id: string; agent_name: string } | null>(null)

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
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">
            {t({ he: 'מנוי', en: 'Subscription' })}
          </h2>
          {isAdminOrOwner && (
            <button
              onClick={() => setShowRedeem(true)}
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand rounded-lg hover:bg-brand-dark"
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
              <div className="text-text-muted">{t({ he: 'תכנית', en: 'Plan' })}</div>
              <div className="font-medium text-text-primary">
                {t(planLabel(subscription.plan_id))}
              </div>
            </div>
            <div>
              <div className="text-text-muted">{t({ he: 'סטטוס', en: 'Status' })}</div>
              <div className="font-medium text-text-primary">
                {t(statusLabel(subscription.status))}
              </div>
            </div>
            <div>
              <div className="text-text-muted">
                {t({ he: 'שימוש בתקופה הנוכחית', en: 'Used this period' })}
              </div>
              <div className="font-medium text-text-primary">
                {num(microsToUsd(subscription.used_micros))}{' / '}
                {num(microsToUsd(subscription.base_allowance_micros))}
              </div>
            </div>
            <div>
              <div className="text-text-muted">{t({ he: 'חריגה', en: 'Overage' })}</div>
              <div className="font-medium text-text-primary">
                {num(microsToUsd(subscription.overage_used_micros))}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-text-muted">
            {t({
              he: 'אין מנוי פעיל. כדי ליצור סוכנים יש להפעיל תוכנית באמצעות קוד קופון.',
              en: 'No active subscription. Activate a plan with a coupon code to create agents.',
            })}
          </p>
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

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">
            {t({ he: 'סוכנים', en: 'Agents' })} ({agents.length})
          </h2>
          {isAdminOrOwner && subscription && (
            <button
              onClick={() => setShowNewAgent(!showNewAgent)}
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand rounded-lg hover:bg-brand-dark"
            >
              {t({ he: 'סוכן חדש', en: 'New agent' })}
            </button>
          )}
          {isAdminOrOwner && !subscription && (
            <button
              onClick={() => setShowRedeem(true)}
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand rounded-lg hover:bg-brand-dark"
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
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(14, 19, 32, 0.40)' }}
            onClick={() => { if (!provisioning) setShowNewAgent(false) }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-agent-title"
          >
            <div
              className="glass-thick animate-dialog-in w-full max-w-[640px] max-h-[90vh] overflow-y-auto rounded-2xl p-8 space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <h3 id="new-agent-title" className="text-lg font-semibold text-text-primary">
                  {t({ he: 'סוכן חדש', en: 'New agent' })}
                </h3>
                {!provisioning && (
                  <button
                    onClick={() => setShowNewAgent(false)}
                    className="text-text-muted hover:text-text-primary text-2xl leading-none"
                    aria-label={t({ he: 'סגור', en: 'Close' })}
                  >
                    ×
                  </button>
                )}
              </div>
            {provisioning ? (
              <ProvisionProgressBar
                progress={progress}
                provisioning={provisioning}
                heading={t({ he: 'מקים סוכן…', en: 'Creating agent…' })}
              />
            ) : (
              /* ── Agent creation form ── */
              <>
                {/* The user — who the agent will chat with on WhatsApp.
                    Separate from the tenant admin filling out this form
                    (who may be provisioning this agent for a colleague,
                    family member, or client). Gender is used for Hebrew
                    conjugation when the agent addresses them. */}
                <div className="pb-2 space-y-3">
                  <div className="text-xs font-semibold text-text-primary">
                    {t({ he: 'מי ישוחח עם הסוכן', en: "Who'll chat with this agent" })}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1">
                        {t({ he: 'שם המשתמש — לא חובה', en: 'User name — optional' })}
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
                        {t({ he: 'מגדר המשתמש — לא חובה', en: 'User gender — optional' })}
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
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1">
                      {t({
                        he: 'מספר הטלפון של המשתמש (וואטסאפ) — לא חובה',
                        en: "User's phone number (WhatsApp) — optional",
                      })}
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
                      aria-invalid={
                        (phoneBlurred && !!newAgentPhone.trim() && !phoneE164) ||
                        phoneAvailable === false
                      }
                      aria-describedby="new-agent-phone-help"
                      className="input-glass w-full px-3 py-2.5 text-sm"
                    />
                    {/* Render the most specific error first:
                        1. duplicate-phone (backend says taken)
                        2. invalid phone (libphonenumber can't parse)
                        3. valid + "will save as …" preview
                        4. empty + helper description */}
                    {phoneAvailable === false ? (
                      <p
                        id="new-agent-phone-help"
                        className="text-[11px] text-danger dark:text-red-300 mt-1"
                      >
                        {t({
                          he: 'מספר זה כבר משויך לסוכן אחר. כל מספר טלפון יכול להיות מחובר לסוכן אחד בלבד.',
                          en: 'This phone is already connected to another agent. Each phone can only be connected to one agent.',
                        })}
                      </p>
                    ) : phoneBlurred && newAgentPhone.trim() && !phoneE164 ? (
                      <p
                        id="new-agent-phone-help"
                        className="text-[11px] text-danger dark:text-red-300 mt-1"
                      >
                        {t({
                          he: 'מספר לא תקין — נסה שוב (למשל 050-123-4567)',
                          en: 'Not a valid phone number — try again (e.g. 050-123-4567)',
                        })}
                      </p>
                    ) : phoneE164 ? (
                      <p id="new-agent-phone-help" className="text-[11px] text-text-muted mt-1">
                        {t({ he: 'יישמר כ-', en: 'Will save as ' })}
                        <span dir="ltr" className="font-mono text-text-primary">{phoneE164}</span>
                        {phoneChecking && (
                          <span className="ms-2 opacity-60">
                            {t({ he: '(בודק…)', en: '(checking…)' })}
                          </span>
                        )}
                      </p>
                    ) : (
                      <p id="new-agent-phone-help" className="text-[11px] text-text-muted mt-1">
                        {t({
                          he: 'אפשר להשאיר ריק ולחבר וואטסאפ מאוחר יותר מתוך לשונית "גשרים" של הסוכן.',
                          en: 'Leave empty to create without WhatsApp — you can connect it later from the agent\'s Bridges panel.',
                        })}
                      </p>
                    )}
                  </div>
                  <p className="text-[11px] text-text-muted">
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
                      <RequiredMark />
                    </label>
                    <input
                      type="text"
                      value={newAgentName}
                      onChange={(e) => setNewAgentName(e.target.value)}
                      placeholder={t({ he: 'שולי', en: 'e.g. Shuli' })}
                      dir={dir}
                      autoComplete="off"
                      required
                      aria-required="true"
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

                {/* Voice picker — matches the onboarding experience. Backend
                    defaults to the gender-matched voice (Kore/Puck) when
                    tts_voice_name is omitted, so the picker stays optional
                    even though we surface it as a default-selected choice. */}
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">
                    {t({ he: 'הקול של הסוכן — לא חובה', en: "Agent's voice — optional" })}
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
                  <div className="text-sm text-danger dark:text-red-300 bg-danger-light p-3 rounded">{provisionError}</div>
                )}
                {/* BRAND §18 footer: trailing-aligned, cancel on leading side,
                    primary on trailing so Hebrew readers land on the primary
                    action at their natural reading end. */}
                <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
                  <button
                    onClick={() => setShowNewAgent(false)}
                    className="btn-secondary btn-md"
                  >
                    {t({ he: 'ביטול', en: 'Cancel' })}
                  </button>
                  <button
                    onClick={handleProvision}
                    disabled={!canProvision}
                    className="btn-brand btn-md disabled:opacity-50"
                  >
                    {t({ he: 'צור סוכן', en: 'Create agent' })}
                  </button>
                </div>
              </>
            )}
            </div>
          </div>
        )}

        {agents.length === 0 ? (
          <p className="text-sm text-text-muted">
            {t({ he: 'אין עדיין סוכנים.', en: 'No agents yet.' })}
          </p>
        ) : (
          <div className="divide-y divide-gray-100">
            {agents.map((a) => (
              <div key={a.agent_id} className="py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-text-primary" dir="auto">
                      {a.agent_name}
                    </div>
                    <div className="text-xs text-text-muted font-mono" dir="ltr">
                      {a.agent_id}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-1 bg-success-light text-success dark:text-green-300 rounded">
                      {t(statusLabel(a.status))}
                    </span>
                    {isAdminOrOwner && (
                      <button
                        onClick={() => { setDeletingAgentId(a.agent_id); setDeleteError(null) }}
                        className="text-xs text-danger hover:text-danger"
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
                <BridgesPanel
                  tenantId={tenantId}
                  agentId={a.agent_id}
                  canEdit={isAdminOrOwner}
                  onOpenChat={() => setChatAgent({ agent_id: a.agent_id, agent_name: a.agent_name })}
                />
                <AgentScheduledTasksPanel
                  tenantId={tenantId}
                  agentId={a.agent_id}
                  canCancel={isAdminOrOwner}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {totals && (
        <div className="card">
          <h2 className="text-lg font-semibold text-text-primary mb-4">
            {t({ he: 'פירוט שימוש', en: 'Usage breakdown' })}
          </h2>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-text-muted">{t({ he: 'מודל שפה', en: 'LLM' })}</div>
              <div className="font-medium">{num(microsToUsd(totals.llm_micros))}</div>
            </div>
            <div>
              <div className="text-text-muted">{t({ he: 'חיפוש', en: 'Search' })}</div>
              <div className="font-medium">{num(microsToUsd(totals.search_micros))}</div>
            </div>
            <div>
              <div className="text-text-muted">{t({ he: 'קול', en: 'Voice (TTS)' })}</div>
              <div className="font-medium">{num(microsToUsd(totals.tts_micros))}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate(`/tenants/${tenantId}/usage`)}
            className="mt-4 text-sm text-brand hover:text-brand-dark cursor-pointer"
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

      {/* ── Web-chat slide-over ── */}
      {chatAgent && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex justify-end"
          onClick={() => setChatAgent(null)}
        >
          <div
            className="bg-surface w-full sm:w-[480px] h-full shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-2 border-b border-border">
              <button
                onClick={() => setChatAgent(null)}
                className="text-xs text-text-secondary hover:text-text-primary px-2 py-1"
              >
                ✕ {t({ he: 'סגור', en: 'Close' })}
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <ChatPane
                tenantId={tenantId}
                agentId={chatAgent.agent_id}
                agentName={chatAgent.agent_name}
              />
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
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">
            {t({ he: 'חברים', en: 'Members' })} ({members.length})
          </h2>
          {isAdminOrOwner && (
            <button
              onClick={() => setShowInvite(!showInvite)}
              className="px-3 py-1.5 text-sm font-medium text-white bg-brand rounded-lg hover:bg-brand-dark"
            >
              {t({ he: 'הזמנה', en: 'Invite' })}
            </button>
          )}
        </div>

        {showInvite && isAdminOrOwner && (
          <div className="mb-4 p-4 bg-surface-soft rounded-lg space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="name@example.com"
                dir="ltr"
                className="flex-1 px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                className="px-3 py-2 text-sm border border-border rounded-lg"
              >
                <option value="member">{roleOptionLabel('member')}</option>
                <option value="admin">{roleOptionLabel('admin')}</option>
              </select>
              <button
                onClick={handleInvite}
                disabled={inviteStatus === 'sending'}
                className="px-4 py-2 text-sm font-medium text-white bg-brand rounded-lg hover:bg-brand-dark disabled:opacity-50"
              >
                {inviteStatus === 'sending'
                  ? t({ he: 'שולח…', en: 'Sending…' })
                  : t({ he: 'שליחת הזמנה', en: 'Send invite' })}
              </button>
            </div>
            {inviteStatus === 'sent' && inviteLink && (
              <div className="text-sm text-success dark:text-green-300 bg-success-light p-3 rounded">
                {t({ he: 'ההזמנה נשלחה. קישור גיבוי: ', en: 'Email sent. Backup link: ' })}
                <a href={inviteLink} dir="ltr" className="underline break-all">
                  {inviteLink}
                </a>
              </div>
            )}
            {inviteStatus === 'link-only' && inviteLink && (
              <div className="text-sm text-warning dark:text-amber-300 bg-warning-light p-3 rounded">
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
              <div className="text-sm text-danger bg-danger-light p-3 rounded">
                {inviteStatus.slice(6)}
              </div>
            )}
          </div>
        )}

        <div className="divide-y divide-gray-100">
          {members.map((m) => (
            <div key={m.user_id} className="py-3 flex items-center justify-between">
              <div>
                <div className="font-medium text-text-primary" dir="auto">
                  {m.full_name || m.email}
                </div>
                <div className="text-xs text-text-muted" dir="ltr">
                  {m.email}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-text-secondary uppercase">
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
                      className="text-xs border border-border rounded px-2 py-1"
                    >
                      <option value="member">{roleOptionLabel('member')}</option>
                      <option value="admin">{roleOptionLabel('admin')}</option>
                    </select>
                    <button
                      onClick={() => handleRemove(m.user_id)}
                      className="text-xs text-danger hover:text-danger"
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
        <div className="card">
          <h2 className="text-lg font-semibold text-text-primary mb-4">
            {t({ he: 'הזמנות ממתינות', en: 'Pending invites' })} ({pendingInvites.length})
          </h2>
          <div className="divide-y divide-gray-100">
            {pendingInvites.map((i) => (
              <div key={i.id} className="py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium text-text-primary" dir="ltr">
                    {i.email}
                  </div>
                  <div className="text-xs text-text-muted">
                    {roleOptionLabel(i.role)} ·{' '}
                    {t({ he: 'תוקף עד ', en: 'expires ' })}
                    {new Date(i.expires_at).toLocaleDateString('en-GB')}
                  </div>
                </div>
                {isAdminOrOwner && (
                  <button
                    onClick={() => handleRevoke(i.id)}
                    className="text-xs text-danger hover:text-danger"
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
      <div className="card">
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          {t({ he: 'כללי', en: 'General' })}
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              {t({ he: 'שם סביבת העבודה', en: 'Workspace name' })}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              dir="auto"
              className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
              disabled={!isOwner}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              {t({ he: 'אימייל לחיוב', en: 'Billing email' })}
            </label>
            <input
              type="email"
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
              dir="ltr"
              className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
              disabled={!isOwner}
            />
          </div>
          {error && <div className="text-sm text-danger">{error}</div>}
          {isOwner && (
            <button
              onClick={handleSave}
              disabled={saving || (name === tenant.name && billingEmail === tenant.billing_email)}
              className="px-4 py-2 text-sm font-medium text-white bg-brand rounded-lg hover:bg-brand-dark disabled:opacity-50"
            >
              {saving
                ? t({ he: 'שומר…', en: 'Saving…' })
                : t({ he: 'שמירת שינויים', en: 'Save changes' })}
            </button>
          )}
        </div>
      </div>

      {isOwner && otherMembers.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-text-primary mb-2">
            {t({ he: 'העברת בעלות', en: 'Transfer ownership' })}
          </h2>
          <p className="text-sm text-text-muted mb-4">
            {t({
              he: 'הפוך חבר/ת צוות אחר/ת לבעלים של סביבת העבודה. את/ה תהפוך/י למנהל/ת.',
              en: "Make another member the owner of this workspace. You'll become an admin.",
            })}
          </p>
          <div className="space-y-2">
            {otherMembers.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium text-text-primary" dir="auto">
                    {m.full_name || m.email}
                  </div>
                  <div className="text-xs text-text-muted" dir="ltr">
                    {m.email}
                  </div>
                </div>
                <button
                  onClick={() => handleTransfer(m.user_id)}
                  className="text-sm text-brand hover:text-brand-dark"
                >
                  {t({ he: 'העברה', en: 'Transfer' })}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {isOwner && (
        <div className="card border-danger/40">
          <h2 className="text-lg font-semibold text-danger dark:text-red-200 mb-2">
            {t({ he: 'אזור מסוכן', en: 'Danger zone' })}
          </h2>
          <p className="text-sm text-text-secondary mb-4">
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
  // State shape changed from bare `string` codes to `{code, detail}`
  // tuples so we can surface `detail.message_he` / `detail.message`
  // from the backend when the code is unmapped. Without this an
  // unexpected 500 renders as "שגיאה: internal" instead of the real
  // cause the server already included in the response body.
  type CouponErrState = { code: string; detail?: Record<string, unknown> } | null
  const [previewError, setPreviewError] = useState<CouponErrState>(null)
  const [redeeming, setRedeeming] = useState(false)
  const [redeemError, setRedeemError] = useState<CouponErrState>(null)

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
          setPreviewError({ code: e.code, detail: e.detail })
        } else {
          setPreviewError({ code: 'preview_failed' })
        }
      }
    }, 350)
    return () => clearTimeout(handle)
  }, [code, tenantId])

  const ERROR_HE: Record<string, string> = {
    coupon_not_found: 'הקוד שהזנת לא קיים',
    coupon_disabled: 'הקופון הושבת',
    coupon_expired: 'הקופון פג תוקף',
    coupon_not_yet_valid: 'הקופון עדיין לא פעיל',
    coupon_exhausted: 'הקופון נוצל במלואו',
    coupon_already_redeemed: 'כבר השתמשת בקופון הזה',
    invalid_plan: 'תוכנית הקופון אינה תקפה',
    rate_limited: 'יותר מדי ניסיונות — נסה שוב בעוד דקה',
  }
  const ERROR_EN: Record<string, string> = {
    coupon_not_found: 'Coupon code not found',
    coupon_disabled: 'Coupon is disabled',
    coupon_expired: 'Coupon has expired',
    coupon_not_yet_valid: 'Coupon is not yet active',
    coupon_exhausted: 'Coupon has been fully redeemed',
    coupon_already_redeemed: 'You have already redeemed this coupon',
    invalid_plan: 'Coupon plan is invalid',
    rate_limited: 'Too many attempts — try again in a minute',
  }
  const errorMsgHe = (err: CouponErrState): string => {
    if (!err) return ''
    const mapped = ERROR_HE[err.code]
    if (mapped) return mapped
    const detailMsg = (err.detail?.message_he || err.detail?.message) as string | undefined
    return `שגיאה: ${detailMsg || err.code}`
  }
  const errorMsgEn = (err: CouponErrState): string => {
    if (!err) return ''
    const mapped = ERROR_EN[err.code]
    if (mapped) return mapped
    const detailMsg = (err.detail?.message || err.detail?.message_he) as string | undefined
    return `Error: ${detailMsg || err.code}`
  }

  async function handleSubmit() {
    setRedeeming(true)
    setRedeemError(null)
    try {
      await redeemCoupon(code.trim(), tenantId)
      onRedeemed()
    } catch (e) {
      if (e instanceof CouponApiError) {
        setRedeemError({ code: e.code, detail: e.detail })
      } else {
        setRedeemError({ code: 'redeem_failed' })
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
          <button onClick={onClose} className="text-text-muted text-2xl">×</button>
        </div>

        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={t({ he: 'הזן קוד קופון', en: 'Enter coupon code' })}
          className="input-glass w-full px-4 py-3 font-mono tracking-wider uppercase placeholder:normal-case placeholder:font-sans placeholder:tracking-normal"
          dir="ltr"
          autoFocus
        />

        {previewError && (
          <div className="p-3 rounded-lg bg-danger-light text-danger dark:text-red-300 text-sm">
            {t({ he: errorMsgHe(previewError), en: errorMsgEn(previewError) })}
          </div>
        )}

        {preview && !previewError && (
          <div className="p-4 rounded-lg bg-surface-soft border border-border-light">
            <div className="text-xs uppercase tracking-wide text-text-muted mb-1">
              {t({ he: 'קופון זוהה', en: 'Coupon recognized' })}
            </div>
            <div className="text-base font-semibold">{preview.plan.name_he}</div>
            <div className="text-sm text-text-secondary mt-1">
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
              <div className="mt-2 text-xs text-warning dark:text-amber-300 bg-warning-light rounded p-2">
                {t({
                  he: 'התוכנית הפעילה כעת תוחלף מיד.',
                  en: 'Your current active plan will be replaced immediately.',
                })}
              </div>
            )}
            {preview.already_redeemed_by_user && (
              <div className="mt-2 text-xs text-danger dark:text-red-300">
                {t({ he: 'כבר השתמשת בקוד זה.', en: 'You have already redeemed this code.' })}
              </div>
            )}
          </div>
        )}

        {redeemError && (
          <div className="p-3 rounded-lg bg-danger-light text-danger dark:text-red-300 text-sm">
            {t({ he: errorMsgHe(redeemError), en: errorMsgEn(redeemError) })}
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={!canRedeem}
          className="w-full px-4 py-2 text-sm font-medium text-white bg-brand rounded-lg hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {redeeming
            ? t({ he: 'מפעיל…', en: 'Redeeming…' })
            : t({ he: 'הפעל', en: 'Redeem' })}
        </button>
      </div>
    </div>
  )
}

