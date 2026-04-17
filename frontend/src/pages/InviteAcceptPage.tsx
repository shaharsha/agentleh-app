import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { previewInvite, acceptInvite } from '../lib/api'
import { useI18n, type Bilingual } from '../lib/i18n'
import type { InvitePreview } from '../lib/types'

/**
 * Public invite-acceptance page. Handles:
 *
 *   1. Not logged in        — shows preview + Google sign-in. After auth
 *                              the page reloads and lands in case 2 or 3.
 *   2. Logged in, email matches the invite — shows preview + an explicit
 *                              "Accept invite" button. Never auto-accepts.
 *   3. Logged in, email mismatches — shows a "wrong account" warning
 *                              with a sign-out action so the user can
 *                              sign back in as the invited address.
 *   4. Invite already accepted / revoked / expired — clear error card.
 *
 * Invites are bound to the invitee identity. An owner clicking their own
 * invite link (sent to someone else) never silently demotes themselves,
 * because this page refuses to POST /accept on mismatch and the backend
 * also returns 403 if it ever does reach it.
 */
export default function InviteAcceptPage() {
  const { t } = useI18n()
  const [preview, setPreviewState] = useState<InvitePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState<{ tenant_id: number; tenant_name: string } | null>(null)
  const [session, setSession] = useState<any>(null)
  const [accepting, setAccepting] = useState(false)

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

  const roleLabel = (role: string): Bilingual =>
    role === 'admin'
      ? { he: 'מנהל', en: 'admin' }
      : role === 'owner'
        ? { he: 'בעלים', en: 'owner' }
        : { he: 'חבר', en: 'member' }

  const signedInEmail: string = session?.user?.email || ''
  const emailsMatch =
    !!preview && !!signedInEmail && preview.email.toLowerCase() === signedInEmail.toLowerCase()

  async function handleAccept() {
    if (!preview) return
    setAccepting(true)
    setError(null)
    try {
      const r = await acceptInvite(token)
      setAccepted(r)
    } catch (err: any) {
      const msg = err?.message || ''
      if (msg === 'invite_email_mismatch') {
        setError(
          t({
            he: 'ההזמנה שויכה לכתובת דוא"ל אחרת. התחבר/י עם הכתובת שאליה נשלחה ההזמנה.',
            en: "This invite is for a different email. Sign in with the address the invite was sent to.",
          }),
        )
      } else {
        setError(msg || t({ he: 'קבלת ההזמנה נכשלה.', en: 'Failed to accept invite.' }))
      }
    } finally {
      setAccepting(false)
    }
  }

  async function handleSwitchAccount() {
    await supabase.auth.signOut()
    window.location.reload()
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">
          {t({ he: 'טוען הזמנה…', en: 'Loading invite…' })}
        </div>
      </div>
    )
  }

  if (error && !preview) {
    return (
      <div className="min-h-screen flex items-center justify-center section-gradient p-6">
        <div className="glass-card-elevated rounded-xl border border-red-200 p-8 max-w-md w-full text-center">
          <div className="text-red-600 text-3xl mb-3">⚠</div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            {t({ he: 'לא הצלחנו לקבל את ההזמנה', en: "Couldn't accept invite" })}
          </h1>
          <p className="text-sm text-gray-600 mb-6">{error}</p>
          <a href="/" className="text-indigo-600 text-sm hover:underline">
            {t({ he: 'חזרה ל-Agentiko', en: 'Back to Agentiko' })}
          </a>
        </div>
      </div>
    )
  }

  if (accepted) {
    return (
      <div className="min-h-screen flex items-center justify-center section-gradient p-6">
        <div className="glass-card-elevated rounded-xl border border-green-200 p-8 max-w-md w-full text-center">
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
      <div className="min-h-screen flex items-center justify-center section-gradient p-6">
        <div className="glass-card-elevated rounded-xl p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            {t({ he: 'ההזמנה לא זמינה', en: 'Invite unavailable' })}
          </h1>
          <p className="text-sm text-gray-600 mb-6">{label}</p>
          <a href="/" className="text-indigo-600 text-sm hover:underline">
            {t({ he: 'חזרה ל-Agentiko', en: 'Back to Agentiko' })}
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="glass-card-elevated rounded-xl p-8 max-w-md w-full">
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
          <p className="text-xs text-gray-400 mt-3">
            {t({ he: 'ההזמנה נשלחה אל ', en: 'Sent to ' })}
            <span className="font-medium" dir="ltr">
              {preview.email}
            </span>
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}

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
        ) : !emailsMatch ? (
          <>
            <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">
              <p className="font-medium mb-1">
                {t({ he: 'חשבון לא נכון', en: 'Wrong account' })}
              </p>
              <p>
                {t({ he: 'את/ה מחובר/ת כ-', en: "You're signed in as " })}
                <span className="font-medium" dir="ltr">
                  {signedInEmail}
                </span>
                {t({
                  he: ' אבל ההזמנה נשלחה אל ',
                  en: ', but this invite was sent to ',
                })}
                <span className="font-medium" dir="ltr">
                  {preview.email}
                </span>
                .
              </p>
            </div>
            <button
              onClick={handleSwitchAccount}
              className="w-full px-4 py-2 text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
            >
              {t({
                he: 'התנתק/י והתחבר/י עם הכתובת הנכונה',
                en: 'Sign out and use the correct address',
              })}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleAccept}
              disabled={accepting}
              className="w-full px-4 py-2 text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-60"
            >
              {accepting
                ? t({ he: 'מקבל את ההזמנה…', en: 'Accepting…' })
                : t({ he: 'קבלת ההזמנה', en: 'Accept invite' })}
            </button>
            <button
              onClick={handleSwitchAccount}
              className="w-full mt-2 px-4 py-2 text-gray-600 text-sm hover:text-gray-900"
            >
              {t({ he: 'להחליף חשבון', en: 'Switch account' })}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
