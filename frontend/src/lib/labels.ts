import type { Bilingual } from './i18n'

/**
 * Bilingual display labels for backend enum slugs.
 *
 * The DB stores plan IDs + status values as stable English slugs
 * ("minimal", "active", etc.) for schema stability and join safety.
 * But users see these values in the UI, so each one needs a bilingual
 * display label. Kept as a single flat map here so adding a new plan
 * or status is a one-line change in one file.
 *
 * Unknown / missing slugs fall back to the raw string via
 * `planLabel(id)` / `statusLabel(id)` — better to show "foo" than
 * crash on the happy path of a new backend enum that hasn't shipped
 * to the frontend yet.
 */

const PLAN_LABELS: Record<string, Bilingual> = {
  minimal:  { he: 'מינימלי',  en: 'Minimal' },
  starter:  { he: 'סטארטר',   en: 'Starter' },
  business: { he: 'עסקי',     en: 'Business' },
  premium:  { he: 'פרימיום',  en: 'Premium' },
  wallet:   { he: 'ארנק',     en: 'Wallet' },
}

const STATUS_LABELS: Record<string, Bilingual> = {
  active:     { he: 'פעיל',     en: 'Active' },
  paused:     { he: 'מושהה',    en: 'Paused' },
  exhausted:  { he: 'מוצה',     en: 'Exhausted' },
  cancelled:  { he: 'בוטל',     en: 'Cancelled' },
  superseded: { he: 'הוחלף',    en: 'Superseded' },
  // agent / tenant status fallbacks used outside of subscriptions
  provisioning: { he: 'מקים…',   en: 'Provisioning…' },
}

/** Look up a bilingual label for a billing plan slug. */
export function planLabel(planId: string | null | undefined): Bilingual {
  if (!planId) return { he: '—', en: '—' }
  return PLAN_LABELS[planId] || { he: planId, en: planId }
}

/** Look up a bilingual label for a subscription/agent status slug. */
export function statusLabel(status: string | null | undefined): Bilingual {
  if (!status) return { he: '—', en: '—' }
  return STATUS_LABELS[status] || { he: status, en: status }
}
