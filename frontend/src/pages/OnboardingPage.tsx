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
    } catch (err) {
      alert('Onboarding failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <StepIndicator steps={['תשלום', 'הגדרות', 'מוכן!']} current={1} />

      <h2 className="text-2xl font-bold text-center mb-6">Setup</h2>

      <form onSubmit={handleSubmit} className="space-y-6">
        <section className="bg-white rounded-xl p-6 shadow-sm space-y-4">
          <h3 className="font-semibold text-lg">About you</h3>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              value={form.full_name}
              onChange={(e) => update('full_name', e.target.value)}
              required
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/50"
              placeholder="Your name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone (WhatsApp)</label>
            <input
              value={form.phone}
              onChange={(e) => update('phone', e.target.value)}
              required
              type="tel"
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/50"
              placeholder="+972..."
              dir="ltr"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Gender</label>
            <div className="flex gap-3">
              {[['male', 'Male'], ['female', 'Female']].map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => update('gender', val)}
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition cursor-pointer ${
                    form.gender === val
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-gray-300 text-gray-600 hover:border-gray-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-white rounded-xl p-6 shadow-sm space-y-4">
          <h3 className="font-semibold text-lg">Your agent</h3>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Agent name</label>
            <input
              value={form.agent_name}
              onChange={(e) => update('agent_name', e.target.value)}
              required
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/50"
              placeholder="e.g. Shuli"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Agent gender</label>
            <div className="flex gap-3">
              {[['male', 'Male'], ['female', 'Female']].map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => update('agent_gender', val)}
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition cursor-pointer ${
                    form.agent_gender === val
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-gray-300 text-gray-600 hover:border-gray-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <button
          type="submit"
          disabled={loading || !form.gender || !form.agent_gender}
          className="w-full bg-brand text-white rounded-xl px-6 py-4 text-lg font-semibold hover:bg-brand-dark transition disabled:opacity-50 cursor-pointer"
        >
          {loading ? 'Setting up...' : 'Create my agent'}
        </button>
      </form>
    </div>
  )
}
