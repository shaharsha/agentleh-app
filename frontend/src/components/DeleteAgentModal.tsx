import { useState } from 'react'
import { useI18n } from '../lib/i18n'

/**
 * Type-the-agent-id-to-confirm deletion modal.
 *
 * Used from two places:
 *   - TenantPage (tenant admin deletes their own agent)
 *   - AdminPage  (superadmin deletes any tenant's agent)
 *
 * Both paths hit the same backend endpoint (DELETE /api/tenants/{tid}/agents/
 * {aid}) — the role-hierarchy bypass in get_active_tenant_member lets
 * superadmins through even when they aren't tenant members. See
 * tests/test_admin_delete_agent_bypass.py for the guarantee.
 *
 * Pass `extraWarning` when invoked from the superadmin panel so the
 * operator sees "this is a cross-tenant action" before typing the id.
 */
export function DeleteAgentModal({
  agentId,
  agentName,
  inProgress,
  error,
  onConfirm,
  onCancel,
  extraWarning,
}: {
  agentId: string
  agentName: string
  inProgress: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
  /** Optional extra banner surfaced above the type-to-confirm input.
   *  The admin panel uses this to flag "this affects a customer you
   *  don't belong to" so the operator doesn't delete by muscle memory. */
  extraWarning?: { he: string; en: string }
}) {
  const { t } = useI18n()
  const [confirmText, setConfirmText] = useState('')
  const confirmed = confirmText === agentId

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop — click to cancel unless we're mid-delete */}
      <div className="absolute inset-0 bg-black/40" onClick={inProgress ? undefined : onCancel} />
      <div className="relative bg-surface rounded-xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-danger-light flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5 text-danger"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-text-primary">
              {t({ he: 'מחיקת סוכן', en: 'Delete agent' })}
            </h3>
            <p className="text-sm text-text-muted" dir="auto">{agentName}</p>
          </div>
        </div>

        {extraWarning && (
          <div className="text-sm bg-warning-light text-warning-dark dark:text-amber-200 p-3 rounded border border-warning/30">
            {t(extraWarning)}
          </div>
        )}

        <p className="text-sm text-text-primary">
          {t({
            he: 'פעולה זו תמחק לצמיתות את הסוכן, הקונטיינר שלו, כל הנתונים וההגדרות. גיבוי ישמר למשך 90 יום. לא ניתן לבטל פעולה זו.',
            en: 'This will permanently delete the agent, its container, all data and configuration. A backup will be kept for 90 days. This cannot be undone.',
          })}
        </p>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            {t({
              he: 'הקלד את מזהה הסוכן לאישור:',
              en: 'Type the agent ID to confirm:',
            })}
          </label>
          <div className="text-xs text-text-muted font-mono mb-1.5" dir="ltr">
            {agentId}
          </div>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={agentId}
            dir="ltr"
            disabled={inProgress}
            className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500"
          />
        </div>

        {error && (
          <div className="text-sm text-danger dark:text-red-300 bg-danger-light p-3 rounded">
            {error}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={inProgress}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            {t({ he: 'ביטול', en: 'Cancel' })}
          </button>
          <button
            onClick={onConfirm}
            disabled={!confirmed || inProgress}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
          >
            {inProgress && (
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {inProgress
              ? t({ he: 'מוחק…', en: 'Deleting…' })
              : t({ he: 'מחק לצמיתות', en: 'Delete permanently' })}
          </button>
        </div>
      </div>
    </div>
  )
}
