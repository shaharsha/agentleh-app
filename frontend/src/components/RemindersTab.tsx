import { useEffect, useState } from 'react'
import {
  cancelTenantReminder,
  listTenantReminders,
  type TenantReminder,
} from '../lib/api'
import { useI18n } from '../lib/i18n'

/**
 * Tenant-owner dashboard tab for scheduled reminders + recurring agent
 * actions. Reads OpenClaw cron state across all tenant agents via the
 * backend's `/api/tenants/{id}/reminders` aggregation. Members see the
 * list; admins + owners can cancel.
 *
 * Three sections: upcoming one-shots (schedule.kind=at, at > now),
 * recurring (kind=cron / every), and past one-shots (already fired,
 * still in jobs.json when deleteAfterRun=false). Empty states are
 * explicit — "no reminders" is common and the agent will create them
 * on demand from WhatsApp.
 */

function formatWhen(iso: string | undefined, lang: 'he' | 'en'): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function relativeFromNow(iso: string | undefined, lang: 'he' | 'en'): string {
  if (!iso) return ''
  const d = new Date(iso).getTime()
  if (Number.isNaN(d)) return ''
  const diffMs = d - Date.now()
  const diffMin = Math.round(diffMs / 60000)
  const he = lang === 'he'
  if (Math.abs(diffMin) < 1) return he ? 'עכשיו' : 'now'
  const abs = Math.abs(diffMin)
  if (abs < 60) return he ? `בעוד ${diffMin}ד׳` : `in ${diffMin}m`
  const diffHours = Math.round(diffMin / 60)
  if (Math.abs(diffHours) < 24)
    return he ? `בעוד ${diffHours} שעות` : `in ${diffHours}h`
  const diffDays = Math.round(diffHours / 24)
  return he ? `בעוד ${diffDays} ימים` : `in ${diffDays}d`
}

function reminderText(r: TenantReminder): string {
  // agentTurn payloads carry `message` (the prompt for the isolated turn);
  // systemEvent payloads carry `text`. We show whichever is present.
  return r.payload.text || r.payload.message || '—'
}

function scheduleSummary(r: TenantReminder, lang: 'he' | 'en'): string {
  const sched = r.schedule
  if (sched.kind === 'at' && sched.at) {
    return `${formatWhen(sched.at, lang)} · ${relativeFromNow(sched.at, lang)}`
  }
  if (sched.kind === 'cron' && sched.expr) {
    const tz = sched.tz ? ` (${sched.tz})` : ''
    return `cron: ${sched.expr}${tz}`
  }
  if (sched.kind === 'every' && sched.everyMs) {
    const mins = Math.round(sched.everyMs / 60_000)
    return lang === 'he' ? `כל ${mins} דקות` : `every ${mins}m`
  }
  return '—'
}

