import { useI18n } from '../lib/i18n'

/**
 * Confirm-before-switch modal for the per-agent chat-model picker.
 *
 * Not destructive (unlike the delete modal) — just a short pause so the
 * operator sees which agent is changing and what from/to, plus a one-line
 * explanation that OpenClaw hot-reloads without restarting the container.
 * Superadmin-only today; when tenant self-serve ships the same modal can
 * be reused from the tenant-scoped route.
 */
export function SwitchModelModal({
  agentId,
  agentName,
  fromLabel,
  toLabel,
  inProgress,
  error,
  onConfirm,
  onCancel,
}: {
  agentId: string
  agentName: string
  fromLabel: string
  toLabel: string
  inProgress: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={inProgress ? undefined : onCancel} />
      <div className="relative bg-surface rounded-xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-brand-50 dark:bg-brand-100/20 flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5 text-brand"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-text-primary">
              {t({ he: 'החלפת מודל צ׳אט', en: 'Switch chat model' })}
            </h3>
            <p className="text-sm text-text-muted" dir="auto">{agentName}</p>
          </div>
        </div>

        <div className="bg-surface-soft rounded-lg p-3 space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-text-muted text-xs uppercase tracking-wide">
              {t({ he: 'מ־', en: 'From' })}
            </span>
            <span className="font-medium text-text-primary" dir="ltr">{fromLabel}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-text-muted text-xs uppercase tracking-wide">
              {t({ he: 'ל־', en: 'To' })}
            </span>
            <span className="font-medium text-text-primary" dir="ltr">{toLabel}</span>
          </div>
          <div className="flex items-center justify-between gap-3 pt-1 border-t border-border-light">
            <span className="text-text-muted text-xs">agent_id</span>
            <span className="font-mono text-xs text-text-secondary" dir="ltr">{agentId}</span>
          </div>
        </div>

        <p className="text-sm text-text-primary">
          {t({
            he: 'OpenClaw יבצע טעינה חמה תוך ~300ms. לא יוחמץ אף הודעה ולא יופעל מחדש הקונטיינר. ההגדרה נשמרת גם בסבבי תאמה (STICKY_PATHS).',
            en: 'OpenClaw hot-reloads within ~300ms — no message lost, no container restart. The choice also survives future template reconciles (STICKY_PATHS).',
          })}
        </p>

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
            disabled={inProgress}
            className="btn-brand btn-sm flex items-center gap-2"
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
              ? t({ he: 'מחליף…', en: 'Switching…' })
              : t({ he: 'החלף', en: 'Switch' })}
          </button>
        </div>
      </div>
    </div>
  )
}
