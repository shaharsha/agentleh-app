import { useState } from 'react'
import { submitOnboarding, type ProvisionProgress } from '../lib/api'
import ProvisionProgressBar from '../components/ProvisionProgressBar'
import StepIndicator from '../components/StepIndicator'
import VoicePicker from '../components/VoicePicker'
import { useI18n } from '../lib/i18n'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import type { AppUser } from '../lib/types'

interface OnboardingPageProps {
  user: AppUser
  onComplete: () => void
}

export default function OnboardingPage({ user, onComplete }: OnboardingPageProps) {
  const { t, dir } = useI18n()
  useDocumentTitle(t({ he: 'הגדרת סוכן', en: 'Onboarding' }))
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<ProvisionProgress>({
    step: 0,
    total: 4,
    label: 'Connecting…',
  })
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState({
    full_name: user.full_name || '',
    phone: '',
    gender: '',
    agent_name: '',
    agent_gender: '',
    // Voice picker default — VoicePicker writes the manifest's default_voice
    // ('Kore') here once the manifest loads, so isValid still flips true once
    // the user fills the other required fields.
    tts_voice_name: '',
  })

  function update(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    // When creating without a phone the backend skips the welcome-send
    // step, so the bar ends at 4/4 instead of 5/5. Mirrors the total
    // the backend will stream back on its first `progress` tick.
    const initialTotal = form.phone ? 5 : 4
    setProgress({ step: 0, total: initialTotal, label: 'Connecting…' })
    try {
      await submitOnboarding(form, (p) => setProgress(p))
      onComplete()
    } catch (err) {
      setError(
        (err as Error).message ||
          t({ he: 'שגיאה ביצירת הסוכן', en: 'Failed to create agent' }),
      )
    } finally {
      setLoading(false)
    }
  }

  // Phone is optional — mirrors the standalone agent-create flow in
  // TenantPage. User can connect WhatsApp later from the Bridges panel.
  const isValid =
    form.full_name &&
    form.gender &&
    form.agent_name &&
    form.agent_gender &&
    form.tts_voice_name

  const genderOptions: [string, string][] = [
    ['male', t({ he: 'זכר', en: 'Male' })],
    ['female', t({ he: 'נקבה', en: 'Female' })],
  ]

  return (
    <div>
      <StepIndicator
        steps={[
          t({ he: 'תוכנית', en: 'Plan' }),
          t({ he: 'הגדרות', en: 'Setup' }),
          t({ he: 'מוכן', en: 'Ready' }),
        ]}
        current={1}
      />

      <div className="text-center mb-8 sm:mb-10">
        <h2 className="text-[clamp(22px,6vw,28px)] font-bold tracking-[-0.6px] mb-2">
          {t({ he: 'הגדרות', en: 'Setup' })}
        </h2>
        <p className="text-[clamp(14px,3.5vw,15px)] text-text-secondary">
          {t({
            he: 'ספר לנו קצת על עצמך ועל הסוכן שלך',
            en: 'Tell us a bit about yourself and your agent',
          })}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
        {/* User section */}
        <section className="glass-card-elevated rounded-[18px] sm:rounded-[22px] p-4 sm:p-6 space-y-4">
          <div className="flex items-center gap-2.5 mb-2">
            <div className="w-9 h-9 rounded-[12px] bg-brand-50 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B85A3A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <h3 className="text-[16px] font-semibold">
              {t({ he: 'עליך', en: 'About you' })}
            </h3>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              {t({ he: 'שם מלא', en: 'Full name' })}
            </label>
            <input
              value={form.full_name}
              onChange={(e) => update('full_name', e.target.value)}
              required
              autoComplete="name"
              dir={dir}
              className="input-glass w-full px-4 py-3 text-[15px]"
              placeholder={t({ he: 'השם שלך', en: 'Your name' })}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              {t({
                he: 'טלפון (WhatsApp) — לא חובה',
                en: 'Phone (WhatsApp) — optional',
              })}
            </label>
            <input
              value={form.phone}
              onChange={(e) => update('phone', e.target.value)}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={20}
              dir="ltr"
              aria-describedby="onboarding-phone-help"
              className="input-glass w-full px-4 py-3 text-[15px]"
              placeholder="050-123-4567"
            />
            <p id="onboarding-phone-help" className="text-[12px] text-text-muted mt-1.5">
              {t({
                he: 'אפשר להשאיר ריק ולחבר וואטסאפ מאוחר יותר מתוך לשונית "גשרים" של הסוכן.',
                en: "Leave empty to create without WhatsApp — you can connect it later from the agent's Bridges panel.",
              })}
            </p>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              {t({ he: 'מגדר', en: 'Gender' })}
            </label>
            <TogglePair
              value={form.gender}
              onChange={(v) => update('gender', v)}
              options={genderOptions}
            />
          </div>
        </section>

        {/* Agent section */}
        <section className="glass-card-elevated rounded-[18px] sm:rounded-[22px] p-4 sm:p-6 space-y-4">
          <div className="flex items-center gap-2.5 mb-2">
            <div className="w-9 h-9 rounded-[12px] bg-brand-50 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B85A3A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h3 className="text-[16px] font-semibold">
              {t({ he: 'הסוכן שלך', en: 'Your agent' })}
            </h3>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              {t({ he: 'שם הסוכן', en: 'Agent name' })}
            </label>
            <input
              value={form.agent_name}
              onChange={(e) => update('agent_name', e.target.value)}
              required
              autoComplete="off"
              dir={dir}
              className="input-glass w-full px-4 py-3 text-[15px]"
              placeholder={t({ he: 'לדוגמה: שולי', en: 'e.g. Luna' })}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              {t({ he: 'מגדר הסוכן', en: 'Agent gender' })}
            </label>
            <TogglePair
              value={form.agent_gender}
              onChange={(v) => update('agent_gender', v)}
              options={genderOptions}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              {t({ he: 'הקול של הסוכן בהודעות קוליות', en: "Agent's voice for voice messages" })}
            </label>
            <p className="text-[12px] text-text-secondary mb-2">
              {t({
                he: 'לחץ על קול כדי לשמוע אותו ולבחור אותו. הסוכן ישתמש בקול הזה כאשר ישלח הודעות קוליות בוואטסאפ.',
                en: 'Click a voice to preview and select it. Your agent will use this voice for WhatsApp voice messages.',
              })}
            </p>
            {form.agent_gender ? (
              <VoicePicker
                value={form.tts_voice_name}
                onChange={(v) => update('tts_voice_name', v)}
                lockedGender={form.agent_gender as 'male' | 'female'}
              />
            ) : (
              <div className="glass-card rounded-[16px] p-4 text-center text-[13px] text-text-secondary">
                {t({
                  he: 'בחר את מגדר הסוכן למעלה כדי לראות את הקולות המתאימים',
                  en: 'Pick an agent gender above to see matching voices',
                })}
              </div>
            )}
          </div>
        </section>

        {loading ? (
          <div className="glass-card-elevated rounded-[18px] sm:rounded-[22px] p-4 sm:p-6 space-y-4">
            <ProvisionProgressBar
              progress={progress}
              provisioning={loading}
              heading={t({ he: 'מקים את הסוכן…', en: 'Provisioning your agent…' })}
            />
            {error && (
              <div className="text-[13px] text-danger dark:text-red-300 bg-danger-light p-3 rounded-lg">
                {error}
              </div>
            )}
          </div>
        ) : (
          <>
            {error && (
              <div className="text-[13px] text-danger dark:text-red-300 bg-danger-light p-3 rounded-lg">
                {error}
              </div>
            )}
            <button type="submit" disabled={!isValid}
              className="btn-brand w-full">
              {t({ he: 'צור את הסוכן שלי', en: 'Create my agent' })}
            </button>
          </>
        )}
      </form>
    </div>
  )
}

function TogglePair({ value, onChange, options }: {
  value: string
  onChange: (v: string) => void
  options: [string, string][]
}) {
  return (
    <div className="flex gap-3">
      {options.map(([val, label]) => (
        <button
          key={val} type="button" onClick={() => onChange(val)}
          className={`flex-1 ${
            value === val ? 'btn-brand btn-md' : 'btn-secondary'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
