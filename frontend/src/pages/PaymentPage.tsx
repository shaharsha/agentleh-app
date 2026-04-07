import { useState } from 'react'
import { confirmPayment } from '../lib/api'
import StepIndicator from '../components/StepIndicator'

interface PaymentPageProps {
  onComplete: () => void
}

const PLANS = [
  {
    id: 'starter',
    name: 'סטארט',
    price: '249',
    period: 'לחודש',
    features: ['עוזר אישי בוואטסאפ', 'זיכרון מלא', 'תמיכה בעברית'],
    popular: false,
  },
  {
    id: 'business',
    name: 'עסקי',
    price: '499',
    period: 'לחודש',
    features: ['הכל בסטארט', 'אינטגרציות (Gmail, Calendar)', 'תמיכה מועדפת'],
    popular: true,
  },
  {
    id: 'premium',
    name: 'פרימיום',
    price: '999',
    period: 'לחודש',
    features: ['הכל בעסקי', 'מספר טלפון ייעודי', 'התאמה אישית מלאה'],
    popular: false,
  },
]

export default function PaymentPage({ onComplete }: PaymentPageProps) {
  const [selectedPlan, setSelectedPlan] = useState('business')
  const [loading, setLoading] = useState(false)

  async function handlePay() {
    setLoading(true)
    try {
      await confirmPayment('mock_session')
      onComplete()
    } catch {
      alert('שגיאה בתשלום')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <StepIndicator steps={['תוכנית', 'הגדרות', 'מוכן']} current={0} />

      <div className="text-center mb-8">
        <h2 className="text-[28px] font-bold tracking-tight mb-2">בחר תוכנית</h2>
        <p className="text-[15px] text-text-secondary">התחל עם תקופת ניסיון חינמית של 7 ימים</p>
      </div>

      <div className="space-y-3 mb-8">
        {PLANS.map((plan) => {
          const isSelected = selectedPlan === plan.id
          return (
            <button
              key={plan.id}
              onClick={() => setSelectedPlan(plan.id)}
              className={`w-full text-right rounded-2xl p-5 transition-all duration-300 cursor-pointer btn-press relative overflow-hidden ${
                isSelected
                  ? 'glass-elevated border-brand/30 shadow-lg shadow-brand/10'
                  : 'glass hover:shadow-md'
              }`}
            >
              {plan.popular && (
                <span className="absolute top-3 left-3 text-[11px] font-semibold bg-gradient-to-r from-brand to-brand-light text-white px-2.5 py-0.5 rounded-full">
                  הכי פופולרי
                </span>
              )}

              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
                    isSelected ? 'border-brand bg-brand' : 'border-text-muted/40'
                  }`}>
                    {isSelected && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <div className="text-left" dir="ltr">
                    <span className="text-[24px] font-bold text-text-primary">₪{plan.price}</span>
                    <span className="text-[13px] text-text-muted mr-1">/{plan.period}</span>
                  </div>
                </div>
                <div>
                  <div className="text-[17px] font-semibold text-text-primary">{plan.name}</div>
                  <div className="text-[13px] text-text-secondary mt-0.5">
                    {plan.features[0]}
                  </div>
                </div>
              </div>

              {isSelected && (
                <div className="mt-3 pt-3 border-t border-black/[0.05]">
                  <ul className="space-y-1.5">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-[13px] text-text-secondary">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-success shrink-0">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </button>
          )
        })}
      </div>

      <button
        onClick={handlePay}
        disabled={loading}
        className="w-full bg-gradient-to-b from-brand to-brand-dark text-white rounded-2xl px-6 py-4 text-[17px] font-semibold shadow-lg shadow-brand/25 hover:shadow-xl hover:shadow-brand/30 transition-all duration-300 disabled:opacity-50 cursor-pointer btn-press"
      >
        {loading ? 'מעבד...' : 'המשך'}
      </button>

      <p className="text-center text-[12px] text-text-muted mt-4">
        תשלום מדומה — לא יחויב חיוב אמיתי
      </p>
    </div>
  )
}
