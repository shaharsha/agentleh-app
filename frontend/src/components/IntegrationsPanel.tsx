import { useCallback, useEffect, useRef, useState } from 'react'
import {
  disconnectGoogle,
  getAgentIntegrations,
  startGoogleConnect,
} from '../lib/api'
import { useI18n, type Bilingual } from '../lib/i18n'
import type { IntegrationsResponse } from '../lib/types'

interface IntegrationsPanelProps {
  tenantId: number
  agentId: string
  /** Optional callback fired after a successful connect/disconnect so the
   *  parent can refetch its dashboard data (usage, etc). */
  onChange?: () => void
}

// Poll cadence while a connect flow is in progress in a different tab.
// 3s is fast enough for a live-ish feel, slow enough to be gentle on the
// DB. 2 minutes is a generous ceiling — most real consent flows finish
// in 10-30 seconds.
const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 2 * 60 * 1_000

/**
 * Per-agent integrations card. Today it shows exactly one integration —
 * Google Calendar + Gmail — but the shape is a dict keyed by integration
 * type so future additions (Notion, Slack, …) slot in without breaking
 * the contract.
 *
 * Bilingual (he/en) via `useI18n` to match the rest of TenantPage. The
 * component is collapsible to match the compact agent-row style of the
 * tenant workspace. Connect-button click opens Google's consent screen
 * in a new tab and the panel polls for status so it flips to 'connected'
 * as soon as the user finishes the OAuth flow, without needing a page
 * refresh.
 */
