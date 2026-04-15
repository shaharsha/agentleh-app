import { useCallback, useEffect, useState } from 'react'
import {
  disconnectGoogle,
  getAgentIntegrations,
  startGoogleConnect,
} from '../lib/api'
import type { IntegrationsResponse } from '../lib/types'

interface IntegrationsPanelProps {
  tenantId: number
  agentId: string
  /** Optional callback fired after a successful connect/disconnect so the
   *  parent can refetch its dashboard data (usage, etc). */
  onChange?: () => void
}

/**
 * Per-agent integrations card. Today it shows exactly one row — Google
 * Calendar + Gmail — but the shape is a dict keyed by integration type
 * so future additions (Notion, Slack, …) slot in without breaking the
 * contract.
 *
 * The component is collapsible, matching the `VoiceRow` pattern used
 * elsewhere in the dashboard.
 */
export default function IntegrationsPanel({
  tenantId,
  agentId,
  onChange,
}: IntegrationsPanelProps) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<IntegrationsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [loginHint, setLoginHint] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getAgentIntegrations(tenantId, agentId)
      setStatus(data)
    } catch (err) {
      setError((err as Error).message || 'Failed to load integrations')
    } finally {
      setLoading(false)
    }
  }, [tenantId, agentId])

  // First-open: fetch status.
  useEffect(() => {
    if (open && status === null && !loading) {
      void refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleConnect = async () => {
    // If already connected, ask for explicit confirmation before replacing.
    if (status?.integrations.google.connected) {
      const email = status.integrations.google.email
      const ok = window.confirm(
        `כבר מחובר כ-${email}.\nלחיבור חשבון אחר יוסר החיבור הנוכחי.\n\nלהמשיך?`,
      )
      if (!ok) return
    }

    setBusy(true)
    setError(null)
    try {
      const { connect_url } = await startGoogleConnect(tenantId, agentId, {
        login_hint: loginHint.trim() || undefined,
      })
      // Same-tab navigation — most reliable on mobile, no popup blockers.
      window.location.href = connect_url
    } catch (err) {
      setError((err as Error).message || 'Failed to start connect flow')
      setBusy(false)
    }
  }

  const handleDisconnect = async () => {
    const email = status?.integrations.google.connected
      ? status.integrations.google.email
      : ''
    const ok = window.confirm(
      `לנתק את ${email}?\n\nהסוכן לא יוכל יותר לנהל את היומן או לשלוח מיילים בשמך.`,
    )
    if (!ok) return

    setBusy(true)
    setError(null)
    try {
      await disconnectGoogle(tenantId, agentId)
      await refresh()
      onChange?.()
    } catch (err) {
      setError((err as Error).message || 'Failed to disconnect')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 border-t border-white/5 pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-[13px] text-text-secondary hover:text-text-primary transition"
      >
        <span className="flex items-center gap-2">
          {open ? '▼' : '▶'} <span>אינטגרציות</span>
          {status?.integrations.google.connected && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-success" />
          )}
        </span>
        <span className="text-text-muted">Google · יומן · מייל</span>
      </button>

      {open && (
        <div className="mt-3">
          {loading && (
            <div className="text-[13px] text-text-muted py-2">טוען…</div>
          )}
          {error && (
            <div className="rounded-[12px] bg-red-50 text-red-700 px-3 py-2 text-[13px]">
              {error}
            </div>
          )}
          {!loading && !error && status && (
            <GoogleIntegrationCard
              status={status.integrations.google}
              busy={busy}
              showAdvanced={showAdvanced}
              setShowAdvanced={setShowAdvanced}
              loginHint={loginHint}
              setLoginHint={setLoginHint}
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

const CAN_LABELS: Record<string, string> = {
  manage_calendar: 'ניהול יומן (יצירה, עדכון, מחיקה)',
  manage_events: 'ניהול אירועים',
  send_email: 'שליחת מיילים בשמך',
}

const CANNOT_LABELS: Record<string, string> = {
  read_email_bodies: 'לא יכול לקרוא את תוכן המיילים',
  read_email_metadata: 'לא יכול לראות נושאים של מיילים נכנסים',
  create_drafts: 'לא יכול ליצור טיוטות',
}

function GoogleIntegrationCard(props: {
  status: IntegrationsResponse['integrations']['google']
  busy: boolean
  showAdvanced: boolean
  setShowAdvanced: (v: boolean) => void
  loginHint: string
  setLoginHint: (v: string) => void
  onConnect: () => void
  onDisconnect: () => void
}) {
  const {
    status,
    busy,
    showAdvanced,
    setShowAdvanced,
    loginHint,
    setLoginHint,
    onConnect,
    onDisconnect,
  } = props

  if (!status.connected) {
    return (
      <div className="glass-card rounded-[14px] p-4 space-y-3">
        <div className="flex items-center gap-3">
          <GoogleLogo />
          <div className="flex-1">
            <div className="text-[14px] font-semibold">Google Calendar + Gmail</div>
            <div className="text-[12px] text-text-muted">
              הסוכן יוכל לנהל את היומן ולשלוח מיילים בשמך
            </div>
          </div>
        </div>

        <details
          open={showAdvanced}
          onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
          className="text-[12px] text-text-muted"
        >
          <summary className="cursor-pointer select-none py-1">
            מתקדם — לבחור חשבון מראש (אופציונלי)
          </summary>
          <input
            type="email"
            dir="ltr"
            placeholder="you@gmail.com"
            value={loginHint}
            onChange={(e) => setLoginHint(e.target.value)}
            className="input-glass mt-2 w-full px-3 py-2 text-[13px]"
          />
          <p className="mt-1 text-text-muted">
            אם יש לך כמה חשבונות גוגל, אפשר לבחור מראש איזה לחבר. משאירים ריק = Google
            יציג בחירה.
          </p>
        </details>

        <button
          type="button"
          onClick={onConnect}
          disabled={busy}
          className="btn-brand btn-md w-full disabled:opacity-60"
        >
          {busy ? 'מתחבר…' : 'חבר חשבון גוגל'}
        </button>
      </div>
    )
  }

  const { can, cannot } = status.capabilities

  return (
    <div className="glass-card rounded-[14px] p-4 space-y-3">
      <div className="flex items-center gap-3">
        <GoogleLogo />
        <div className="flex-1">
          <div className="text-[14px] font-semibold flex items-center gap-2">
            <span>Google Calendar + Gmail</span>
            <span className="text-success text-[16px]">✓</span>
          </div>
          <div className="text-[12px] text-text-muted" dir="ltr">
            {status.email}
          </div>
        </div>
      </div>

      {can.length > 0 && (
        <div>
          <div className="text-[12px] font-semibold text-text-secondary mb-1">
            ניתן לסוכן:
          </div>
          <ul className="text-[12px] text-text-muted space-y-0.5">
            {can.map((k) => (
              <li key={k} className="flex items-start gap-1.5">
                <span className="text-success">✓</span>
                <span>{CAN_LABELS[k] ?? k}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {cannot.length > 0 && (
        <div>
          <div className="text-[12px] font-semibold text-text-secondary mb-1">
            לא ניתן לסוכן:
          </div>
          <ul className="text-[12px] text-text-muted space-y-0.5">
            {cannot.map((k) => (
              <li key={k} className="flex items-start gap-1.5">
                <span className="text-text-muted">×</span>
                <span>{CANNOT_LABELS[k] ?? k}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {status.granted_at && (
        <div className="text-[11px] text-text-muted">
          חובר ב-{new Date(status.granted_at).toLocaleDateString('he-IL')}
        </div>
      )}

      <button
        type="button"
        onClick={onDisconnect}
        disabled={busy}
        className="btn-secondary btn-md w-full text-red-600 disabled:opacity-60"
      >
        {busy ? 'מנתק…' : 'נתק חשבון'}
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
