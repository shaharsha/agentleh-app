import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * Theme provider — tri-state: `auto` (follow OS), `light`, `dark`.
 *
 * The source of truth for the CSS is a `data-theme` attribute on
 * <html>. When `auto` is active we clear the attribute so the stylesheet
 * falls back to `@media (prefers-color-scheme: dark)`. When the user
 * picks Light or Dark we set the attribute to the matching value, and
 * the higher-specificity `html[data-theme="dark"]` / `[data-theme="light"]`
 * selectors in index.css win over the media query either direction.
 *
 * Persistence key: `agentleh.theme`. Must match the pre-React inline
 * script in index.html that pre-applies the attribute before mount so
 * there's no light-flash on first paint when the user has picked Dark.
 */

export type Theme = 'auto' | 'light' | 'dark'

export interface ThemeContextValue {
  /** The user's explicit choice (what the switcher shows as selected). */
  theme: Theme
  /** The resolved mode actually rendering — useful for conditional UI
   *  (e.g. picking an illustration variant). Follows the OS when theme
   *  is 'auto'. */
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
}

const LS_KEY = 'agentleh.theme'
const ThemeContext = createContext<ThemeContextValue | null>(null)

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'auto'
  try {
    const saved = window.localStorage.getItem(LS_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'auto') return saved
  } catch {
    // localStorage disabled — stay on auto
  }
  return 'auto'
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'auto') return systemPrefersDark() ? 'dark' : 'light'
  return theme
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(readStoredTheme()))

  // Apply to <html> whenever the theme state changes. Unlike the older
  // "remove attribute on auto, let @media take over" pattern, we always
  // pin data-theme to the resolved value ('light' or 'dark') so the CSS
  // only needs one selector per mode and stays dead simple.
  useEffect(() => {
    const next = resolveTheme(theme)
    document.documentElement.setAttribute('data-theme', next)
    setResolved(next)
  }, [theme])

  // Keep `resolved` (and data-theme) in sync with OS changes while the
  // user is on 'auto'. Manually-chosen modes don't bounce with the OS.
  useEffect(() => {
    if (theme !== 'auto') return
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const next = mq.matches ? 'dark' : 'light'
      document.documentElement.setAttribute('data-theme', next)
      setResolved(next)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      if (next === 'auto') {
        window.localStorage.removeItem(LS_KEY)
      } else {
        window.localStorage.setItem(LS_KEY, next)
      }
    } catch {
      // localStorage disabled — in-memory state still updates
    }
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>')
  }
  return ctx
}
