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
 * Tiny bilingual i18n system — zero dependencies, ~80 lines.
 *
 * The entire app is Hebrew-first but has a growing number of English
 * users (collaborators invited into Hebrew workspaces, international
 * clients, etc.). Rather than pull in 50 KB of react-i18next we build
 * a minimal provider that takes inline bilingual objects:
 *
 *     const { t, tn, lang, setLang } = useI18n()
 *     <h2>{t({ he: 'חברים', en: 'Members' })}</h2>
 *     <span>{tn({
 *       one:   { he: 'חבר אחד', en: '1 member' },
 *       other: { he: `${n} חברים`, en: `${n} members` },
 *     }, n)}</span>
 *     <button onClick={() => setLang('en')}>English</button>
 *
 * Benefits of the inline-object pattern vs a flat dictionary:
 *   - Both translations live next to the use site — reviewers never
 *     hunt through a separate JSON file to verify a string change.
 *   - No "missing key" class of bug — every call site is type-checked.
 *   - No namespaces / loader machinery / build-time extraction.
 *   - Trivial for the parallel TTS / Gmail plans to adopt without
 *     learning a new library.
 *
 * The active language lives in localStorage (`agentleh.lang`). On every
 * change the provider updates `document.documentElement.lang` and
 * `document.documentElement.dir` so every child element inherits the
 * right direction from the root — no per-page `dir="ltr"` band-aids.
 * Hebrew is the default for first-time visitors; English is opt-in.
 *
 * Plural rules: Hebrew has a richer plural system than English (dual,
 * many, etc.), but the strings currently used in the app only need
 * singular + plural, so `tn` ships with just `one` / `other`. Add more
 * forms to the Bilingual shape when a real use case appears — the
 * switch is per-call-site so it won't break existing callers.
 */

export type Lang = 'he' | 'en'
export type Dir = 'rtl' | 'ltr'

export interface Bilingual {
  he: string
  en: string
}

export interface I18nContextValue {
  lang: Lang
  dir: Dir
  setLang: (lang: Lang) => void
  t: (b: Bilingual) => string
  tn: (b: { one: Bilingual; other: Bilingual }, count: number) => string
}

const LS_KEY = 'agentleh.lang'

const I18nContext = createContext<I18nContextValue | null>(null)

/**
 * Resolution order on first mount:
 *   1. Explicit user choice from localStorage — if `setLang` has ever
 *      run, we honor it forever (even if the browser language later
 *      changes). The user clicked the switcher; we don't override.
 *   2. Browser locale detection via navigator.languages (ordered
 *      preference list). Walk the list, pick the first supported
 *      primary tag. `iw` is the deprecated ISO 639-1 code for Hebrew —
 *      Chrome on some builds still emits it, so we normalize.
 *   3. Product-default fallback: Hebrew. Agentleh is Israeli-first and
 *      any unsupported browser language (French, Arabic, etc.) is more
 *      likely to belong to a user who can read Hebrew than random
 *      English — we pick Hebrew over English as the "unknown" fallback.
 *
 * We deliberately do NOT write the detected language to localStorage.
 * Only `setLang()` persists. That way a detected preference stays
 * dynamic: a user whose browser language changes (new device, travel,
 * OS language flip) re-detects on next visit. Once they explicitly
 * pick via the switcher, that pin overrides detection forever.
 *
 * Must match the pre-React inline script in index.html — the script
 * runs before this code mounts so there's no flash of the wrong
 * direction on first paint, and the two detection paths need to agree.
 */
function pickInitialLang(): Lang {
  if (typeof window === 'undefined') return 'he'

  // 0. Handoff from the landing page via ?lang=he|en. localStorage
  //    isn't shared across agentiko.io ↔ app.agentiko.io, so the
  //    landing passes the visitor's chosen language via URL param when
  //    they click "Sign up". Persist it to localStorage and strip the
  //    param so the clean URL replaces it in history — no bookmark
  //    pollution, and ?lang= can't silently override a later explicit
  //    switcher click.
  try {
    const url = new URL(window.location.href)
    const param = url.searchParams.get('lang')
    if (param === 'he' || param === 'en') {
      window.localStorage.setItem(LS_KEY, param)
      url.searchParams.delete('lang')
      window.history.replaceState(null, '', url.pathname + url.search + url.hash)
      return param
    }
  } catch {
    // URL parsing / localStorage disabled — fall through to the next step
  }

  // 1. Explicit saved choice
  const saved = window.localStorage.getItem(LS_KEY)
  if (saved === 'he' || saved === 'en') return saved

  // 2. Browser locale walk
  const langs =
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || 'he']
  for (const raw of langs) {
    const primary = String(raw).toLowerCase().split('-')[0]
    if (primary === 'he' || primary === 'iw') return 'he'
    if (primary === 'en') return 'en'
  }

  // 3. Product default
  return 'he'
}

export function dirFor(lang: Lang): Dir {
  return lang === 'he' ? 'rtl' : 'ltr'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(pickInitialLang)

  useEffect(() => {
    const root = document.documentElement
    root.lang = lang
    root.dir = dirFor(lang)
  }, [lang])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      window.localStorage.setItem(LS_KEY, next)
    } catch {
      // localStorage can throw in private mode — ignore, the in-memory
      // state still updates so the switch works for the session.
    }
  }, [])

  const value = useMemo<I18nContextValue>(() => {
    const t = (b: Bilingual) => b[lang]
    const tn = (b: { one: Bilingual; other: Bilingual }, count: number) =>
      (count === 1 ? b.one : b.other)[lang]
    return { lang, dir: dirFor(lang), setLang, t, tn }
  }, [lang, setLang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    throw new Error('useI18n must be used inside <I18nProvider>')
  }
  return ctx
}
