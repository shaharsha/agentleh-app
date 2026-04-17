/**
 * Theme store — module-level source of truth for Auto / Light / Dark.
 *
 * Lives outside React for two reasons:
 *   1. `useSyncExternalStore` is the idiomatic hook for this shape of
 *      state (external to React, subscribe/snapshot pattern). Avoids
 *      React 19's `react-hooks/set-state-in-effect` lint friction that
 *      trips the naïve "useState + useEffect hydrate from localStorage"
 *      pattern, and keeps hydration clean when running under SSR.
 *   2. The pre-React `<script>` in index.html has already set
 *      data-theme before first paint; the React store just mirrors
 *      what's already on <html> so nothing flashes.
 *
 * Persistence: `localStorage['agentleh.theme']` holds the user's
 * explicit pick. Auto clears the key — that's the default.
 *
 * Cross-tab sync: a `storage`-event listener propagates theme changes
 * across open tabs on the same origin so picking Dark in one tab
 * updates the rest without a reload.
 */

export type Theme = 'auto' | 'light' | 'dark'

export interface ThemeState {
  theme: Theme
  /** Effective mode actually rendered. Follows OS when `theme === 'auto'`. */
  resolved: 'light' | 'dark'
}

const LS_KEY = 'agentleh.theme'
const SSR_SNAPSHOT: ThemeState = { theme: 'auto', resolved: 'light' }

let currentState: ThemeState = SSR_SNAPSHOT
const listeners = new Set<() => void>()

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function computeResolved(theme: Theme): 'light' | 'dark' {
  return theme === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : theme
}

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'auto'
  try {
    const v = window.localStorage.getItem(LS_KEY)
    if (v === 'light' || v === 'dark' || v === 'auto') return v
  } catch {
    // localStorage disabled — fall through to default
  }
  return 'auto'
}

function applyAttribute(mode: 'light' | 'dark') {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', mode)
}

function notify() {
  listeners.forEach((cb) => cb())
}

// ─── Client-side initialisation ──────────────────────────────────────
if (typeof window !== 'undefined') {
  const theme = readStoredTheme()
  const resolved = computeResolved(theme)
  currentState = { theme, resolved }
  applyAttribute(resolved)

  // OS change listener — always registered, only propagates on Auto.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentState.theme !== 'auto') return
    const next = computeResolved('auto')
    currentState = { theme: 'auto', resolved: next }
    applyAttribute(next)
    notify()
  })

  // Cross-tab sync. `storage` fires in every *other* tab of the same
  // origin when localStorage changes — never in the tab that did the
  // write, so there's no feedback loop. A `null` newValue means the
  // key was removed, which for us means "user switched back to Auto".
  window.addEventListener('storage', (e) => {
    if (e.key !== LS_KEY) return
    const next: Theme =
      e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : 'auto'
    const resolved = computeResolved(next)
    currentState = { theme: next, resolved }
    applyAttribute(resolved)
    notify()
  })
}

export function setTheme(next: Theme) {
  const resolved = computeResolved(next)
  currentState = { theme: next, resolved }
  applyAttribute(resolved)
  try {
    if (next === 'auto') window.localStorage.removeItem(LS_KEY)
    else window.localStorage.setItem(LS_KEY, next)
  } catch {
    // localStorage disabled — in-memory state still updates
  }
  notify()
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getSnapshot(): ThemeState {
  return currentState
}

export function getServerSnapshot(): ThemeState {
  return SSR_SNAPSHOT
}
