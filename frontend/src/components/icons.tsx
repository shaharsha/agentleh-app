import type { SVGProps } from 'react'

/**
 * Shared inline SVG icon set for the toolbar + nav.
 *
 * Kept as local components instead of pulling in lucide-react (or any
 * icon package) because:
 *   - Zero new dep, no treeshaking surprises, same bundle size story
 *     as the existing hand-rolled SVGs in TenantSwitcher.
 *   - One consistent stroke weight (1.75) + one size contract, applied
 *     via a shared Icon wrapper. No risk of mixed stroke widths across
 *     the nav like you see when icons come from different libraries.
 *   - Reviewers can see the raw SVG path next to the component name,
 *     no IDE jump-to-def needed.
 *
 * All icons are stroke-only (fill="none"), use currentColor, and inherit
 * their size from the parent's `w-[...] h-[...]` Tailwind class. Default
 * stroke width is 1.75 (slightly lighter than Lucide's default 2) which
 * matches the visual weight of the existing "chevron down" and "plus"
 * inline SVGs already in the codebase.
 */

type IconProps = SVGProps<SVGSVGElement> & {
  /** Tailwind size classes, e.g. "w-[18px] h-[18px]". Caller-owned. */
  className?: string
}

function Icon({
  className = 'w-[18px] h-[18px]',
  children,
  ...rest
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Shield with a check mark inside — used for the Admin / superadmin link. */
export function ShieldCheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </Icon>
  )
}

/**
 * Log-out icon (Lucide-style): a box with an arrow leaving through the
 * right side. Direction is flipped via `scale-x-[-1]` by the caller when
 * the active language is RTL so the arrow always points "out".
 */
export function LogOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </Icon>
  )
}

/** Layout-dashboard: four rounded cells. Used for the "back to dashboard"
 *  link that appears when the user is currently on /admin. */
export function LayoutDashboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </Icon>
  )
}

/** Globe — used in the language switcher to signal "language control". */
export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z" />
    </Icon>
  )
}
