import type { SVGProps } from 'react'
import { useI18n } from '../lib/i18n'

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

/**
 * Manus Dei — cloud with a hand reaching down through it. Used for the
 * superadmin ("god mode") link. Swaps to LayoutDashboardIcon while on
 * /admin.
 *
 * Exception to the shared Icon wrapper: the source art is filled-outline
 * line art (traced from hand-from-heaven_85365.png via potrace), not a
 * stroke-only glyph. Rendering it as a filled silhouette on currentColor
 * preserves the reference's visual weight — ~1-unit apparent line width
 * at 18×18, close to the 1.75-stroke weight of the sibling icons without
 * needing a manual re-draw.
 */
export function GodModeIcon({
  className = 'w-[18px] h-[18px]',
  ...rest
}: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 512 512"
      fill="currentColor"
      aria-hidden="true"
      {...rest}
    >
      <g transform="translate(0 512) scale(0.1 -0.1)">
        <path d="M2405 5109 c-383 -56 -707 -293 -876 -642 -22 -45 -46 -105 -55 -133 l-15 -51 -52 -7 c-142 -16 -308 -88 -429 -184 -204 -163 -334 -416 -341 -662 -2 -78 -1 -83 26 -106 l28 -24 665 0 664 0 0 -214 0 -215 -57 -32 c-32 -18 -94 -69 -138 -113 -66 -66 -89 -99 -127 -176 -59 -121 -76 -192 -88 -360 -16 -232 -69 -371 -203 -532 -87 -104 -98 -127 -105 -204 -4 -51 0 -71 20 -115 60 -131 189 -187 324 -143 38 13 67 35 127 97 l77 79 0 -455 c0 -436 1 -459 21 -511 39 -105 158 -177 269 -162 l47 6 16 -58 c30 -110 136 -192 246 -192 110 0 218 82 247 189 l17 61 47 -6 c121 -16 243 65 276 182 l16 61 72 0 c42 0 85 6 107 15 50 22 106 74 132 122 l22 41 3 790 c2 692 1 800 -13 869 -30 149 -95 273 -202 386 l-63 67 0 262 0 261 659 0 660 0 28 24 c27 23 28 28 26 106 -7 246 -137 499 -341 662 -121 96 -287 168 -429 184 l-52 7 -15 51 c-42 143 -158 330 -281 452 -251 249 -619 372 -960 323z m419 -203 c320 -96 558 -331 661 -652 43 -133 48 -138 166 -147 96 -8 215 -45 299 -94 84 -49 215 -180 263 -263 41 -71 87 -204 87 -251 l0 -29 -795 0 -796 0 -24 -26 c-34 -37 -33 -78 4 -115 29 -28 32 -29 135 -29 l106 0 0 -274 c0 -150 3 -287 6 -304 4 -20 36 -60 93 -119 93 -95 136 -168 168 -284 17 -59 18 -128 18 -837 l0 -774 -28 -24 c-38 -32 -81 -31 -112 2 l-25 27 0 349 0 350 -29 29 c-48 48 -111 36 -137 -26 -11 -28 -14 -120 -14 -492 0 -455 0 -457 -22 -480 -27 -29 -77 -30 -109 -4 l-24 19 -5 482 -5 482 -28 24 c-36 31 -78 31 -114 0 l-28 -24 -5 -600 c-5 -572 -6 -601 -24 -621 -27 -29 -85 -28 -114 2 -21 23 -21 25 -24 621 l-3 598 -28 24 c-38 33 -86 32 -118 -2 l-24 -26 -5 -480 -5 -480 -24 -19 c-32 -26 -82 -25 -109 4 l-22 24 3 624 3 624 29 91 30 92 85 21 c289 71 492 299 530 594 8 62 7 85 -4 112 -24 58 -84 73 -131 32 -22 -18 -28 -35 -36 -100 -5 -43 -17 -99 -25 -125 -65 -191 -235 -328 -437 -354 -111 -14 -132 -29 -147 -106 -41 -210 -177 -469 -305 -581 -43 -37 -94 -42 -125 -11 -40 40 -30 81 38 160 102 120 173 252 211 391 12 41 27 148 35 239 16 174 34 246 84 332 45 78 125 152 215 199 45 23 87 49 92 58 6 9 12 129 15 276 l5 260 108 5 c104 5 110 6 133 33 31 36 31 77 -1 111 l-24 26 -796 0 -795 0 0 29 c0 47 46 180 87 251 48 83 179 214 263 263 84 49 203 86 299 94 118 9 123 14 166 147 83 260 250 460 485 580 166 85 265 107 465 102 127 -3 164 -7 239 -30z" />
      </g>
    </svg>
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

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <polyline points="15 6 9 12 15 18" />
    </Icon>
  )
}

/**
 * Disclosure chevron used by collapsible section headers (Integrations,
 * Bridges). One chevron-right path that rotates on open/close and mirrors
 * automatically in RTL, so it shares the visual weight of the rest of the
 * nav icons and never falls back to the emoji font the way the old
 * Unicode triangle did on iOS Safari.
 *
 * Rotation map (closed points toward the content that will reveal; open
 * points down — the classic folder-disclosure mental model):
 *   ltr: closed 0° (→), open 90° (↓)
 *   rtl: closed 180° (←), open 90° (↓)
 *
 * Motion is gated behind `motion-safe:` so `prefers-reduced-motion`
 * collapses it to an instant state swap.
 */
export function DisclosureChevronIcon({
  open,
  className = 'w-4 h-4 shrink-0',
  style,
  ...rest
}: IconProps & { open: boolean }) {
  const { dir } = useI18n()
  const rotate = open ? 90 : dir === 'rtl' ? 180 : 0
  return (
    <Icon
      className={`${className} motion-safe:transition-transform motion-safe:duration-200 ease-out`}
      style={{ transform: `rotate(${rotate}deg)`, ...style }}
      {...rest}
    >
      <polyline points="9 6 15 12 9 18" />
    </Icon>
  )
}

/** Three-line hamburger — opens the mobile nav drawer. */
export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </Icon>
  )
}

/** X — close. Used on drawers, modals, dialogs. */
export function XIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </Icon>
  )
}

/** Three vertical dots — row-level actions menu trigger. */
export function MoreVerticalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </Icon>
  )
}

/** Plus — "add new workspace" affordance inside the mobile drawer. */
export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Icon>
  )
}

/** Filled check — the workspace marker inside the mobile drawer list. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <polyline points="20 6 9 17 4 12" />
    </Icon>
  )
}

/** Sun — "Light" theme button. */
export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m4.93 19.07 1.41-1.41" />
      <path d="m17.66 6.34 1.41-1.41" />
    </Icon>
  )
}

/** Moon — "Dark" theme button. */
export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </Icon>
  )
}

/** Monitor — "Auto / follow system" theme button. */
export function MonitorIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </Icon>
  )
}
