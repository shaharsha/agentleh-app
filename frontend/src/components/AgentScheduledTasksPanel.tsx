import { useEffect, useState } from 'react'
import { cancelTenantReminder, listTenantReminders, type TenantReminder } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { DisclosureChevronIcon } from './icons'

/**
 * Per-agent scheduled tasks panel — renders below BridgesPanel in the
 * dashboard agent card. Matches the Bridges disclosure style exactly:
 * same header button, same inner card, same font scale.
 */

interface Props {
  tenantId: number
  agentId: string
  canCancel: boolean
}

function taskDescription(r: TenantReminder): string {
  // Prefer an explicit name, then the agent-turn message, then a fallback.
  if (r.job_name && !r.job_name.startsWith('שלח לאדם')) return r.job_name
  const msg = r.payload?.message ?? r.payload?.text ?? ''
  if (msg) {
    // Strip "send exactly:" prefix that the agent often adds.
    const cleaned = msg
      .replace(/^שלח לאדם את התזכורת הזאת בדיוק כמו שהיא[^:]*:\s*/u, '')
      .replace(/^שלח[^:]+:\s*/u, '')
      .replace(/^"(.*)"$/u, '$1')
      .trim()
    return cleaned.length > 60 ? cleaned.slice(0, 57) + '…' : cleaned
  }
  return ''
}

function taskWhen(r: TenantReminder, lang: 'he' | 'en'): string {
  if (r.schedule.kind === 'cron') {
    return `↻ ${r.schedule.expr ?? ''}`
  }
  if (r.schedule.kind === 'every') {
    const h = Math.round((r.schedule.everyMs ?? 0) / 3_600_000)
    return lang === 'he' ? `↻ כל ${h} שעות` : `↻ every ${h}h`
  }
  if (r.schedule.at) {
    try {
      return new Date(r.schedule.at).toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    } catch { return r.schedule.at }
  }
  return ''
}

function isRecurring(r: TenantReminder) {
  return r.schedule.kind === 'cron' || r.schedule.kind === 'every'
}

export default function AgentScheduledTasksPanel({ tenantId, agentId, canCancel }: Props) {
  const { t, lang, dir } = useI18n()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reminders, setReminders] = useState<TenantReminder[]>([])
  const [cancelling, setCancelling] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    listTenantReminders(tenantId, agentId)
      .then(r => { setReminders(r.reminders ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [tenantId, agentId])

  const now = Date.now()
  const upcoming = reminders.filter(r =>
    isRecurring(r) || (r.schedule.at && new Date(r.schedule.at).getTime() > now)
  )
  const past = reminders.filter(r =>
    !isRecurring(r) && r.schedule.at && new Date(r.schedule.at).getTime() <= now
  )

  const cancel = async (r: TenantReminder) => {
    if (!window.confirm(t({ he: 'לבטל את המשימה?', en: 'Cancel this task?' }))) return
    setCancelling(r.job_id)
    try {
      await cancelTenantReminder(tenantId, r.agent_id, r.job_id)
      load()
    } finally { setCancelling(null) }
  }

  const total = reminders.length

  return (
    <div className="mt-3 border-t border-gray-100 pt-3" dir={dir}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between text-sm text-text-secondary hover:text-text-primary transition"
      >
        <span className="flex items-center gap-2">
          <DisclosureChevronIcon open={open} />
          <span>{t({ he: 'משימות מתוזמנות', en: 'Scheduled tasks' })}</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs text-text-muted">
          {loading ? (
            <span className="animate-pulse">{t({ he: 'טוען…', en: 'Loading…' })}</span>
          ) : (
            <>
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${total > 0 ? 'bg-success' : 'bg-gray-400'}`}
              />
              <span>
                {total} {t({ he: 'משימות', en: total === 1 ? 'task' : 'tasks' })}
              </span>
            </>
          )}
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-1 rounded-lg border border-border bg-surface/60 p-3">
          {!loading && total === 0 && (
            <div className="text-xs text-text-muted py-1">
              {t({ he: 'אין משימות מתוזמנות', en: 'No scheduled tasks' })}
            </div>
          )}

          {upcoming.map(r => (
            <TaskRow key={r.job_id} r={r} lang={lang} canCancel={canCancel}
              cancelling={cancelling === r.job_id} onCancel={() => cancel(r)} t={t} />
          ))}

          {past.length > 0 && (
            <>
              <div className="text-[10px] text-text-muted pt-2 pb-0.5">
                {t({ he: 'שעברו', en: 'Past' })}
              </div>
              {past.map(r => (
                <TaskRow key={r.job_id} r={r} lang={lang} canCancel={false} faded
                  cancelling={false} onCancel={() => {}} t={t} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function TaskRow({ r, lang, canCancel, cancelling, onCancel, t, faded }: {
  r: TenantReminder
  lang: 'he' | 'en'
  canCancel: boolean
  cancelling: boolean
  onCancel: () => void
  t: (b: { he: string; en: string }) => string
  faded?: boolean
}) {
  const when = taskWhen(r, lang)
  const desc = taskDescription(r)
  const recurring = isRecurring(r)

  return (
    <div className={`flex items-start justify-between gap-2 ${faded ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-2 min-w-0">
        <span className="text-xs text-text-muted mt-0.5 flex-shrink-0 w-3">
          {recurring ? '↻' : '→'}
        </span>
        <div className="min-w-0">
          {desc && (
            <div className="text-sm text-text-primary truncate">{desc}</div>
          )}
          <div className={`text-[11px] text-text-muted ${desc ? '' : 'text-sm text-text-secondary'}`}>
            {when}
          </div>
        </div>
      </div>
      {canCancel && !faded && (
        <button
          onClick={onCancel}
          disabled={cancelling}
          className="text-xs text-danger hover:underline flex-shrink-0 mt-0.5 disabled:opacity-50"
        >
          {cancelling ? '…' : t({ he: 'בטל', en: 'Cancel' })}
        </button>
      )}
    </div>
  )
}