export default function IntegrationsPanel({
  tenantId,
  agentId,
  onChange,
}: IntegrationsPanelProps) {
  const { t, lang } = useI18n()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<IntegrationsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [waitingForConsent, setWaitingForConsent] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [loginHint, setLoginHint] = useState('')
  // Capability selection — both checked by default. When user clicks
  // Connect, only the checked ones are requested from Google.
  const [wantCalendar, setWantCalendar] = useState(true)
  const [wantEmail, setWantEmail] = useState(true)
  // Poll state — cleared on unmount or when the poller resolves.
  const pollTimeoutRef = useRef<number | null>(null)
  const pollDeadlineRef = useRef<number>(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getAgentIntegrations(tenantId, agentId)
      setStatus(data)
      return data
    } catch (err) {
      setError(
        t({
          he: 'טעינת האינטגרציות נכשלה',
          en: 'Failed to load integrations',
        }) + ': ' + ((err as Error).message || ''),
      )
      return null
    } finally {
      setLoading(false)
    }
  }, [tenantId, agentId, t])

  // Eager initial fetch: we want the collapsed header to show the real
  // status (connected / not connected) without the user having to click
  // to expand. Cheap since the endpoint is a single indexed DB lookup.
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, agentId])

  // Clean up any in-flight poller on unmount.
  useEffect(() => {
    return () => {
      if (pollTimeoutRef.current != null) {
        window.clearTimeout(pollTimeoutRef.current)
        pollTimeoutRef.current = null
      }
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimeoutRef.current != null) {
      window.clearTimeout(pollTimeoutRef.current)
      pollTimeoutRef.current = null
    }
    setWaitingForConsent(false)
  }, [])

  const startPolling = useCallback(() => {
    setWaitingForConsent(true)
    pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS

    const tick = async () => {
      // Timed out — give up and let the user click Connect again.
      if (Date.now() > pollDeadlineRef.current) {
        stopPolling()
        setError(
          t({
            he: 'לא הצלחנו לזהות חיבור. נסה שוב או רענן את הדף.',
            en: "Couldn't detect a completed connection. Try again or refresh the page.",
          }),
        )
        return
      }
      try {
        const data = await getAgentIntegrations(tenantId, agentId)
        setStatus(data)
        if (data.integrations.google.connected) {
          stopPolling()
          onChange?.()
          return
        }
      } catch {
        // Swallow transient errors during polling — try again next tick.
      }
      pollTimeoutRef.current = window.setTimeout(tick, POLL_INTERVAL_MS)
    }

    pollTimeoutRef.current = window.setTimeout(tick, POLL_INTERVAL_MS)
  }, [tenantId, agentId, onChange, stopPolling, t])

  const handleConnect = async () => {
    if (!wantCalendar && !wantEmail) {
      window.alert(
        t({
          he: 'בחר לפחות הרשאה אחת',
          en: 'Select at least one permission',
        }),
      )
      return
    }

    // If already connected, ask for explicit confirmation before replacing.
    if (status?.integrations.google.connected) {
      const email = status.integrations.google.email
      const ok = window.confirm(
        t({
          he: `כבר מחובר כ-${email}.\nלחיבור חשבון אחר יוסר החיבור הנוכחי.\n\nלהמשיך?`,
          en: `Already connected as ${email}.\nConnecting a different account will replace the current one.\n\nContinue?`,
        }),
      )
      if (!ok) return
    }

    const capabilities: string[] = []
    if (wantCalendar) capabilities.push('calendar')
    if (wantEmail) capabilities.push('email')

    setBusy(true)
    setError(null)
    try {
      const { connect_url } = await startGoogleConnect(tenantId, agentId, {
        login_hint: loginHint.trim() || undefined,
        capabilities,
      })
      // Open in a NEW tab so this page stays put and can poll for
      // status. If the popup is blocked, `newTab` is null — fall back
      // to same-tab nav so the flow still works.
      const newTab = window.open(connect_url, '_blank')
      if (newTab == null) {
        // Popup blocked — preserve the old behavior.
        window.location.href = connect_url
        return
      }
      // Start polling the backend for status — the new tab will
      // eventually POST to /callback which writes the DB row.
      startPolling()
    } catch (err) {
      setError(
        t({
          he: 'התחלת חיבור נכשלה',
          en: 'Failed to start connect flow',
        }) + ': ' + ((err as Error).message || ''),
      )
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async () => {
    const email = status?.integrations.google.connected
      ? status.integrations.google.email
      : ''
    const ok = window.confirm(
      t({
        he: `לנתק את ${email}?\n\nהסוכן לא יוכל יותר לנהל את היומן או לשלוח מיילים בשמך.`,
        en: `Disconnect ${email}?\n\nThe agent will no longer be able to manage your calendar or send email on your behalf.`,
      }),
    )
    if (!ok) return

    setBusy(true)
    setError(null)
    try {
      await disconnectGoogle(tenantId, agentId)
      await refresh()
      onChange?.()
    } catch (err) {
      setError(
        t({ he: 'הניתוק נכשל', en: 'Disconnect failed' }) +
          ': ' +
          ((err as Error).message || ''),
      )
    } finally {
      setBusy(false)
    }
  }

  // Chevron that points AT the target. In LTR: ▶ (right). In RTL: ◀
  // (left). Open state is direction-agnostic: ▼ (down).
  const isRtl = lang === 'he'
  const chevron = open ? '▼' : isRtl ? '◀' : '▶'

  // Summary badge for the collapsed header. Always visible once we've
  // fetched status, so users immediately see whether this agent has
  // Google wired up without having to click to expand.
  const googleStatus = status?.integrations.google
  const connected = googleStatus?.connected === true

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-sm text-gray-600 hover:text-gray-900 transition"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden="true">{chevron}</span>
          <span>{t({ he: 'אינטגרציות', en: 'Integrations' })}</span>
        </span>
        {googleStatus == null ? (
          <span className="text-gray-400 text-xs">
            {loading
              ? t({ he: 'טוען…', en: 'Loading…' })
              : t({ he: 'גוגל · יומן · מייל', en: 'Google · Calendar · Mail' })}
          </span>
        ) : connected ? (
          <span className="flex items-center gap-1.5 text-xs text-green-700">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
            <span>
              {t({ he: 'גוגל מחובר', en: 'Google connected' })}
            </span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400" />
            <span>
              {t({ he: 'גוגל לא מחובר', en: 'Google not connected' })}
            </span>
          </span>
        )}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {loading && status === null && (
            <div className="text-sm text-gray-500 py-2">
              {t({ he: 'טוען…', en: 'Loading…' })}
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-50 text-red-700 px-3 py-2 text-sm">
              {error}
            </div>
          )}
          {waitingForConsent && (
            <div className="rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-900 px-3 py-2 text-sm flex items-center justify-between gap-3">
              <span>
                {t({
                  he: 'ממתין לאישור שלך בחלון הבא של גוגל…',
                  en: 'Waiting for you to approve in the Google tab…',
                })}
              </span>
              <button
                type="button"
                onClick={stopPolling}
                className="text-indigo-700 hover:text-indigo-900 text-xs font-medium underline"
              >
                {t({ he: 'ביטול', en: 'Cancel' })}
              </button>
            </div>
          )}
          {!error && status && (
            <GoogleIntegrationCard
              status={status.integrations.google}
              busy={busy || waitingForConsent}
              showAdvanced={showAdvanced}
              setShowAdvanced={setShowAdvanced}
              loginHint={loginHint}
              setLoginHint={setLoginHint}
              wantCalendar={wantCalendar}
              setWantCalendar={setWantCalendar}
              wantEmail={wantEmail}
              setWantEmail={setWantEmail}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Google card — rendered inside the panel when open
// ─────────────────────────────────────────────────────────────────────────

// Capability labels for the POST-CONNECT status display. Keys come from
// services/google_oauth.py::scopes_to_capabilities.
const CAN_LABELS: Record<string, Bilingual> = {
  manage_calendar: {
    he: 'ניהול יומן (יצירה, עדכון, מחיקה)',
    en: 'Manage calendar (create, update, delete)',
  },
  manage_events: {
    he: 'ניהול אירועים',
    en: 'Manage events',
  },
  send_email: {
    he: 'שליחת מיילים בשמך',
    en: 'Send email on your behalf',
  },
}

const CANNOT_LABELS: Record<string, Bilingual> = {
  read_email_bodies: {
    he: 'לא יכול לקרוא את תוכן המיילים',
    en: 'Cannot read email contents',
  },
  read_email_metadata: {
    he: 'לא יכול לראות נושאים של מיילים נכנסים',
    en: 'Cannot see incoming email subjects',
  },
  create_drafts: {
    he: 'לא יכול ליצור טיוטות',
    en: 'Cannot create drafts',
  },
}

function GoogleIntegrationCard(props: {
  status: IntegrationsResponse['integrations']['google']
  busy: boolean
  showAdvanced: boolean
  setShowAdvanced: (v: boolean) => void
  loginHint: string
  setLoginHint: (v: string) => void
  wantCalendar: boolean
  setWantCalendar: (v: boolean) => void
  wantEmail: boolean
  setWantEmail: (v: boolean) => void
  onConnect: () => void
  onDisconnect: () => void
}) {
  const { t } = useI18n()
  const {
    status,
    busy,
    showAdvanced,
    setShowAdvanced,
    loginHint,
    setLoginHint,
    wantCalendar,
    setWantCalendar,
    wantEmail,
    setWantEmail,
    onConnect,
    onDisconnect,
  } = props

  if (!status.connected) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-3">
          <GoogleLogo />
          <div className="flex-1">
            <div className="text-sm font-semibold text-gray-900">
              {t({
                he: 'גוגל: יומן + שליחת מיילים',
                en: 'Google: Calendar + Mail',
              })}
            </div>
            <div className="text-xs text-gray-500">
              {t({
                he: 'בחר אילו הרשאות לתת לסוכן',
                en: 'Choose which permissions to grant the agent',
              })}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={wantCalendar}
              onChange={(e) => setWantCalendar(e.target.checked)}
              className="mt-1"
            />
            <div>
              <div className="font-medium">
                {t({ he: 'יומן', en: 'Calendar' })}
              </div>
              <div className="text-xs text-gray-500">
                {t({
                  he: 'לראות, ליצור, לעדכן ולמחוק אירועים',
                  en: 'View, create, update, and delete events',
                })}
              </div>
            </div>
          </label>

          <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={wantEmail}
              onChange={(e) => setWantEmail(e.target.checked)}
              className="mt-1"
            />
            <div>
              <div className="font-medium">
                {t({ he: 'שליחת מיילים', en: 'Send email' })}
              </div>
              <div className="text-xs text-gray-500">
                {t({
                  he: 'שליחת מיילים בשמך (לא קריאה של התיבה)',
                  en: 'Send email on your behalf (not read your inbox)',
                })}
              </div>
            </div>
          </label>
        </div>

        <details
          open={showAdvanced}
          onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
          className="text-xs text-gray-500"
        >
          <summary className="cursor-pointer select-none py-1">
            {t({
              he: 'מתקדם — לבחור חשבון מראש (אופציונלי)',
              en: 'Advanced — pre-select a Google account (optional)',
            })}
          </summary>
          <input
            type="email"
            dir="ltr"
            placeholder="you@gmail.com"
            value={loginHint}
            onChange={(e) => setLoginHint(e.target.value)}
            className="mt-2 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <p className="mt-1 text-gray-500">
            {t({
              he: 'אם יש כמה חשבונות גוגל, אפשר לבחור מראש. ריק = גוגל יציג בחירה.',
              en: 'If you have multiple Google accounts, pre-select one. Leave empty = Google will ask.',
            })}
          </p>
        </details>

        <button
          type="button"
          onClick={onConnect}
          disabled={busy || (!wantCalendar && !wantEmail)}
          className="w-full px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy
            ? t({ he: 'מתחבר…', en: 'Connecting…' })
            : t({ he: 'חבר חשבון גוגל', en: 'Connect Google account' })}
        </button>
      </div>
    )
  }

  const { can, cannot } = status.capabilities

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-3">
        <GoogleLogo />
        <div className="flex-1">
          <div className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <span>{t({ he: 'גוגל', en: 'Google' })}</span>
            <span className="text-green-600">✓</span>
          </div>
          <div className="text-xs text-gray-500" dir="ltr">
            {status.email}
          </div>
        </div>
      </div>

      {can.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-1">
            {t({ he: 'ניתן לסוכן:', en: 'The agent can:' })}
          </div>
          <ul className="text-xs text-gray-600 space-y-0.5">
            {can.map((k) => (
              <li key={k} className="flex items-start gap-1.5">
                <span className="text-green-600">✓</span>
                <span>{CAN_LABELS[k] ? t(CAN_LABELS[k]) : k}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {cannot.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-1">
            {t({ he: 'לא ניתן לסוכן:', en: 'The agent cannot:' })}
          </div>
          <ul className="text-xs text-gray-500 space-y-0.5">
            {cannot.map((k) => (
              <li key={k} className="flex items-start gap-1.5">
                <span className="text-gray-400">×</span>
                <span>{CANNOT_LABELS[k] ? t(CANNOT_LABELS[k]) : k}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status.granted_at && (
        <div className="text-xs text-gray-400">
          {t({ he: 'חובר ב-', en: 'Connected on ' })}
          {new Date(status.granted_at).toLocaleDateString()}
        </div>
      )}

      <button
        type="button"
        onClick={onDisconnect}
        disabled={busy}
        className="w-full px-4 py-2 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
      >
        {busy
          ? t({ he: 'מנתק…', en: 'Disconnecting…' })
          : t({ he: 'נתק חשבון', en: 'Disconnect account' })}
      </button>
    </div>
  )
}

function GoogleLogo() {
  // Google's multicolor G, inline SVG so no external asset fetch.
  return (
    <svg width="28" height="28" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="#FFC107"
        d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"
      />
      <path
        fill="#FF3D00"
        d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"
      />
      <path
        fill="#1976D2"
        d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"
      />
    </svg>
  )
}
