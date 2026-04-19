/**
 * Cross-origin preference cookies (language + theme).
 *
 * localStorage is origin-scoped, so `agentiko.io` and `app.agentiko.io`
 * can't read each other's picks. A cookie scoped to `.agentiko.io` rides
 * top-level navigations between the two surfaces, giving us a single
 * source of truth that's visible to both. localStorage stays in use as a
 * per-origin mirror — it powers within-origin cross-tab sync via the
 * `storage` event, and keeps the detection path working for users who
 * set a preference before the cookie rollout.
 *
 * Keep this module in lockstep with the twin in `landing/src/lib/` —
 * cookie names, values, and attributes must match exactly.
 */

export const LANG_COOKIE = 'agentleh.lang'
export const THEME_COOKIE = 'agentleh.theme'
const MAX_AGE_SEC = 60 * 60 * 24 * 365

function cookieDomainAttr(): string {
  if (typeof location === 'undefined') return ''
  const h = location.hostname
  if (h.endsWith('agentiko.io')) return '; Domain=.agentiko.io'
  return ''
}

function secureAttr(): string {
  if (typeof location === 'undefined') return ''
  return location.protocol === 'https:' ? '; Secure' : ''
}

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const prefix = name + '='
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trimStart()
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length))
      } catch {
        return trimmed.slice(prefix.length)
      }
    }
  }
  return null
}

export function writeCookie(name: string, value: string) {
  if (typeof document === 'undefined') return
  document.cookie =
    `${name}=${encodeURIComponent(value)}` +
    `; Path=/` +
    `; Max-Age=${MAX_AGE_SEC}` +
    `; SameSite=Lax` +
    cookieDomainAttr() +
    secureAttr()
}

export function clearCookie(name: string) {
  if (typeof document === 'undefined') return
  document.cookie =
    `${name}=` +
    `; Path=/` +
    `; Max-Age=0` +
    `; SameSite=Lax` +
    cookieDomainAttr() +
    secureAttr()
}
