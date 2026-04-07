import { useState } from 'react'
import { submitOnboarding } from '../lib/api'
import StepIndicator from '../components/StepIndicator'
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

  const isValid = form.full_name && form.phone && form.gender && form.agent_name && form.agent_gender

  return (
    <div>
      <StepIndicator steps={['תוכנית', 'הגדרות', 'מוכן']} current={1} />

      <div className="text-center mb-8">
        <h2 className="text-[28px] font-bold tracking-tight mb-2">הגדרות</h2>
        <p className="text-[15px] text-text-secondary">ספר לנו קצת על עצמך ועל הסוכן שלך</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* User section */}
        <div className="glass-elevated rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2.5 mb-1">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500/10 to-blue-600/10 flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <h3 className="text-[16px] font-semibold">עליך</h3>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">שם מלא</label>
            <input
              value={form.full_name}
              onChange={(e) => update('full_name', e.target.value)}
              required
              className="input-glass w-full rounded-xl px-4 py-3 text-[15px]"
              placeholder="השם שלך"
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">טלפון (WhatsApp)</label>
            <input
              value={form.phone}
              onChange={(e) => update('phone', e.target.value)}
              required
              type="tel"
              dir="ltr"
              className="input-glass w-full rounded-xl px-4 py-3 text-[15px]"
              placeholder="+972..."
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">מגדר</label>
            <div className="flex gap-2.5">
              {[['male', 'זכר'], ['female', 'נקבה']].map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => update('gender', val)}
                  className={`flex-1 py-2.5 rounded-xl text-[14px] font-medium transition-all duration-200 cursor-pointer btn-press ${
                    form.gender === val
                      ? 'bg-gradient-to-b from-brand to-brand-dark text-white shadow-md shadow-brand/20'
                      : 'glass hover:shadow-md'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Agent section */}
        <div className="glass-elevated rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2.5 mb-1">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand/10 to-brand-dark/10 flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D4622B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 8V4H8" /><rect x="2" y="2" width="20" height="8" rx="2" />
                <path d="M2 14h20" /><rect x="2" y="14" width="20" height="8" rx="2" />
              </svg>
            </div>
            <h3 className="text-[16px] font-semibold">הסוכן שלך</h3>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">שם הסוכן</label>
            <input
              value={form.agent_name}
              onChange={(e) => update('agent_name', e.target.value)}
              required
              className="input-glass w-full rounded-xl px-4 py-3 text-[15px]"
              placeholder="לדוגמה: שולי"
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">מגדר הסוכן</label>
            <div className="flex gap-2.5">
              {[['male', 'זכר'], ['female', 'נקבה']].map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => update('agent_gender', val)}
                  className={`flex-1 py-2.5 rounded-xl text-[14px] font-medium transition-all duration-200 cursor-pointer btn-press ${
                    form.agent_gender === val
                      ? 'bg-gradient-to-b from-brand to-brand-dark text-white shadow-md shadow-brand/20'
                      : 'glass hover:shadow-md'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || !isValid}
          className="w-full bg-gradient-to-b from-brand to-brand-dark text-white rounded-2xl px-6 py-4 text-[17px] font-semibold shadow-lg shadow-brand/25 hover:shadow-xl hover:shadow-brand/30 transition-all duration-300 disabled:opacity-40 cursor-pointer btn-press"
        >
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
