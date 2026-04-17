import { useCallback, useEffect, useState } from 'react'
import parsePhoneNumberFromString from 'libphonenumber-js'
import {
  checkPhoneAvailable,
  connectTelegramBridge,
  disconnectTelegramBridge,
  getAgentBridges,
  getTelegramManagedStatus,
  patchWhatsappBridge,
  startTelegramManagedConnect,
  testTelegramBridge,
  type BridgesResponse,
  type TelegramManagedStart,
} from '../lib/api'
import { useI18n } from '../lib/i18n'

interface BridgesPanelProps {
  tenantId: number
  agentId: string
  canEdit: boolean
  /** Callback to navigate to the embedded chat pane. We delegate instead
   *  of using a bare anchor so the parent can wire it into the same router
   *  it uses for the rest of the page. */
  onOpenChat?: () => void
}

/**
 * Per-agent bridges card — sibling of IntegrationsPanel, same structural
 * pattern (collapsible header with status chip + count, expanded body
 * with per-row sections). Three bridges: WhatsApp (optional),
 * Telegram (paste-token), Web Chat (always on, routes to ChatPane).
 */
export default function BridgesPanel({
  tenantId,
  agentId,
  canEdit,
  onOpenChat,
}: BridgesPanelProps) {
  const { t, dir } = useI18n()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<BridgesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getAgentBridges(tenantId, agentId)
      setData(res)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [tenantId, agentId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const wa = data?.bridges.whatsapp
  const tg = data?.bridges.telegram
  const connectedCount =
    (wa?.enabled ? 1 : 0) + (tg?.enabled ? 1 : 0) + 1 /* web always on */

  // ── WhatsApp modal state ───────────────────────────────────────
  const [waModalOpen, setWaModalOpen] = useState(false)
  const [waPhoneInput, setWaPhoneInput] = useState('')
  const [waPhoneAvailable, setWaPhoneAvailable] = useState<boolean | null>(null)
  const [waPhoneChecking, setWaPhoneChecking] = useState(false)
  const [waBusy, setWaBusy] = useState(false)
  const [waError, setWaError] = useState<string | null>(null)

  const waParsed = waPhoneInput.trim()
    ? parsePhoneNumberFromString(waPhoneInput.trim(), 'IL') ?? null
    : null
  const waE164 = waParsed?.isValid() ? waParsed.number : null

  useEffect(() => {
    if (!waE164) {
      setWaPhoneAvailable(null)
      return
    }
    // If we're editing an already-connected number and the user retypes
    // exactly the same digits, don't mark it as duplicate.
    const currentDigits = (wa?.phone || '').replace(/\D/g, '')
    const nextDigits = waE164.replace(/\D/g, '')
    if (currentDigits && currentDigits === nextDigits) {
      setWaPhoneAvailable(true)
      return
    }
    setWaPhoneChecking(true)
    const handle = window.setTimeout(async () => {
      try {
        const res = await checkPhoneAvailable(waE164)
        setWaPhoneAvailable(res.available)
      } catch {
        setWaPhoneAvailable(null)
      } finally {
        setWaPhoneChecking(false)
      }
    }, 400)
    return () => {
      window.clearTimeout(handle)
      setWaPhoneChecking(false)
    }
  }, [waE164, wa?.phone])

  function openWhatsappModal(prefill?: string | null) {
    setWaPhoneInput(prefill || '')
    setWaPhoneAvailable(null)
    setWaError(null)
    setWaModalOpen(true)
  }

  async function saveWhatsapp() {
    if (!waE164) return
    setWaBusy(true)
    setWaError(null)
    try {
      const res = await patchWhatsappBridge(tenantId, agentId, waE164)
      setData(res)
      setWaModalOpen(false)
    } catch (err) {
      setWaError((err as Error).message)
    } finally {
      setWaBusy(false)
    }
  }

  async function disconnectWhatsapp() {
    if (!window.confirm(
      t({
        he: 'האם לנתק את הבוט מ-WhatsApp? המספר יתפנה לסוכן אחר.',
        en: 'Disconnect this agent from WhatsApp? The phone will be freed for another agent.',
      })
    )) return
    setWaBusy(true)
    try {
      const res = await patchWhatsappBridge(tenantId, agentId, null)
      setData(res)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setWaBusy(false)
    }
  }

  // ── Telegram modal state ───────────────────────────────────────
  const [tgModalOpen, setTgModalOpen] = useState(false)
  // Modal has two views: the default one-tap "Quick connect" (QR +
  // deep-link + polling) and the collapsed paste-token fallback.
  const [tgTab, setTgTab] = useState<'quick' | 'paste'>('quick')
  const [tgToken, setTgToken] = useState('')
  const [tgBusy, setTgBusy] = useState(false)
  const [tgError, setTgError] = useState<string | null>(null)
  const [tgTestResult, setTgTestResult] = useState<string | null>(null)
  // Quick-connect state: the backend-issued deep-link + polling status
  const [tgManaged, setTgManaged] = useState<TelegramManagedStart | null>(null)
  const [tgManagedStatus, setTgManagedStatus] = useState<
    'idle' | 'waiting' | 'connected' | 'error' | 'expired'
  >('idle')
  const [tgManagedStartedAt, setTgManagedStartedAt] = useState<number | null>(null)

  function openTelegramModal() {
    setTgToken('')
    setTgError(null)
    setTgTab('quick')
    setTgManaged(null)
    setTgManagedStatus('idle')
    setTgManagedStartedAt(null)
    setTgModalOpen(true)
  }

  // Kick off the Quick-Connect deep-link + start polling. Fired when
  // the user opens the modal (if we're on the 'quick' tab) OR when
  // they manually click "Try again" after a timeout.
  async function startQuickConnect() {
    setTgError(null)
    setTgManaged(null)
    setTgManagedStatus('waiting')
    try {
      const res = await startTelegramManagedConnect(tenantId, agentId)
      setTgManaged(res)
      setTgManagedStartedAt(Date.now())
    } catch (err) {
      setTgManagedStatus('error')
      setTgError((err as Error).message)
    }
  }

  // Poll the backend for completion once a Quick-Connect is in flight.
  // 2s cadence is a reasonable balance — fast enough to feel live, not
  // so fast it hammers the DB. Stops on connected/error/expired or
  // when the modal closes.
  useEffect(() => {
    if (!tgModalOpen || tgTab !== 'quick' || tgManaged === null) return
    if (tgManagedStatus !== 'waiting') return
    let cancelled = false
    const startedAt = tgManagedStartedAt ?? Date.now()
    const deadline = startedAt + (tgManaged.expires_in_seconds || 900) * 1000
    const tick = async () => {
      if (cancelled) return
      if (Date.now() > deadline) {
        setTgManagedStatus('expired')
        return
      }
      try {
        const res = await getTelegramManagedStatus(tenantId, agentId)
        if (cancelled) return
        if (res.status === 'connected') {
          setTgManagedStatus('connected')
          // Refresh the parent bridges row so the collapsed header
          // reflects the new Telegram connection immediately.
          void refresh()
          // Auto-close shortly after so the user sees the success
          // state register.
          window.setTimeout(() => {
            if (!cancelled) setTgModalOpen(false)
          }, 1500)
          return
        }
        if (res.status === 'error') {
          setTgManagedStatus('error')
          setTgError(res.error)
          return
        }
      } catch (err) {
        // Transient — keep polling, but surface the last error in case
        // it's persistent.
        setTgError((err as Error).message)
      }
      window.setTimeout(tick, 2_000)
    }
    const timer = window.setTimeout(tick, 1_000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [tgModalOpen, tgTab, tgManaged, tgManagedStatus, tgManagedStartedAt, tenantId, agentId, refresh])

  // Auto-start Quick-Connect as soon as the modal opens on the quick tab.
  useEffect(() => {
    if (!tgModalOpen) return
    if (tgTab !== 'quick') return
    if (tgManaged !== null) return
    if (tgManagedStatus !== 'idle') return
    void startQuickConnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgModalOpen, tgTab])

  async function saveTelegram() {
    const token = tgToken.trim()
    if (!token) return
    setTgBusy(true)
    setTgError(null)
    try {
      const res = await connectTelegramBridge(tenantId, agentId, token)
      setData(res)
      setTgModalOpen(false)
    } catch (err) {
      setTgError((err as Error).message)
    } finally {
      setTgBusy(false)
    }
  }

  async function testTelegram() {
    setTgTestResult(null)
    try {
      const res = await testTelegramBridge(tenantId, agentId)
      if (res.ok) {
        setTgTestResult(
          t({
            he: `החיבור תקין (@${res.bot_username || '?'})`,
            en: `Connection OK (@${res.bot_username || '?'})`,
          }),
        )
      } else {
        setTgTestResult(
          t({ he: 'הטוקן אינו תקין: ', en: 'Token invalid: ' }) + (res.detail || res.error || ''),
        )
      }
      // Clear after 6s so the row doesn't stay mottled with the test
      // result indefinitely.
      window.setTimeout(() => setTgTestResult(null), 6_000)
    } catch (err) {
      setTgTestResult((err as Error).message)
    }
  }

  async function disconnectTelegram() {
    if (!window.confirm(
      t({
        he: 'האם לנתק את Telegram? הסוכן יפסיק לקבל הודעות בטלגרם. הבוט עצמו ישאר בחשבון הטלגרם שלך.',
        en: 'Disconnect Telegram? The agent will stop receiving Telegram messages. The bot itself stays in your Telegram account.',
      })
    )) return
    setTgBusy(true)
    try {
      const res = await disconnectTelegramBridge(tenantId, agentId)
      setData(res)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setTgBusy(false)
    }
  }

  return (
    <div className="mt-2" dir={dir}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-xs text-text-secondary hover:text-text-primary py-2"
      >
        <span className="flex items-center gap-2">
          <span
            className={
              'inline-block h-1.5 w-1.5 rounded-full ' +
              ((wa?.enabled || tg?.enabled)
                ? 'bg-green-500'
                : 'bg-gray-400')
            }
          />
          <span>{t({ he: 'גשרים', en: 'Bridges' })}</span>
          <span className="text-[11px] text-text-muted">
            {connectedCount}/3 {t({ he: 'מחוברים', en: 'connected' })}
          </span>
        </span>
        <span>{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-3 rounded-lg border border-border bg-surface/60 p-3">
          {error && (
            <div className="text-xs text-red-600 dark:text-red-300">{error}</div>
          )}
          {loading && !data && (
            <div className="text-xs text-text-muted">
              {t({ he: 'טוען…', en: 'Loading…' })}
            </div>
          )}

          {/* WhatsApp */}
          {wa && (
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <span className="text-lg" aria-hidden>💬</span>
                <div>
                  <div className="text-sm font-medium text-text-primary">WhatsApp</div>
                  <div className="text-[11px] text-text-muted">
                    {wa.enabled ? (
                      <span dir="ltr" className="font-mono">{wa.phone}</span>
                    ) : (
                      t({ he: 'לא מחובר', en: 'Disconnected' })
                    )}
                  </div>
                </div>
              </div>
              {canEdit && (
                <div className="flex flex-col gap-1 items-end">
                  {wa.enabled ? (
                    <>
                      <button
                        onClick={() => openWhatsappModal(wa.phone)}
                        className="text-xs text-indigo-600 hover:text-indigo-700"
                      >
                        {t({ he: 'ערוך מספר', en: 'Edit phone' })}
                      </button>
                      <button
                        onClick={disconnectWhatsapp}
                        disabled={waBusy}
                        className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                      >
                        {t({ he: 'ניתוק', en: 'Disconnect' })}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => openWhatsappModal(null)}
                      className="text-xs text-green-600 hover:text-green-700"
                    >
                      {t({ he: 'חיבור', en: 'Connect' })}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Telegram */}
          {tg && (
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <span className="text-lg" aria-hidden>✈</span>
                <div>
                  <div className="text-sm font-medium text-text-primary">Telegram</div>
                  <div className="text-[11px] text-text-muted">
                    {tg.enabled ? (
                      <a
                        href={`https://t.me/${tg.bot_username || ''}`}
                        target="_blank"
                        rel="noreferrer"
                        dir="ltr"
                        className="font-mono text-indigo-600 hover:underline"
                      >
                        @{tg.bot_username}
                      </a>
                    ) : (
                      t({ he: 'לא מחובר', en: 'Disconnected' })
                    )}
                    {tgTestResult && (
                      <div className="mt-0.5 text-[11px] text-text-primary">{tgTestResult}</div>
                    )}
                  </div>
                </div>
              </div>
              {canEdit && (
                <div className="flex flex-col gap-1 items-end">
                  {tg.enabled ? (
                    <>
                      <button
                        onClick={testTelegram}
                        className="text-xs text-indigo-600 hover:text-indigo-700"
                      >
                        {t({ he: 'בדיקה', en: 'Test' })}
                      </button>
                      <button
                        onClick={openTelegramModal}
                        className="text-xs text-indigo-600 hover:text-indigo-700"
                      >
                        {t({ he: 'עדכן טוקן', en: 'Update token' })}
                      </button>
                      <button
                        onClick={disconnectTelegram}
                        disabled={tgBusy}
                        className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                      >
                        {t({ he: 'ניתוק', en: 'Disconnect' })}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={openTelegramModal}
                      className="text-xs text-green-600 hover:text-green-700"
                    >
                      {t({ he: 'חיבור', en: 'Connect' })}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Web Chat — always enabled, no configuration */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-lg" aria-hidden>🌐</span>
              <div>
                <div className="text-sm font-medium text-text-primary">
                  {t({ he: "צ'אט בדפדפן", en: 'Web Chat' })}
                </div>
                <div className="text-[11px] text-text-muted">
                  {t({ he: 'פעיל תמיד', en: 'Always on' })}
                </div>
              </div>
            </div>
            <button
              onClick={onOpenChat}
              className="text-xs text-indigo-600 hover:text-indigo-700"
            >
              {t({ he: 'פתח צ\'אט', en: 'Open chat' })}
            </button>
          </div>
        </div>
      )}

      {/* ── WhatsApp connect/edit modal ── */}
      {waModalOpen && (
        <Modal onClose={() => setWaModalOpen(false)}>
          <h3 className="text-sm font-semibold mb-3">
            {t({ he: 'חיבור WhatsApp', en: 'Connect WhatsApp' })}
          </h3>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t({ he: 'מספר טלפון', en: 'Phone number' })}
          </label>
          <input
            type="tel"
            value={waPhoneInput}
            onChange={(e) => setWaPhoneInput(e.target.value)}
            onBlur={() => {
              if (waParsed?.isValid()) setWaPhoneInput(waParsed.formatInternational())
            }}
            placeholder="050-123-4567"
            dir="ltr"
            autoFocus
            className="input-glass w-full px-3 py-2.5 text-sm"
          />
          {waPhoneAvailable === false ? (
            <p className="text-[11px] text-red-600 dark:text-red-300 mt-1">
              {t({
                he: 'מספר זה כבר משויך לסוכן אחר. כל מספר טלפון יכול להיות מחובר לסוכן אחד בלבד.',
                en: 'This phone is already connected to another agent. Each phone can only be connected to one agent.',
              })}
            </p>
          ) : waE164 ? (
            <p className="text-[11px] text-text-muted mt-1">
              {t({ he: 'יישמר כ-', en: 'Will save as ' })}
              <span dir="ltr" className="font-mono">{waE164}</span>
              {waPhoneChecking && (
                <span className="ms-2 opacity-60">{t({ he: '(בודק…)', en: '(checking…)' })}</span>
              )}
            </p>
          ) : waPhoneInput.trim() ? (
            <p className="text-[11px] text-red-600 dark:text-red-300 mt-1">
              {t({
                he: 'מספר לא תקין — נסה שוב (למשל 050-123-4567)',
                en: 'Not a valid phone number — try again (e.g. 050-123-4567)',
              })}
            </p>
          ) : null}
          {waError && (
            <p className="text-xs text-red-600 dark:text-red-300 mt-2">{waError}</p>
          )}
          <div className="flex gap-2 mt-4">
            <button
              onClick={saveWhatsapp}
              disabled={!waE164 || waBusy || waPhoneAvailable === false || waPhoneChecking}
              className="btn-brand btn-sm disabled:opacity-50"
            >
              {waBusy
                ? t({ he: 'שומר…', en: 'Saving…' })
                : t({ he: 'שמור', en: 'Save' })}
            </button>
            <button
              onClick={() => setWaModalOpen(false)}
              className="btn-secondary btn-sm"
            >
              {t({ he: 'ביטול', en: 'Cancel' })}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Telegram connect modal ── */}
      {tgModalOpen && (
        <Modal onClose={() => setTgModalOpen(false)}>
          <h3 className="text-sm font-semibold mb-3">
            {t({ he: 'חיבור Telegram', en: 'Connect Telegram' })}
          </h3>

          {/* Tab switcher */}
          <div className="flex gap-1 mb-4 text-xs">
            <button
              className={
                'px-3 py-1 rounded-full ' +
                (tgTab === 'quick'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-text-secondary')
              }
              onClick={() => setTgTab('quick')}
            >
              {t({ he: 'חיבור מהיר', en: 'Quick connect' })}
            </button>
            <button
              className={
                'px-3 py-1 rounded-full ' +
                (tgTab === 'paste'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-text-secondary')
              }
              onClick={() => setTgTab('paste')}
            >
              {t({ he: 'יש לי בוט קיים', en: 'I have an existing bot' })}
            </button>
          </div>

          {tgTab === 'quick' ? (
            <TelegramQuickConnect
              managed={tgManaged}
              status={tgManagedStatus}
              onRetry={() => {
                setTgManaged(null)
                setTgManagedStatus('idle')
              }}
              onPasteToken={() => setTgTab('paste')}
              error={tgError}
              t={t}
            />
          ) : (
            <>
              <details className="text-[11px] text-text-muted mb-3" open>
                <summary className="cursor-pointer">
                  {t({ he: 'איך יוצרים בוט? (4 שלבים)', en: 'How to create a bot (4 steps)' })}
                </summary>
                <ol className="list-decimal ps-5 mt-2 space-y-0.5">
                  <li>
                    {t({ he: 'פתח את ', en: 'Open ' })}
                    <a
                      href="https://t.me/BotFather"
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-600 hover:underline"
                    >@BotFather</a>
                    {t({ he: ' בטלגרם', en: ' on Telegram' })}
                  </li>
                  <li>
                    {t({ he: 'שלח ', en: 'Send ' })}
                    <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">/newbot</code>
                  </li>
                  <li>
                    {t({
                      he: 'תן לבוט שם תצוגה ושם משתמש שמסתיים ב-bot',
                      en: "Give the bot a display name and a username ending in 'bot'",
                    })}
                  </li>
                  <li>
                    {t({
                      he: 'העתק את ה-token שתקבל והדבק כאן למטה',
                      en: "Copy the token BotFather returns and paste it below",
                    })}
                  </li>
                </ol>
              </details>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                {t({ he: 'Token של הבוט', en: 'Bot token' })}
              </label>
              <input
                type="text"
                value={tgToken}
                onChange={(e) => setTgToken(e.target.value)}
                placeholder="123456789:ABC-..."
                dir="ltr"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className="input-glass w-full px-3 py-2.5 text-sm font-mono"
              />
              {tgError && (
                <p className="text-xs text-red-600 dark:text-red-300 mt-2">{tgError}</p>
              )}
              <div className="flex gap-2 mt-4">
                <button
                  onClick={saveTelegram}
                  disabled={!tgToken.trim() || tgBusy}
                  className="btn-brand btn-sm disabled:opacity-50"
                >
                  {tgBusy
                    ? t({ he: 'בודק ושומר…', en: 'Testing & saving…' })
                    : t({ he: 'בדיקה ושמירה', en: 'Test & save' })}
                </button>
                <button
                  onClick={() => setTgModalOpen(false)}
                  className="btn-secondary btn-sm"
                >
                  {t({ he: 'ביטול', en: 'Cancel' })}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}

// Minimal shared modal wrapper. The rest of TenantPage uses inline
// fixed-positioned modals directly, but the Bridges panel mounts two
// different ones conditionally, so a tiny reusable shell keeps this
// component readable.
function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-surface text-text-primary rounded-lg shadow-lg max-w-md w-full mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

// Quick-Connect body (one-tap Managed Bots flow). Mounts inside the
// Telegram modal when the user is on the 'quick' tab. Shows:
//   - issuing deep-link → spinner
//   - deep-link ready → big "Open in Telegram" button + QR code
//   - connected → checkmark + close
//   - expired / error → retry button + "paste token instead" link
function TelegramQuickConnect({
  managed,
  status,
  error,
  onRetry,
  onPasteToken,
  t,
}: {
  managed: TelegramManagedStart | null
  status: 'idle' | 'waiting' | 'connected' | 'error' | 'expired'
  error: string | null
  onRetry: () => void
  onPasteToken: () => void
  t: (b: { he: string; en: string }) => string
}) {
  if (status === 'connected') {
    return (
      <div className="text-center py-6">
        <div className="text-4xl mb-2">✓</div>
        <p className="text-sm text-text-primary">
          {t({ he: 'הבוט נוצר והסוכן מחובר!', en: 'Bot created and agent connected!' })}
        </p>
      </div>
    )
  }

  if (status === 'error' || status === 'expired') {
    return (
      <div className="text-center py-4">
        <p className="text-sm text-red-600 dark:text-red-300 mb-3">
          {status === 'expired'
            ? t({
                he: 'הזמן שהוקצב להשלמה עבר. נסה שוב.',
                en: 'The connection window expired. Try again.',
              })
            : error ||
              t({
                he: 'משהו השתבש — נסה שוב',
                en: 'Something went wrong — try again',
              })}
        </p>
        <div className="flex gap-2 justify-center">
          <button onClick={onRetry} className="btn-brand btn-sm">
            {t({ he: 'נסה שוב', en: 'Try again' })}
          </button>
          <button onClick={onPasteToken} className="btn-secondary btn-sm">
            {t({ he: 'הדבקת טוקן ידנית', en: 'Paste token manually' })}
          </button>
        </div>
      </div>
    )
  }

  if (managed === null) {
    return (
      <div className="text-center py-8">
        <div className="animate-pulse text-sm text-text-muted">
          {t({ he: 'מייצר קישור…', en: 'Generating link…' })}
        </div>
      </div>
    )
  }

  // Public QR renderer. Using api.qrserver.com keeps the bundle lean —
  // no JS QR encoder dep. The deep-link is just a t.me URL so there's
  // nothing sensitive in the request to the QR service. If we ever
  // want first-party QR rendering, `qrcode.react` drops in here.
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=${encodeURIComponent(
    managed.deep_link,
  )}`

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-muted">
        {t({
          he: 'פתח את טלגרם ואשר את יצירת הבוט. נחכה לך כאן.',
          en: 'Open Telegram and confirm bot creation. We\'ll wait here.',
        })}
      </p>

      <a
        href={managed.deep_link}
        target="_blank"
        rel="noreferrer"
        className="btn-brand btn-md w-full flex items-center justify-center gap-2"
      >
        ✈ {t({ he: 'פתח בטלגרם', en: 'Open in Telegram' })}
      </a>

      <div className="flex items-center gap-3">
        <div className="flex-1 border-t border-border" />
        <span className="text-[11px] text-text-muted">
          {t({ he: 'או סרוק בטלפון', en: 'or scan on your phone' })}
        </span>
        <div className="flex-1 border-t border-border" />
      </div>

      <div className="flex justify-center">
        <img
          src={qrSrc}
          alt={t({ he: 'קוד QR לטלגרם', en: 'Telegram QR code' })}
          width={220}
          height={220}
          className="rounded-md bg-white p-2"
        />
      </div>

      <div className="flex items-center justify-center gap-2 text-xs text-text-muted">
        <span className="inline-block h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
        {t({
          he: 'ממתין לאישור בטלגרם…',
          en: 'Waiting for confirmation in Telegram…',
        })}
      </div>

      {error && (
        <p className="text-[11px] text-red-600 dark:text-red-300 text-center">{error}</p>
      )}

      <div className="text-center">
        <button
          onClick={onPasteToken}
          className="text-[11px] text-indigo-600 hover:underline"
        >
          {t({
            he: 'יש לך בוט קיים? הדבק טוקן ידנית',
            en: 'Have an existing bot? Paste its token manually',
          })}
        </button>
      </div>
    </div>
  )
}
