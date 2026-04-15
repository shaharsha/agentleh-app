import { useState } from 'react'
import { submitOnboarding } from '../lib/api'
import StepIndicator from '../components/StepIndicator'
import VoicePicker from '../components/VoicePicker'
import type { AppUser } from '../lib/types'

interface OnboardingPageProps {
  user: AppUser
  onComplete: () => void
}

export default function OnboardingPage({ user, onComplete }: OnboardingPageProps) {
  const [loading, setLoading] = useState(false)
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
    try {
      await submitOnboarding(form)
      onComplete()
    } catch {
      alert('שגיאה ביצירת הסוכן')
    } finally {
      setLoading(false)
    }
  }

  const isValid =
    form.full_name &&
    form.phone &&
    form.gender &&
    form.agent_name &&
    form.agent_gender &&
    form.tts_voice_name

  return (
    <div>
      <StepIndicator steps={['תוכנית', 'הגדרות', 'מוכן']} current={1} />

      <div className="text-center mb-10">
        <h2 className="text-[28px] font-bold tracking-[-0.6px] mb-2">הגדרות</h2>
        <p className="text-[15px] text-text-secondary">ספר לנו קצת על עצמך ועל הסוכן שלך</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* User section */}
        <section className="glass-card-elevated rounded-[22px] p-6 space-y-4">
          <div className="flex items-center gap-2.5 mb-2">
            <div className="w-9 h-9 rounded-[12px] bg-brand-50 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D4622B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <h3 className="text-[16px] font-semibold">עליך</h3>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">שם מלא</label>
            <input value={form.full_name} onChange={(e) => update('full_name', e.target.value)}
              required className="input-glass w-full px-4 py-3 text-[15px]" placeholder="השם שלך" />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">טלפון (WhatsApp)</label>
            <input value={form.phone} onChange={(e) => update('phone', e.target.value)}
              required type="tel" dir="ltr" className="input-glass w-full px-4 py-3 text-[15px]" placeholder="+972..." />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">מגדר</label>
            <TogglePair value={form.gender} onChange={(v) => update('gender', v)}
              options={[['male', 'זכר'], ['female', 'נקבה']]} />
          </div>
        </section>

        {/* Agent section */}
        <section className="glass-card-elevated rounded-[22px] p-6 space-y-4">
          <div className="flex items-center gap-2.5 mb-2">
            <div className="w-9 h-9 rounded-[12px] bg-brand-50 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D4622B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h3 className="text-[16px] font-semibold">הסוכן שלך</h3>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">שם הסוכן</label>
            <input value={form.agent_name} onChange={(e) => update('agent_name', e.target.value)}
              required className="input-glass w-full px-4 py-3 text-[15px]" placeholder="לדוגמה: שולי" />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">מגדר הסוכן</label>
            <TogglePair value={form.agent_gender} onChange={(v) => update('agent_gender', v)}
              options={[['male', 'זכר'], ['female', 'נקבה']]} />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              הקול של הסוכן בהודעות קוליות
            </label>
            <p className="text-[12px] text-text-secondary mb-2">
              לחץ על קול כדי לשמוע אותו ולבחור אותו. הסוכן ישתמש בקול הזה כאשר ישלח הודעות קוליות בוואטסאפ.
            </p>
            {form.agent_gender ? (
              <VoicePicker
                value={form.tts_voice_name}
                onChange={(v) => update('tts_voice_name', v)}
                lockedGender={form.agent_gender as 'male' | 'female'}
              />
            ) : (
              <div className="glass-card rounded-[16px] p-4 text-center text-[13px] text-text-secondary">
                בחר את מגדר הסוכן למעלה כדי לראות את הקולות המתאימים
              </div>
            )}
          </div>
        </section>

        <button type="submit" disabled={loading || !isValid}
          className="btn-brand w-full">
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              יוצר את הסוכן...
            </span>
          ) : 'צור את הסוכן שלי'}
        </button>
      </form>
    </div>
  )
}

function TogglePair({ value, onChange, options }: {
  value: string
  onChange: (v: string) => void
  options: string[][]
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
