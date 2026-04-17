import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { useTheme, type Theme } from '../lib/theme'
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from './icons'

/**
 * Theme switcher — single icon button that opens a small dropdown of
 * options (Auto / Light / Dark). The trigger's glyph reflects the
 * user's current *preference*, not the resolved mode, so at a glance
 * you know whether you're on Auto vs pinned — Linear / GitHub pattern.
 *
 * Mobile toolbar space is precious, and the drawer's own theme section
 * (3 wide buttons) handles the flat-menu case. This compact variant is
 * for the desktop nav.
 */
export default function ThemeSwitcher() {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [open])

  const options: Array<{ value: Theme; label: string; icon: React.ReactNode }> = [
    {
      value: 'auto',
      label: t({ he: 'אוטומטי', en: 'Auto' }),
      icon: <MonitorIcon className="w-[14px] h-[14px]" />,
    },
    {
      value: 'light',
      label: t({ he: 'בהיר', en: 'Light' }),
      icon: <SunIcon className="w-[14px] h-[14px]" />,
    },
    {
      value: 'dark',
      label: t({ he: 'כהה', en: 'Dark' }),
      icon: <MoonIcon className="w-[14px] h-[14px]" />,
    },
  ]

  const activeOption = options.find((o) => o.value === theme) ?? options[0]
  const triggerLabel = t({ he: 'ערכת נושא', en: 'Theme' }) + ': ' + activeOption.label

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
        className="flex items-center justify-center w-9 h-9 rounded-lg text-text-secondary hover:text-text-primary hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
      >
        {activeOption.icon}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t({ he: 'בחירת ערכת נושא', en: 'Theme selection' })}
          className="absolute end-0 mt-2 w-[min(11rem,calc(100vw-1.5rem))] glass-card-elevated rounded-xl overflow-hidden z-30 animate-in-dropdown"
        >
          {options.map((opt) => {
            const selected = opt.value === theme
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitem"
                aria-current={selected ? 'true' : undefined}
                onClick={() => {
                  setTheme(opt.value)
                  setOpen(false)
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-3 min-h-[44px] text-sm text-start transition-colors cursor-pointer ${
                  selected
                    ? 'text-brand'
                    : 'text-text-primary hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                <span className={selected ? 'text-brand' : 'text-text-secondary'}>
                  {opt.icon}
                </span>
                <span className="flex-1">{opt.label}</span>
                {selected && <CheckIcon className="w-4 h-4 text-brand" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
