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

function pickInitialLang(): Lang {
  if (typeof window === 'undefined') return 'he'
  const saved = window.localStorage.getItem(LS_KEY)
  if (saved === 'he' || saved === 'en') return saved
  return 'he' // product default
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
