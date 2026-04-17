import { useI18n } from '../lib/i18n'
import { useTheme, type Theme } from '../lib/theme'
import { MonitorIcon, MoonIcon, SunIcon } from './icons'

/**
 * Tri-state theme toggle — Auto / Light / Dark. Renders as a compact
 * 3-button pill matching the LanguageSwitcher's visual language:
 *   🌓 | ☀ | 🌑
 *
 * `Auto` clears the user's explicit preference and follows
 * prefers-color-scheme. `Light` and `Dark` pin the data-theme attribute
 * regardless of OS. See [src/lib/theme.tsx](src/lib/theme.tsx) for the
 * storage + resolution rules.
 */
export default function ThemeSwitcher({ className = '' }: { className?: string }) {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()

  const labelFor = (target: Theme) =>
    target === 'light'
      ? t({ he: 'בהיר', en: 'Light' })
      : target === 'dark'
        ? t({ he: 'כהה', en: 'Dark' })
        : t({ he: 'אוטומטי', en: 'Auto' })

  const btn = (target: Theme, icon: React.ReactNode) => (
    <button
      key={target}
      type="button"
      onClick={() => setTheme(target)}
      aria-pressed={theme === target}
      aria-label={labelFor(target)}
      title={labelFor(target)}
      className={`inline-flex items-center justify-center w-9 h-9 rounded-md transition-colors cursor-pointer ${
        theme === target
          ? 'bg-gray-900 text-white dark:bg-white/15 dark:text-text-primary'
          : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {icon}
    </button>
  )

  return (
    <div
      role="radiogroup"
      aria-label={t({ he: 'בחירת ערכת נושא', en: 'Theme selection' })}
      className={`flex items-center gap-0.5 border border-border-light rounded-lg p-0.5 bg-surface/60 ${className}`}
    >
      {btn('auto', <MonitorIcon className="w-[14px] h-[14px]" />)}
      {btn('light', <SunIcon className="w-[14px] h-[14px]" />)}
      {btn('dark', <MoonIcon className="w-[14px] h-[14px]" />)}
    </div>
  )
}
