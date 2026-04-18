import { useI18n } from '../lib/i18n'
import type { ProvisionProgress } from '../lib/api'

interface ProvisionProgressBarProps {
  progress: ProvisionProgress
  provisioning: boolean
  /** Label shown above the percentage. Both call sites render this
   *  slightly differently (onboarding: "Provisioning your agent…",
   *  dashboard: "Creating agent…") so we take it as a prop. */
  heading: string
}

// Translate the backend's English progress label into a bilingual
// display, preserving the "(N/30)" sub-tick the VM emits during the
// health-check wait so the user sees continuous motion through the
// longest phase of provisioning.
function translateLabel(rawLabel: string): { he: string; en: string } {
  const match = /Waiting for agent to be ready(?:\s*\((\d+)\/(\d+)\))?/.exec(rawLabel)
  if (match) {
    const sub = match[1] ? ` (${match[1]}/${match[2]})` : ''
    return {
      he: `בודק תקינות${sub}…`,
      en: `Waiting for agent to be ready${sub}…`,
    }
  }
  if (/Preparing workspace/i.test(rawLabel))
    return { he: 'מכין סביבת עבודה…', en: 'Preparing workspace…' }
  if (/Setting up database/i.test(rawLabel))
    return { he: 'מעדכן בסיס נתונים…', en: 'Setting up database…' }
  if (/Starting container/i.test(rawLabel))
    return { he: 'מפעיל קונטיינר…', en: 'Starting container…' }
  if (/welcome message/i.test(rawLabel))
    return { he: 'שולח הודעת ברוכים הבאים…', en: 'Sending welcome message…' }
  return { he: rawLabel, en: rawLabel }
}

// Default label for a step we haven't seen a progress event for yet —
// keeps the checklist readable before the stream reaches that step.
function defaultEnLabel(step: number): string {
  return (
    [
      'Preparing workspace',
      'Setting up database',
      'Starting container',
      'Waiting for agent to be ready',
      'Sending welcome message',
    ][step - 1] || `Step ${step}`
  )
}

export default function ProvisionProgressBar({
  progress,
  provisioning,
  heading,
}: ProvisionProgressBarProps) {
  const { t } = useI18n()

  // Extract the (N/30) sub-tick out of the live label so we can both
  // weight the overall bar smoothly during step 4 AND render a small
  // secondary bar under the active step — the VM takes ~60–90s on this
  // step alone and a single coarse tick would feel frozen.
  const subMatch = /\((\d+)\/(\d+)\)/.exec(progress.label || '')
  const subTick = subMatch ? parseInt(subMatch[1], 10) : 0
  const subTotal = subMatch ? parseInt(subMatch[2], 10) : 30

  // Weighted progress: step 4 dominates the real elapsed time so it
  // gets a matching slice (35% → 85%). Reserve the final % for the
  // "done" moment so we never show 100% while still provisioning.
  //
  //   step 0 (connecting)    →  3%
  //   step 1 (workspace)     → 15%
  //   step 2 (database)      → 25%
  //   step 3 (container up)  → 35%
  //   step 4 (N/30 ticks)    → 35% + (N/30) * 50%   (up to 85%)
  //   step 5 (welcome send)  → 92%
  //   result(success)        → 100% (set by caller when stream resolves)
  let progressPct: number
  if (!provisioning) {
    progressPct = 0
  } else if (progress.step === 0) {
    progressPct = 3
  } else if (progress.step === 1) {
    progressPct = 15
  } else if (progress.step === 2) {
    progressPct = 25
  } else if (progress.step === 3) {
    progressPct = 35
  } else if (progress.step === 4) {
    const sub = subTotal > 0 ? Math.min(1, subTick / subTotal) : 0
    progressPct = Math.round(35 + sub * 50)
  } else {
    progressPct = 92
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm text-text-primary">
        <span className="font-medium">{heading}</span>
        <span className="tabular-nums text-text-muted">{progressPct}%</span>
      </div>
      {/* 700ms easing smooths burst-delivered events — Cloud Run sometimes
          buffers several seconds of progress ticks and flushes them as a
          batch. Without the transition the bar would teleport. */}
      <div className="h-1.5 bg-border rounded-full overflow-hidden">
        <div
          className="h-full bg-brand rounded-full transition-all duration-700 ease-out"
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <ul className="space-y-2 text-sm">
        {Array.from({ length: progress.total || 5 }).map((_, i) => {
          const stepNum = i + 1
          const done = progress.step > stepNum
          const active = progress.step === stepNum
          const label = active
            ? translateLabel(progress.label)
            : translateLabel(defaultEnLabel(stepNum))
          // Render the (N/30) secondary bar only under the active
          // health-check step — that's the only place the VM emits a
          // sub-tick and the only place the user needs reassurance of
          // continuous motion.
          const isHealthStep = active && stepNum === 4 && subMatch
          return (
            <li key={i} className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0">
                {done ? (
                  <svg
                    className="w-4 h-4 text-success"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : active ? (
                  <svg
                    className="w-4 h-4 text-brand animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
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
                ) : (
                  <div className="w-4 h-4 rounded-full border-2 border-border" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className={
                    done
                      ? 'text-text-muted'
                      : active
                        ? 'text-text-primary font-medium'
                        : 'text-text-muted'
                  }
                >
                  {t(label)}
                </div>
                {isHealthStep && (
                  <div className="mt-1 h-0.5 bg-border rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-light rounded-full transition-all duration-700 ease-out"
                      style={{ width: `${Math.round((subTick / subTotal) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
