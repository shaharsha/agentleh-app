import { useEffect } from 'react'

/**
 * Sets `document.title` for the life of the mounting component and
 * restores the previous title on unmount. Pass a translated string from
 * `useI18n()` so the tab reads in whichever language the user picked.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const prev = document.title
    document.title = title ? `${title} · agentiko` : 'agentiko'
    return () => {
      document.title = prev
    }
  }, [title])
}
