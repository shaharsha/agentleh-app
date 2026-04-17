import { useEffect, useRef, useState } from 'react'
import { useI18n, type Lang } from '../lib/i18n'
import { CheckIcon, GlobeIcon } from './icons'

/**
 * Language switcher — single globe-icon button that opens a small
 * dropdown with both language names. Matches ThemeSwitcher's pattern:
 * compact toolbar real-estate, clear current selection via checkmark.
 *
 * We show the native name ("עברית" / "English") rather than a flag
 * because flags map to countries, not languages — and mixing "עב" vs
 * "EN" codes in the trigger would be a tiny target anyway. The full
 * name sits comfortably in the menu.
 */
export default function LanguageSwitcher() {
  const { lang, setLang, t } = useI18n()
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

  const options: Array<{ value: Lang; label: string }> = [
    { value: 'he', label: 'עברית' },
    { value: 'en', label: 'English' },
  ]

  const activeLabel = options.find((o) => o.value === lang)?.label ?? ''
  const triggerLabel = t({ he: 'שפה', en: 'Language' }) + ': ' + activeLabel

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
        <GlobeIcon className="w-[14px] h-[14px]" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t({ he: 'בחירת שפה', en: 'Language selection' })}
          className="absolute end-0 mt-2 w-[min(10rem,calc(100vw-1.5rem))] glass-card-elevated rounded-xl overflow-hidden z-30 animate-in-dropdown"
        >
          {options.map((opt) => {
            const selected = opt.value === lang
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitem"
                aria-current={selected ? 'true' : undefined}
                dir={opt.value === 'he' ? 'rtl' : 'ltr'}
                onClick={() => {
                  setLang(opt.value)
                  setOpen(false)
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-3 min-h-[44px] text-sm text-start transition-colors cursor-pointer ${
                  selected
                    ? 'text-brand'
                    : 'text-text-primary hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
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
