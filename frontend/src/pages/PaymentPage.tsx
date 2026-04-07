import { useState } from 'react'
import { confirmPayment } from '../lib/api'
import StepIndicator from '../components/StepIndicator'

interface PaymentPageProps {
  onComplete: () => void
}

const PLANS = [
  { id: 'starter', name: 'סטארט', price: '₪249', desc: 'עוזר אישי בוואטסאפ' },
  { id: 'business', name: 'עסקי', price: '₪499', desc: 'עוזר עסקי + אינטגרציות' },
  { id: 'premium', name: 'פרימיום', price: '₪999', desc: 'כל הפיצ\'רים + תמיכה מועדפת' },
]

export default function PaymentPage({ onComplete }: PaymentPageProps) {
  const [selectedPlan, setSelectedPlan] = useState('starter')
  const [loading, setLoading] = useState(false)

  async function handlePay() {
    setLoading(true)
    try {
      await confirmPayment(`mock_session`)
      onComplete()
    } catch (err) {
      alert('Payment failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <StepIndicator steps={['תשלום', 'הגדרות', 'מוכן!']} current={0} />

      <h2 className="text-2xl font-bold text-center mb-6">בחר תוכנית</h2>

      <div className="grid gap-4 mb-8">
        {PLANS.map((plan) => (
          <button
            key={plan.id}
            onClick={() => setSelectedPlan(plan.id)}
            className={`p-5 rounded-xl border-2 text-right transition cursor-pointer ${
              selectedPlan === plan.id
                ? 'border-brand bg-brand/5'
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-2xl font-bold text-brand">{plan.price}</span>
              <div>
                <div className="font-semibold text-lg">{plan.name}</div>
                <div className="text-sm text-gray-500">{plan.desc}</div>
              </div>
            </div>
          </button>
        ))}
      </div>

      <button
        onClick={handlePay}
        disabled={loading}
        className="w-full bg-brand text-white rounded-xl px-6 py-4 text-lg font-semibold hover:bg-brand-dark transition disabled:opacity-50 cursor-pointer"
      >
        {loading ? 'Processing...' : 'Continue'}
      </button>

      <p className="text-center text-xs text-gray-400 mt-4">
        Mock payment — no real charge
      </p>
    </div>
  )
}
