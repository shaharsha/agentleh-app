import { useEffect, useState } from 'react'
import { listTenantAudit, type AuditEvent } from '../lib/api'
import { useI18n, type Bilingual } from '../lib/i18n'

/**
 * Time-descending feed of every state-changing action on this tenant.
 * Visible to admin+. Rows render the human-readable action label +
 * actor + relative time; each row is expandable to show the JSON
 * metadata payload for investigations.
 *
 * The backend action namespace is a dotted tag (`tenant.rename`,
 * `agent.delete`, `subscription.redeem_coupon`, ...). We map those to
 * bilingual labels here so new actions can be added backend-only and
 * just fall through to the raw tag string until the UI catches up.
 */

const ACTION_LABELS: Record<string, Bilingual> = {
  'tenant.create':                  { he: 'נוצרה סביבת עבודה',     en: 'Workspace created' },
  'tenant.rename':                  { he: 'שונה שם סביבת העבודה', en: 'Workspace renamed' },
  'tenant.update':                  { he: 'עודכנה סביבת העבודה',  en: 'Workspace updated' },
  'tenant.delete':                  { he: 'נמחקה סביבת עבודה',     en: 'Workspace deleted' },
  'tenant.transfer_owner':          { he: 'הועברה בעלות',           en: 'Ownership transferred' },
  'member.invite':                  { he: 'נשלחה הזמנה',            en: 'Invite sent' },
  'member.accept_invite':           { he: 'התקבלה הזמנה',           en: 'Invite accepted' },
  'member.change_role':             { he: 'שונה תפקיד',              en: 'Role changed' },
  'member.remove':                  { he: 'הוסר חבר',                 en: 'Member removed' },
  'invite.revoke':                  { he: 'בוטלה הזמנה',              en: 'Invite revoked' },
  'agent.create':                   { he: 'נוצר סוכן',                 en: 'Agent created' },
  'agent.delete':                   { he: 'נמחק סוכן',                 en: 'Agent deleted' },
  'subscription.redeem_coupon':     { he: 'הופעלה תוכנית',            en: 'Plan activated' },
  'subscription.admin_grant':       { he: 'הוענקה תוכנית (מנהל)',   en: 'Plan granted (admin)' },
}

function formatWhen(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-GB')
}

function ActorLabel({ ev }: { ev: AuditEvent }) {
  const { t } = useI18n()
  if (ev.actor_user_id === null) {
    return <span className="text-text-muted italic">{t({ he: 'מערכת', en: 'System' })}</span>
  }
  const display = ev.actor_full_name || ev.actor_email || `#${ev.actor_user_id}`
  return <span>{display}</span>
}

export default function AuditTab({ tenantId }: { tenantId: number }) {
  const { t, dir } = useI18n()
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listTenantAudit(tenantId, { limit: 100 })
      .then((data) => {
        if (cancelled) return
        setEvents(data.events)
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
  }, [tenantId])

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (loading) {
    return (
      <div className="text-text-secondary py-8 text-center">
        {t({ he: 'טוען יומן…', en: 'Loading audit log…' })}
      </div>
    )
  }
  if (error) {
    return (
      <div className="text-red-600 py-8 text-center">
        {t({ he: 'שגיאה: ', en: 'Error: ' })}
        {error}
      </div>
    )
  }
  if (events.length === 0) {
    return (
      <div className="text-text-secondary py-8 text-center">
        {t({ he: 'אין אירועים עדיין', en: 'No events yet' })}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[13px] text-text-secondary px-1">
        {t({
          he: 'תיעוד של כל פעולה שמשנה את סביבת העבודה. גלוי למנהלים בלבד.',
          en: 'Every state-changing action on this workspace. Admins only.',
        })}
      </p>
      <ul className="space-y-1.5">
        {events.map((ev) => {
          const label = ACTION_LABELS[ev.action]
          const human = label ? t(label) : ev.action
          const isOpen = expanded.has(ev.id)
          const hasMeta =
            ev.metadata !== null && ev.metadata !== undefined && Object.keys(ev.metadata).length > 0
          return (
            <li
              key={ev.id}
              className="glass-card rounded-[14px] px-4 py-3"
            >
              <div className="flex items-baseline justify-between gap-3 text-[14px]">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium">{human}</span>
                  <span className="text-text-secondary text-[12px]">
                    <ActorLabel ev={ev} />
                  </span>
                  {ev.target_type && ev.target_id && (
                    <code className="font-mono text-[11px] text-text-muted">
                      {ev.target_type}:{ev.target_id}
                    </code>
                  )}
                </div>
                <span
                  className="text-[12px] text-text-muted shrink-0 tabular-nums"
                  dir="ltr"
                >
                  {formatWhen(ev.created_at)}
                </span>
              </div>
              {hasMeta && (
                <div className="mt-1">
                  <button
                    type="button"
                    onClick={() => toggle(ev.id)}
                    className="text-[11px] text-brand hover:underline cursor-pointer"
                  >
                    {isOpen
                      ? t({ he: 'הסתר פרטים', en: 'Hide details' })
                      : t({ he: 'הצג פרטים', en: 'Show details' })}
                  </button>
                  {isOpen && (
                    <pre
                      className="mt-1.5 p-2 rounded-lg bg-gray-50 text-[11px] text-text-secondary overflow-x-auto"
                      dir="ltr"
                    >
                      {JSON.stringify(ev.metadata, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="text-[12px] text-text-muted px-1 pt-2" dir={dir}>
        {t({
          he: `מציג עד 100 האירועים האחרונים`,
          en: `Showing the most recent 100 events`,
        })}
      </p>
    </div>
  )
}
