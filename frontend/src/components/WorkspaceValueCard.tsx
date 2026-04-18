import { useEffect, useState } from 'react'
import { getTenantUsage } from '../lib/api'
import { useI18n } from '../lib/i18n'
import type { TenantUsage } from '../lib/types'

/**
 * Dashboard hero card. Renders a single headline stat — how many
 * billable agent actions have happened this billing period — so the
 * owner sees at a glance that the agent is working for them before
 * anything else on the page. The whole card is a button that jumps to
 * the Usage tab, where every event can be inspected. Empty and loading
 * states are first-class so day-one tenants don't see a broken widget.
 *
 * Honest-count-only by design: we show `totals.event_count` (raw
 * upstream usage events) rather than a derived "hours saved" figure.
 * Once per-action logging lands, a richer savings card can replace this
 * one — the slot is owned by `DashboardTab`, swap the component and
 * keep the same navigation target.
 */
interface Props {
  tenantId: number
  onNavigate: (path: string) => void
}

export default function WorkspaceValueCard({ tenantId, onNavigate }: Props) {
  const { t, tn, dir } = useI18n()
  const [usage, setUsage] = useState<TenantUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    getTenantUsage(tenantId)
      .then((u) => {
        if (cancelled) return
        setUsage(u)
      })
      .catch(() => {
        if (cancelled) return
        setError(true)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tenantId])

  // Fail-silent: if the meter is unreachable we hide the card entirely
  // rather than showing a broken "—" placeholder next to real content.
  if (error) return null

  const count = Number(usage?.totals?.event_count ?? 0)
  const isEmpty = !loading && count === 0

  const headline = loading
    ? t({ he: 'מחשבים את הפעילות…', en: 'Counting activity…' })
    : isEmpty
      ? t({ he: 'הסוכן שלך מוכן', en: 'Your agent is ready' })
      : tn(
          {
            one: { he: 'פעולת סוכן החודש', en: 'agent action this month' },
            other: { he: 'פעולות סוכן החודש', en: 'agent actions this month' },
          },
          count,
        )

  const sublabel = loading
    ? ''
    : isEmpty
      ? t({
          he: 'הפעולות הראשונות יופיעו כאן ברגע שהסוכן יתחיל לעבוד.',
          en: 'First actions will appear here the moment your agent starts working.',
        })
      : t({
          he: 'כל אירוע חיוב שנמדד למרחב העבודה שלך. לחצו לפירוט מלא.',
          en: 'Every billable event recorded for your workspace. Tap for the full breakdown.',
        })

  const goToUsage = () => onNavigate(`/tenants/${tenantId}/usage`)

  const arrow = dir === 'rtl' ? '←' : '→'

  return (
    <button
      type="button"
      onClick={goToUsage}
      aria-label={t({
        he: 'פירוט שימוש מלא',
        en: 'Open full usage breakdown',
      })}
      className="group w-full text-start bg-surface border border-border rounded-xl p-6 hover:border-brand transition-colors cursor-pointer"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-text-muted uppercase tracking-wide mb-2">
            {t({ he: 'הפעילות החודש', en: 'This month' })}
          </div>

          {loading ? (
            <div className="space-y-2" aria-hidden="true">
              <div className="h-9 w-40 rounded-md bg-surface-soft animate-pulse" />
              <div className="h-4 w-64 rounded-md bg-surface-soft animate-pulse" />
            </div>
          ) : isEmpty ? (
            <div className="text-xl sm:text-2xl font-semibold text-text-primary">
              {headline}
            </div>
          ) : (
            <div className="flex items-baseline gap-2 flex-wrap">
              <span
                className="text-3xl sm:text-4xl font-semibold text-text-primary tabular-nums"
                dir="ltr"
              >
                {count.toLocaleString('en-US')}
              </span>
              <span className="text-sm sm:text-base text-text-secondary">
                {headline}
              </span>
            </div>
          )}

          {sublabel && (
            <p className="mt-2 text-sm text-text-muted">{sublabel}</p>
          )}
        </div>

        <span
          aria-hidden="true"
          className="shrink-0 text-brand text-lg transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5"
        >
          {arrow}
        </span>
      </div>
    </button>
  )
}
