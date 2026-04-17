import { useEffect, useMemo, useState } from 'react'
import { getTenantUsage } from '../lib/api'
import { microsToUsd } from '../lib/format'
import { useI18n, type Bilingual } from '../lib/i18n'
import { planLabel } from '../lib/labels'
import type { AgentUsageRow, TenantUsage } from '../lib/types'

/** App-wide date format: dd/mm/yyyy via en-GB locale, dir="ltr" in the
 *  JSX so bidi doesn't mangle the dash-separated range in Hebrew. */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB')
}

type RangeKind = 'current' | 'last_7d' | 'last_30d' | 'custom'

interface RangeSelection {
  kind: RangeKind
  /** Only set for last_7d / last_30d / custom — `current` lets the
   *  backend derive the range from the active subscription period. */
  from?: string
  to?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

function isoAtStartOfDayUtc(d: Date): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  return copy.toISOString()
}

function isoAtEndOfDayUtc(d: Date): string {
  const copy = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
  )
  return copy.toISOString()
}

function defaultCustomFrom(): string {
  const d = new Date(Date.now() - 7 * DAY_MS)
  return d.toISOString().slice(0, 10)
}

function defaultCustomTo(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function UsageTab({ tenantId }: { tenantId: number }) {
  const { t } = useI18n()
  const [range, setRange] = useState<RangeSelection>({ kind: 'current' })
  const [customFrom, setCustomFrom] = useState<string>(defaultCustomFrom())
  const [customTo, setCustomTo] = useState<string>(defaultCustomTo())
  const [data, setData] = useState<TenantUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getTenantUsage(tenantId, { from: range.from, to: range.to })
      .then((d) => {
        if (cancelled) return
        setData(d)
      })
      .catch((err) => {
        if (cancelled) return
        setError((err as Error).message)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tenantId, range.from, range.to, range.kind])

  const num = (v: string) => <span dir="ltr">{v}</span>

  const onPickKind = (kind: RangeKind) => {
    if (kind === 'current') {
      setRange({ kind: 'current' })
      return
    }
    if (kind === 'last_7d') {
      setRange({
        kind,
        from: isoAtStartOfDayUtc(new Date(Date.now() - 7 * DAY_MS)),
        to: isoAtEndOfDayUtc(new Date()),
      })
      return
    }
    if (kind === 'last_30d') {
      setRange({
        kind,
        from: isoAtStartOfDayUtc(new Date(Date.now() - 30 * DAY_MS)),
        to: isoAtEndOfDayUtc(new Date()),
      })
      return
    }
    // custom — use whatever the date inputs currently hold
    applyCustomRange(customFrom, customTo)
  }

  const applyCustomRange = (from: string, to: string) => {
    if (!from || !to) return
    setRange({
      kind: 'custom',
      from: isoAtStartOfDayUtc(new Date(from)),
      to: isoAtEndOfDayUtc(new Date(to)),
    })
  }

  const totals = data?.totals
  const agents = data?.agents || []
  const subscription = data?.subscription
  const respRange = data?.range

  // Split for the per-agent table: live rows render at full opacity at the
  // top; deleted rows are muted and grouped at the bottom (and collapsed
  // behind a "show N deleted" toggle if there are many — keeps the
  // active-roster scan clean for tenants with churn).
  const liveAgents = useMemo(
    () => agents.filter((a) => !a.deleted_at),
    [agents],
  )
  const deletedAgents = useMemo(
    () => agents.filter((a) => !!a.deleted_at),
    [agents],
  )
  const [showDeleted, setShowDeleted] = useState(false)
  const DELETED_COLLAPSE_THRESHOLD = 5

  // Values arrive from the wire as strings (Postgres SUM returns NUMERIC,
  // which FastAPI serializes as a JSON string to preserve precision).
  // Coerce before summing — otherwise `+` concatenates strings.
  const totalMicros = useMemo(
    () =>
      Number(totals?.llm_micros ?? 0)
      + Number(totals?.search_micros ?? 0)
      + Number(totals?.tts_micros ?? 0)
      + Number(totals?.embedding_micros ?? 0),
    [totals],
  )

  const allowancePct = useMemo(() => {
    if (!subscription || subscription.base_allowance_micros <= 0) return null
    const pct = (subscription.used_micros / subscription.base_allowance_micros) * 100
    return Math.min(100, Math.max(0, pct))
  }, [subscription])

  const formatRange = (from?: string, to?: string): string => {
    if (!from || !to) return ''
    return `${fmtDate(from)} – ${fmtDate(to)}`
  }

  const rangeLabel = (kind: RangeKind): Bilingual => {
    switch (kind) {
      case 'current': return { he: 'מחזור חיוב נוכחי', en: 'Current billing cycle' }
      case 'last_7d': return { he: '7 ימים אחרונים', en: 'Last 7 days' }
      case 'last_30d': return { he: '30 יום אחרונים', en: 'Last 30 days' }
      case 'custom': return { he: 'טווח מותאם', en: 'Custom range' }
    }
  }

  return (
    <div className="space-y-6">
      {/* Range picker */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center gap-2">
          {(['current', 'last_7d', 'last_30d', 'custom'] as RangeKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => onPickKind(k)}
              className={`text-sm px-3 py-1.5 rounded-full border transition-colors cursor-pointer ${
                range.kind === k
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {t(rangeLabel(k))}
            </button>
          ))}
        </div>

        {range.kind === 'custom' && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div>
              <div className="text-xs text-gray-500 mb-1">{t({ he: 'מתאריך', en: 'From' })}</div>
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="text-sm border border-gray-200 rounded-md px-2 py-1"
              />
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">{t({ he: 'עד תאריך', en: 'To' })}</div>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={defaultCustomTo()}
                onChange={(e) => setCustomTo(e.target.value)}
                className="text-sm border border-gray-200 rounded-md px-2 py-1"
              />
            </div>
            <button
              type="button"
              onClick={() => applyCustomRange(customFrom, customTo)}
              className="text-sm px-3 py-1.5 rounded-md bg-gray-900 text-white hover:bg-gray-700 cursor-pointer"
            >
              {t({ he: 'החל', en: 'Apply' })}
            </button>
          </div>
        )}

        {range.kind === 'current' && subscription && (
          <div className="mt-4 text-sm text-gray-600 space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                <span className="text-gray-500">{t({ he: 'תכנית', en: 'Plan' })}: </span>
                <span className="font-medium text-gray-900">{t(planLabel(subscription.plan_id))}</span>
              </span>
              <span>
                <span className="text-gray-500">{t({ he: 'סוף תקופה', en: 'Period ends' })}: </span>
                <span className="font-medium text-gray-900">
                  {num(fmtDate(subscription.period_end))}
                </span>
              </span>
              <span>
                <span className="text-gray-500">{t({ he: 'נוצל', en: 'Used' })}: </span>
                <span className="font-medium text-gray-900">
                  {num(microsToUsd(subscription.used_micros))}{' / '}
                  {num(microsToUsd(subscription.base_allowance_micros))}
                </span>
              </span>
            </div>
            {allowancePct !== null && (
              <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden" dir="ltr">
                <div
                  className={`h-full ${allowancePct >= 100 ? 'bg-red-500' : allowancePct >= 80 ? 'bg-amber-500' : 'bg-indigo-500'}`}
                  style={{ width: `${allowancePct}%` }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tenant totals */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {t({ he: 'סיכום שימוש', en: 'Usage summary' })}
          </h2>
          {respRange && (
            <span className="text-xs text-gray-500">
              {num(formatRange(respRange.from, respRange.to))}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 text-sm">
          <TotalTile label={{ he: 'סה״כ', en: 'Total' }} value={num(microsToUsd(totalMicros))} loading={loading} emphasize />
          <TotalTile label={{ he: 'מודל שפה', en: 'LLM' }} value={num(microsToUsd(totals?.llm_micros))} loading={loading} />
          <TotalTile label={{ he: 'חיפוש', en: 'Search' }} value={num(microsToUsd(totals?.search_micros))} loading={loading} />
          <TotalTile label={{ he: 'קול', en: 'Voice (TTS)' }} value={num(microsToUsd(totals?.tts_micros))} loading={loading} />
          <TotalTile label={{ he: 'חיפוש זיכרון', en: 'Memory search' }} value={num(microsToUsd(totals?.embedding_micros))} loading={loading} />
        </div>
      </div>

      {/* Per-agent table */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {t({ he: 'פירוט לפי סוכן', en: 'Per-agent breakdown' })}
        </h2>

        {error && (
          <div className="text-sm text-red-600">
            {t({ he: 'שגיאה בטעינת שימוש: ', en: 'Failed to load usage: ' })}
            {error}
          </div>
        )}

        {!error && loading && <AgentRowsSkeleton />}

        {!error && !loading && agents.length === 0 && (
          <p className="text-sm text-gray-500">
            {t({ he: 'לא נרשם שימוש בטווח הזה.', en: 'No usage in this range yet.' })}
          </p>
        )}

        {!error && !loading && agents.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs uppercase tracking-wide">
                  <th className="text-start font-medium py-2 pe-3">{t({ he: 'סוכן', en: 'Agent' })}</th>
                  <th className="text-end font-medium py-2 px-3">{t({ he: 'מודל שפה', en: 'LLM' })}</th>
                  <th className="text-end font-medium py-2 px-3">{t({ he: 'חיפוש', en: 'Search' })}</th>
                  <th className="text-end font-medium py-2 px-3">{t({ he: 'קול', en: 'Voice' })}</th>
                  <th className="text-end font-medium py-2 px-3">{t({ he: 'זיכרון', en: 'Memory' })}</th>
                  <th className="text-end font-medium py-2 px-3">{t({ he: 'סה״כ', en: 'Total' })}</th>
                  <th className="text-end font-medium py-2 ps-3">{t({ he: 'אירועים', en: 'Events' })}</th>
                </tr>
              </thead>
              <tbody>
                {liveAgents.map((a) => (
                  <AgentRow key={a.agent_id} row={a} num={num} />
                ))}
                {deletedAgents.length > 0 && (
                  deletedAgents.length < DELETED_COLLAPSE_THRESHOLD || showDeleted ? (
                    deletedAgents.map((a) => (
                      <AgentRow key={a.agent_id} row={a} num={num} />
                    ))
                  ) : (
                    <tr className="border-t border-gray-100">
                      <td colSpan={7} className="py-3 text-center">
                        <button
                          type="button"
                          onClick={() => setShowDeleted(true)}
                          className="text-sm text-gray-500 hover:text-gray-700 cursor-pointer"
                        >
                          {t({
                            he: `+ הצג ${deletedAgents.length} סוכנים שנמחקו`,
                            en: `+ Show ${deletedAgents.length} deleted agent${deletedAgents.length === 1 ? '' : 's'}`,
                          })}
                        </button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function TotalTile({
  label,
  value,
  loading,
  emphasize,
}: {
  label: Bilingual
  value: React.ReactNode
  loading: boolean
  emphasize?: boolean
}) {
  const { t } = useI18n()
  return (
    <div>
      <div className="text-gray-500">{t(label)}</div>
      <div className={`${emphasize ? 'text-xl' : ''} font-medium ${loading ? 'text-gray-300' : 'text-gray-900'}`}>
        {value}
      </div>
    </div>
  )
}

function AgentRow({
  row,
  num,
}: {
  row: AgentUsageRow
  num: (v: string) => React.ReactNode
}) {
  const { t } = useI18n()
  const total =
    Number(row.llm_micros)
    + Number(row.search_micros)
    + Number(row.tts_micros)
    + Number(row.embedding_micros)
  const isDeleted = !!row.deleted_at
  // 'unknown' = legacy hard-deleted (no tombstone) — render as deleted
  // without a date.
  const deletedDate =
    isDeleted && row.deleted_at !== 'unknown' ? fmtDate(row.deleted_at!) : null
  const nameClass = isDeleted ? 'font-medium text-gray-500' : 'font-medium text-gray-900'
  const cellClass = isDeleted ? 'text-gray-500' : ''
  const totalClass = isDeleted ? 'font-medium text-gray-500' : 'font-medium text-gray-900'
  return (
    <tr className="border-t border-gray-100">
      <td className="py-2 pe-3">
        <div className={nameClass} dir="auto">
          {row.agent_name}
          {isDeleted && (
            <span className="ms-2 text-xs text-gray-400 font-normal">
              ·{' '}
              {deletedDate
                ? t({ he: `נמחק ${deletedDate}`, en: `deleted ${deletedDate}` })
                : t({ he: 'נמחק', en: 'deleted' })}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-400 font-mono" dir="ltr">{row.agent_id}</div>
      </td>
      <td className={`py-2 px-3 text-end ${cellClass}`}>{num(microsToUsd(row.llm_micros))}</td>
      <td className={`py-2 px-3 text-end ${cellClass}`}>{num(microsToUsd(row.search_micros))}</td>
      <td className={`py-2 px-3 text-end ${cellClass}`}>{num(microsToUsd(row.tts_micros))}</td>
      <td className={`py-2 px-3 text-end ${cellClass}`}>{num(microsToUsd(row.embedding_micros))}</td>
      <td className={`py-2 px-3 text-end ${totalClass}`}>{num(microsToUsd(total))}</td>
      <td className={`py-2 ps-3 text-end tabular-nums ${cellClass}`}>{num(String(row.event_count))}</td>
    </tr>
  )
}

function AgentRowsSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />
      ))}
    </div>
  )
}
