import { useI18n, type Lang } from '../lib/i18n'
import { GlobeIcon } from './icons'

/**
 * Compact two-state language toggle for the top nav.
 *
 * Renders as `🌐 עב | EN` with the active language highlighted. A small
 * globe icon prefixes the group so at a glance the cluster reads as
 * "language control" rather than "two random buttons". Clicking either
 * side calls `setLang`, which (via I18nProvider's useEffect) flips
 * `<html dir>` + `<html lang>` and triggers a re-render across the
 * whole tree. No page reload, no flicker.
 *
 * Deliberately minimal — no dropdown, no flags, no "auto" option. Two
 * languages, one click, instantly obvious.
 */
export default function LanguageSwitcher() {
  const { lang, setLang } = useI18n()

  const btn = (target: Lang, label: string) => (
    <button
      onClick={() => setLang(target)}
      aria-pressed={lang === target}
      aria-label={target === 'he' ? 'עברית' : 'English'}
      className={`inline-flex items-center justify-center min-w-[36px] h-9 px-2.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
        lang === target
          ? 'bg-text-primary text-surface'
          : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex items-center gap-0.5 border border-border-light rounded-lg ps-2 pe-1 py-0.5 bg-surface/60">
      <GlobeIcon className="w-[14px] h-[14px] text-text-muted" />
      {btn('he', 'עב')}
      {btn('en', 'EN')}
    </div>
  )
}
