import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { previewInvite, acceptInvite } from '../lib/api'
import type { InvitePreview } from '../lib/types'

/**
 * Public invite-acceptance page. Handles three states:
 *
 *   1. Not logged in  — shows the invite preview, offers Google sign-in
 *                        + email sign-in. After auth, page reloads, we
 *                        pick up the token from the URL again and
 *                        automatically POST /api/invites/accept.
 *   2. Logged in      — fetches preview, then calls accept, then
 *                        navigates to the tenant dashboard.
 *   3. Already accepted / revoked / expired — shows a clear message
 *                        and a link back to /.
 */
export default function InviteAcceptPage() {
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
      setError('Missing invite token.')
      setLoading(false)
      return
    }
    previewInvite(token)
      .then((p) => setPreviewState(p))
      .catch(() => setError('Invalid or expired invite link.'))
      .finally(() => setLoading(false))
  }, [token])

  // Auto-accept once the user is logged in and the preview is loaded.
  useEffect(() => {
    if (session && preview && preview.status === 'pending' && !accepted) {
      acceptInvite(token)
        .then((r) => setAccepted(r))
        .catch((err) => setError(err.message))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, preview])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">Loading invite...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="bg-white rounded-xl border border-red-200 p-8 max-w-md w-full text-center">
          <div className="text-red-600 text-3xl mb-3">⚠</div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Couldn't accept invite</h1>
          <p className="text-sm text-gray-600 mb-6">{error}</p>
          <a href="/" className="text-indigo-600 text-sm hover:underline">
            Back to Agentleh
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
            You're in!
          </h1>
          <p className="text-sm text-gray-600 mb-6">
            Welcome to <span className="font-medium">{accepted.tenant_name}</span>.
          </p>
          <button
            onClick={() => (window.location.href = `/tenants/${accepted.tenant_id}`)}
            className="w-full px-4 py-2 text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
          >
            Go to workspace
          </button>
        </div>
      </div>
    )
  }

  if (!preview) return null

  if (preview.status !== 'pending') {
    const label =
      preview.status === 'accepted' ? 'This invite has already been accepted.'
      : preview.status === 'revoked' ? 'This invite has been revoked.'
      : 'This invite has expired.'
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="bg-white rounded-xl border border-gray-200 p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Invite unavailable</h1>
          <p className="text-sm text-gray-600 mb-6">{label}</p>
          <a href="/" className="text-indigo-600 text-sm hover:underline">
            Back to Agentleh
          </a>
        </div>
      </div>
    )
  }

  // Pending, not logged in — show preview + auth prompt
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="bg-white rounded-xl border border-gray-200 p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-gray-900">You're invited</h1>
          <p className="text-sm text-gray-500 mt-2">
            <span className="font-medium">{preview.inviter_name}</span> invited you to join
          </p>
          <p className="text-lg font-semibold text-indigo-600 mt-1">{preview.tenant_name}</p>
          <p className="text-xs text-gray-500 mt-2">
            as <span className="font-medium uppercase">{preview.role}</span>
          </p>
        </div>

        {!session ? (
          <>
            <p className="text-sm text-gray-600 mb-4 text-center">
              Sign in with <span className="font-medium">{preview.email}</span> to accept:
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
              Continue with Google
            </button>
          </>
        ) : (
          <div className="text-center text-sm text-gray-600">Accepting invite...</div>
        )}
      </div>
    </div>
  )
}
