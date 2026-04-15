import { useI18n, type Lang } from '../lib/i18n'

/**
 * Compact two-state language toggle for the top nav.
 *
 * Renders as "עב | EN" with the active language highlighted. Clicking
 * either side calls `setLang`, which (via I18nProvider's useEffect)
 * flips `<html dir>` + `<html lang>` and triggers a re-render across
 * the whole tree. No page reload, no flicker.
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
      className={`px-2 py-0.5 text-xs font-semibold rounded transition-colors ${
        lang === target
          ? 'bg-gray-900 text-white'
          : 'text-gray-500 hover:text-gray-800'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex items-center gap-1 border border-gray-200 rounded-md p-0.5 bg-white/50">
      {btn('he', 'עב')}
      {btn('en', 'EN')}
    </div>
  )
}