export default function RemindersTab({
  tenantId,
  canCancel,
}: {
  tenantId: number
  canCancel: boolean
}) {
  const { t } = useI18n()
  const [data, setData] = useState<{
    reminders: TenantReminder[]
    errors: Array<{ agent_id: string; agent_name: string; error: string }>
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)

  function refresh() {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    listTenantReminders(tenantId)
      .then((resp) => {
        if (!cancelled) setData({ reminders: resp.reminders, errors: resp.errors })
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }

  useEffect(() => {
    const teardown = refresh()
    return teardown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  async function handleCancel(r: TenantReminder) {
    const confirmMsg = t({
      he: `לבטל את התזכורת "${reminderText(r).slice(0, 60)}"?`,
      en: `Cancel the reminder "${reminderText(r).slice(0, 60)}"?`,
    })
    if (!confirm(confirmMsg)) return
    setCancelling(r.job_id)
    setCancelError(null)
    try {
      await cancelTenantReminder(tenantId, r.agent_id, r.job_id)
      setData((prev) =>
        prev
          ? {
              ...prev,
              reminders: prev.reminders.filter((x) => x.job_id !== r.job_id),
            }
          : prev,
      )
    } catch (err) {
      setCancelError((err as Error).message)
    } finally {
      setCancelling(null)
    }
  }

  if (loading && !data) {
    return (
      <div className="text-text-muted p-6">
        {t({ he: 'טוען תזכורות…', en: 'Loading reminders…' })}
      </div>
    )
  }
  if (loadError) {
    return (
      <div className="p-6 bg-danger-light text-danger rounded">
        {loadError}
        <button
          onClick={refresh}
          className="block mt-3 text-sm underline"
          type="button"
        >
          {t({ he: 'נסה שוב', en: 'Retry' })}
        </button>
      </div>
    )
  }
  if (!data) return null

  const now = Date.now()
  const upcomingOneshot = data.reminders.filter((r) => {
    if (r.schedule.kind !== 'at') return false
    const at = r.schedule.at ? new Date(r.schedule.at).getTime() : NaN
    return !Number.isNaN(at) && at > now
  })
  const pastOneshot = data.reminders.filter((r) => {
    if (r.schedule.kind !== 'at') return false
    const at = r.schedule.at ? new Date(r.schedule.at).getTime() : NaN
    return !Number.isNaN(at) && at <= now
  })
  const recurring = data.reminders.filter(
    (r) => r.schedule.kind === 'cron' || r.schedule.kind === 'every',
  )

  return (
    <div className="space-y-6">
      {data.errors.length > 0 && (
        <div className="glass-card p-4 border border-warning">
          <div className="font-semibold text-warning mb-1">
            {t({
              he: 'חלק מהסוכנים לא הגיבו',
              en: "Some agents didn't respond",
            })}
          </div>
          <ul className="text-sm text-text-secondary">
            {data.errors.map((e) => (
              <li key={e.agent_id} dir="auto">
                {e.agent_name}: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Section
        title={t({ he: 'תזכורות קרובות', en: 'Upcoming' })}
        empty={t({ he: 'אין תזכורות קרובות.', en: 'No upcoming reminders.' })}
        reminders={upcomingOneshot}
        expanded={expanded}
        setExpanded={setExpanded}
        canCancel={canCancel}
        onCancel={handleCancel}
        cancelling={cancelling}
      />

      {recurring.length > 0 && (
        <Section
          title={t({ he: 'חוזרות', en: 'Recurring' })}
          empty=""
          reminders={recurring}
          expanded={expanded}
          setExpanded={setExpanded}
          canCancel={canCancel}
          onCancel={handleCancel}
          cancelling={cancelling}
        />
      )}

      {pastOneshot.length > 0 && (
        <Section
          title={t({ he: 'עברו', en: 'Past' })}
          empty=""
          reminders={pastOneshot}
          expanded={expanded}
          setExpanded={setExpanded}
          canCancel={canCancel}
          onCancel={handleCancel}
          cancelling={cancelling}
          faded
        />
      )}

      {cancelError && (
        <div className="p-3 bg-danger-light text-danger rounded text-sm">
          {cancelError}
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  empty,
  reminders,
  expanded,
  setExpanded,
  canCancel,
  onCancel,
  cancelling,
  faded = false,
}: {
  title: string
  empty: string
  reminders: TenantReminder[]
  expanded: Set<string>
  setExpanded: (s: Set<string>) => void
  canCancel: boolean
  onCancel: (r: TenantReminder) => void
  cancelling: string | null
  faded?: boolean
}) {
  const { t, lang } = useI18n()
  if (reminders.length === 0 && !empty) return null
  return (
    <div className={`glass-card p-4 ${faded ? 'opacity-60' : ''}`}>
      <h2 className="text-lg font-semibold text-text-primary mb-3">
        {title} ({reminders.length})
      </h2>
      {reminders.length === 0 ? (
        <p className="text-sm text-text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border-light">
          {reminders.map((r) => {
            const isOpen = expanded.has(r.job_id)
            return (
              <li key={r.job_id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary" dir="auto">
                      {reminderText(r)}
                    </div>
                    <div className="text-xs text-text-secondary mt-1" dir="auto">
                      <span dir="ltr">{scheduleSummary(r, lang)}</span>
                      {' · '}
                      <span className="text-text-muted">{r.agent_name}</span>
                      {r.delivery.accountId && (
                        <>
                          {' · '}
                          <span className="text-text-muted" dir="ltr">
                            {r.delivery.accountId}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-3 shrink-0">
                    {canCancel && (
                      <button
                        onClick={() => onCancel(r)}
                        disabled={cancelling === r.job_id}
                        className="text-xs text-danger hover:underline disabled:opacity-50"
                        type="button"
                      >
                        {cancelling === r.job_id
                          ? t({ he: 'מבטל…', en: 'Cancelling…' })
                          : t({ he: 'בטל', en: 'Cancel' })}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        const next = new Set(expanded)
                        if (next.has(r.job_id)) next.delete(r.job_id)
                        else next.add(r.job_id)
                        setExpanded(next)
                      }}
                      className="text-xs text-text-muted hover:text-text-primary"
                      type="button"
                    >
                      {isOpen ? '▼' : '▸'}
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <pre
                    className="mt-2 p-2 rounded bg-surface-soft text-xs text-text-secondary overflow-auto"
                    dir="ltr"
                  >
                    {JSON.stringify(r.raw, null, 2)}
                  </pre>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
