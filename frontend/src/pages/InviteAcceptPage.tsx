import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { previewInvite, acceptInvite } from '../lib/api'
import { useI18n, type Bilingual } from '../lib/i18n'
import type { InvitePreview } from '../lib/types'

/**
 * Public invite-acceptance page. Handles:
 *
 *   1. Not logged in  — shows the invite preview, offers Google
 *                        sign-in. After auth, the page reloads, we
 *                        pick up the token from the URL again and
 *                        auto-POST /api/invites/accept.
 *   2. Logged in      — fetches preview, calls accept, navigates to
 *                        the tenant dashboard.
 *   3. Already accepted / revoked / expired — clear error card with
 *                        a link back to /.
 *
 * Fully bilingual via useI18n. Direction inherited from <html dir>
 * which the I18nProvider keeps in sync with the active language.
 */
export default function InviteAcceptPage() {
  const { t } = useI18n()
  const [preview, setPreviewState] = useState<InvitePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState<{ tenant_id: number; tenant_name: string } | null>(null)
  const [session, setSession] = useState<any>(null)

  const token = new URLSearchParams(window.location.search).get('token') || ''

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
    })
  }, [])

  useEffect(() => {
    if (!token) {
      setError(t({ he: 'חסר טוקן להזמנה.', en: 'Missing invite token.' }))
      setLoading(false)
      return
    }
    previewInvite(token)
      .then((p) => setPreviewState(p))
      .catch(() =>
        setError(t({ he: 'קישור הזמנה לא תקין או פג תוקף.', en: 'Invalid or expired invite link.' })),
      )
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (session && preview && preview.status === 'pending' && !accepted) {
      acceptInvite(token)
        .then((r) => setAccepted(r))
        .catch((err) => setError(err.message))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, preview])

  const roleLabel = (role: string): Bilingual =>
    role === 'admin'
      ? { he: 'מנהל', en: 'admin' }
      : role === 'owner'
        ? { he: 'בעלים', en: 'owner' }
        : { he: 'חבר', en: 'member' }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">
          {t({ he: 'טוען הזמנה…', en: 'Loading invite…' })}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="bg-white rounded-xl border border-red-200 p-8 max-w-md w-full text-center">
          <div className="text-red-600 text-3xl mb-3">⚠</div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            {t({ he: 'לא הצלחנו לקבל את ההזמנה', en: "Couldn't accept invite" })}
          </h1>
          <p className="text-sm text-gray-600 mb-6">{error}</p>
          <a href="/" className="text-indigo-600 text-sm hover:underline">
            {t({ he: 'חזרה ל-Agentleh', en: 'Back to Agentleh' })}
          </a>
        </div>
      </div>
    )
  }

  if (accepted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="bg-white rounded-xl border border-green-200 p-8 max-w-md w-full text-center">
          <div className="text-green-600 text-4xl mb-3">✓</div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            {t({ he: 'הצטרפת!', en: "You're in!" })}
          </h1>
          <p className="text-sm text-gray-600 mb-6">
            {t({ he: 'ברוכ/ה הבא/ה ל-', en: 'Welcome to ' })}
            <span className="font-medium" dir="auto">
              {accepted.tenant_name}
            </span>
            .
          </p>
          <button
            onClick={() => (window.location.href = `/tenants/${accepted.tenant_id}`)}
            className="w-full px-4 py-2 text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
          >
            {t({ he: 'לסביבת העבודה', en: 'Go to workspace' })}
          </button>
        </div>
      </div>
    )
  }

  if (!preview) return null

  if (preview.status !== 'pending') {
    const label =
      preview.status === 'accepted'
        ? t({ he: 'ההזמנה כבר התקבלה.', en: 'This invite has already been accepted.' })
        : preview.status === 'revoked'
          ? t({ he: 'ההזמנה בוטלה.', en: 'This invite has been revoked.' })
          : t({ he: 'ההזמנה פגת תוקף.', en: 'This invite has expired.' })
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="bg-white rounded-xl border border-gray-200 p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            {t({ he: 'ההזמנה לא זמינה', en: 'Invite unavailable' })}
          </h1>
          <p className="text-sm text-gray-600 mb-6">{label}</p>
          <a href="/" className="text-indigo-600 text-sm hover:underline">
            {t({ he: 'חזרה ל-Agentleh', en: 'Back to Agentleh' })}
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="bg-white rounded-xl border border-gray-200 p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-gray-900">
            {t({ he: 'הוזמנת להצטרף', en: "You're invited" })}
          </h1>
          <p className="text-sm text-gray-500 mt-2">
            <span className="font-medium" dir="auto">
              {preview.inviter_name}
            </span>{' '}
            {t({ he: 'הזמינ/ה אותך להצטרף ל-', en: 'invited you to join' })}
          </p>
          <p className="text-lg font-semibold text-indigo-600 mt-1" dir="auto">
            {preview.tenant_name}
          </p>
          <p className="text-xs text-gray-500 mt-2">
            {t({ he: 'בתור ', en: 'as ' })}
            <span className="font-medium uppercase">{t(roleLabel(preview.role))}</span>
          </p>
        </div>

        {!session ? (
          <>
            <p className="text-sm text-gray-600 mb-4 text-center">
              {t({
                he: 'התחבר/י כדי לקבל את ההזמנה:',
                en: 'Sign in to accept the invite:',
              })}{' '}
              <span className="font-medium" dir="ltr">
                {preview.email}
              </span>
            </p>
            <button
              onClick={() =>
                supabase.auth.signInWithOAuth({
                  provider: 'google',
                  options: { redirectTo: window.location.href },
                })
              }
              className="w-full px-4 py-2 text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 mb-2"
            >
              {t({ he: 'המשך עם Google', en: 'Continue with Google' })}
            </button>
          </>
        ) : (
          <div className="text-center text-sm text-gray-600">
            {t({ he: 'מקבל את ההזמנה…', en: 'Accepting invite…' })}
          </div>
        )}
      </div>
    </div>
  )
}
