import { useEffect, useState } from 'react'
import { cancelTenantReminder, listTenantReminders, type TenantReminder } from '../lib/api'
import { useI18n } from '../lib/i18n'

/**
 * Per-agent scheduled tasks panel — renders below BridgesPanel in the
 * dashboard agent card. Shows upcoming + recurring tasks with cancel.
 *
 * Replaces the global "reminders" tab. Per-agent view is more natural:
 * tasks belong to a specific agent, not to the tenant as a whole.
 */

interface Props {
  tenantId: number
  agentId: string
  canCancel: boolean
}

function formatWhen(iso: string | undefined, lang: 'he' | 'en'): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

export default function AgentScheduledTasksPanel({ tenantId, agentId, canCancel }: Props) {
  const { t, lang } = useI18n()
  const [reminders, setReminders] = useState<TenantReminder[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const load = () => {
    listTenantReminders(tenantId, agentId)
      .then(r => { setReminders(r.reminders); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [tenantId, agentId])

  const now = Date.now()
  const upcoming = reminders.filter(r =>
    r.schedule.kind === 'cron' || r.schedule.kind === 'every' ||
    (r.schedule.at && new Date(r.schedule.at).getTime() > now)
  )
  const past = reminders.filter(r =>
    r.schedule.kind === 'at' && r.schedule.at && new Date(r.schedule.at).getTime() <= now
  )

  const cancel = async (r: TenantReminder) => {
    if (!window.confirm(t({ he: 'לבטל את המשימה?', en: 'Cancel this task?' }))) return
    setCancelling(r.job_id)
    try {
      await cancelTenantReminder(tenantId, r.agent_id, r.job_id)
      load()
    } finally { setCancelling(null) }
  }

  if (loading) return null
  if (reminders.length === 0 && !expanded) return (
    <div className="mt-3 text-xs text-text-muted">
      {t({ he: 'אין משימות מתוזמנות', en: 'No scheduled tasks' })}
    </div>
  )

  return (
    <div className="mt-4">
      <button
        className="flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors mb-2"
        onClick={() => setExpanded(e => !e)}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span>{t({ he: 'משימות מתוזמנות', en: 'Scheduled tasks' })}</span>
        {reminders.length > 0 && (
          <span className="bg-surface-soft text-text-muted rounded-full px-1.5 py-0.5 text-[10px]">
            {reminders.length}
          </span>
        )}
      </button>

      {expanded && (
        <div className="space-y-1">
          {upcoming.length === 0 && past.length === 0 && (
            <div className="text-xs text-text-muted py-1">
              {t({ he: 'אין משימות', en: 'No tasks' })}
            </div>
          )}
          {upcoming.map(r => (
            <TaskRow key={r.job_id} r={r} lang={lang} canCancel={canCancel}
              cancelling={cancelling === r.job_id} onCancel={() => cancel(r)} t={t} />
          ))}
          {past.length > 0 && (
            <>
              <div className="text-[10px] text-text-muted pt-1">
                {t({ he: 'שעברו', en: 'Past' })}
              </div>
              {past.map(r => (
                <TaskRow key={r.job_id} r={r} lang={lang} canCancel={canCancel} faded
                  cancelling={cancelling === r.job_id} onCancel={() => cancel(r)} t={t} />
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
  const label = r.job_name ||
    (r.schedule.kind === 'cron' ? `↻ ${r.schedule.expr ?? ''}` :
     r.schedule.kind === 'every' ? `↻ ${t({ he: 'קבוע', en: 'recurring' })}` :
     formatWhen(r.schedule.at, lang))

  return (
    <div className={`flex items-center gap-2 py-0.5 ${faded ? 'opacity-50' : ''}`}>
      <span className="text-xs text-text-muted w-3 flex-shrink-0">
        {r.schedule.kind === 'cron' || r.schedule.kind === 'every' ? '↻' : '→'}
      </span>
      <span className="text-xs text-text-secondary flex-1 truncate">{label}</span>
      {canCancel && !faded && (
        <button
          onClick={onCancel}
          disabled={cancelling}
          className="text-[10px] text-danger hover:text-danger-dark flex-shrink-0 disabled:opacity-50"
        >
          {cancelling ? '…' : t({ he: 'בטל', en: 'Cancel' })}
        </button>
      )}
    </div>
  )
}
