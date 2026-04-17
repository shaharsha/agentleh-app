import { useSyncExternalStore } from 'react'
import {
  getServerSnapshot,
  getSnapshot,
  setTheme,
  subscribe,
  type Theme,
} from './themeStore'

export type { Theme }

export interface ThemeContextValue {
  theme: Theme
  resolved: 'light' | 'dark'
  setTheme: (t: Theme) => void
}

/**
 * Theme hook. Reads from a module-level store (`./themeStore.ts`) via
 * `useSyncExternalStore`, which is React's official API for syncing
 * with external mutable state. No Context provider needed — importing
 * the store anywhere kicks off its client-side init (listeners for OS
 * changes + cross-tab `storage` events).
 *
 * The store also maintains `html[data-theme]` in sync with the current
 * resolved mode; all theme-aware CSS keys off that attribute.
 */
export function useTheme(): ThemeContextValue {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return { theme: state.theme, resolved: state.resolved, setTheme }
}
