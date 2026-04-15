import type { ReactNode } from 'react'
import { useI18n } from '../lib/i18n'

/**
 * Render a tenant workspace name in the active UI language.
 *
 * The backend stores two things on every tenant:
 *   - `name`      — the fallback display string. Always set. Used by
 *                   emails, admin panels, and any consumer that
 *                   doesn't know about name_base.
 *   - `name_base` — the raw owner-name source (e.g. "שחר שביט" or
 *                   "Alice"), populated only when the tenant was
 *                   auto-generated at onboarding. Nulled out the
 *                   moment the user renames the workspace via
 *                   PATCH /api/tenants/{id}.
 *
 * Behavior:
 *   - name_base present  → render "<prefix><bdi>{name_base}</bdi><suffix>"
 *                          where prefix/suffix come from the active
 *                          UI language. Hebrew: "מרחב העבודה של ‹name›".
 *                          English: "‹name›'s workspace". The <bdi>
 *                          isolates the owner name from the surrounding
 *                          bidi context so a Hebrew name inside an
 *                          English template (or vice versa) renders as
 *                          a self-contained island without dragging
 *                          the surrounding neutrals through the
 *                          Unicode bidi reorder.
 *   - name_base null     → render the literal `name` wrapped in <bdi>.
 *                          The user explicitly chose it, we must
 *                          preserve it byte-for-byte. <bdi> still
 *                          ensures it renders correctly regardless of
 *                          the surrounding container direction.
 *
 * Use everywhere a tenant name is shown in the UI. Never concatenate
 * tenant.name into raw string templates — that bypasses this helper
 * and re-introduces the bidi bug.
 */
interface Props {
  tenant: {
    name: string
    name_base: string | null
  }
}

export default function TenantName({ tenant }: Props): ReactNode {
  const { t } = useI18n()

  if (tenant.name_base) {
    const prefix = t({ he: 'מרחב העבודה של ', en: '' })
    const suffix = t({ he: '', en: "'s workspace" })
    return (
      <>
        {prefix}
        <bdi>{tenant.name_base}</bdi>
        {suffix}
      </>
    )
  }

  // User-renamed workspace — show the literal stored name, still
  // isolated via <bdi> so the surrounding container's direction
  // doesn't mangle bidirectional characters inside the name.
  return <bdi>{tenant.name}</bdi>
}
