import { useEffect } from 'react'

const MARKER_KEY = '__agentleh_modal__'

/**
 * Make an open modal/drawer dismiss on the browser Back button without
 * leaving the page. Mobile users instinctively reach for Back to close
 * an overlay — without this hook they navigate away instead, losing
 * their place.
 *
 * Wiring:
 *   - When `open` flips to true, push a throwaway history entry tagged
 *     with our marker. The URL doesn't change (same pathname) so we
 *     don't pollute the back-stack with duplicate routes.
 *   - When a popstate fires and the new state isn't our marker, the
 *     user hit Back — call onClose.
 *   - When `open` flips to false via any other path (Esc, backdrop,
 *     button), pop the throwaway entry so Back still goes to the true
 *     previous page.
 */
export function useBackDismiss(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    if (typeof window === 'undefined') return

    const baseState = window.history.state
    window.history.pushState({ [MARKER_KEY]: true }, '')

    const onPop = () => {
      // We just popped OUR entry — user wants to close.
      onClose()
    }

    window.addEventListener('popstate', onPop)

    return () => {
      window.removeEventListener('popstate', onPop)
      // If we're unmounting/closing while our entry is still on top,
      // quietly pop it so the back-stack doesn't grow a dead rung.
      if (window.history.state && window.history.state[MARKER_KEY]) {
        window.history.back()
      }
      // `baseState` is captured for future extensions (restoring a
      // specific pre-open state); currently unused but kept to make the
      // intent obvious to the next reader.
      void baseState
    }
  }, [open, onClose])
}
