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
    features: ['עוזר אישי בוואטסאפ', 'זיכרון מלא', 'תמיכה בעברית'],
  },
  {
    id: 'business',
    name: 'עסקי',
    price: '499',
    badge: 'הכי פופולרי',
    features: ['הכל בסטארט', 'אינטגרציות (Gmail, Calendar)', 'תמיכה מועדפת'],
  },
  {
    id: 'premium',
    name: 'פרימיום',
    price: '999',
    features: ['הכל בעסקי', 'מספר טלפון ייעודי', 'התאמה אישית מלאה'],
  },
]

export default function PaymentPage({ onComplete }: PaymentPageProps) {
  const [selected, setSelected] = useState('business')
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

      <div className="text-center mb-10">
        <h2 className="text-[28px] font-bold tracking-[-0.6px] mb-2">בחר תוכנית</h2>
        <p className="text-[15px] text-text-secondary">התחל עם תקופת ניסיון חינמית של 7 ימים</p>
      </div>

      <div className="space-y-3 mb-10">
        {PLANS.map((plan) => {
          const active = selected === plan.id
          return (
            <button
              key={plan.id}
              onClick={() => setSelected(plan.id)}
              className={`w-full text-right rounded-[22px] p-6 transition-all duration-300 cursor-pointer relative ${
                active
                  ? 'glass-card-elevated border-brand/20 shadow-[0_16px_48px_rgba(212,98,43,0.08)]'
                  : 'glass-card glass-card-hover'
              }`}
            >
              {plan.badge && (
                <span className="absolute top-4 left-4 text-[11px] font-semibold bg-brand text-white px-3 py-0.5 rounded-full">
                  {plan.badge}
                </span>
              )}

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-[22px] h-[22px] rounded-full border-2 flex items-center justify-center transition-all ${
                    active ? 'border-brand bg-brand' : 'border-border'
                  }`}>
                    {active && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <div dir="ltr" className="text-left">
                    <span className="text-[24px] font-bold">₪{plan.price}</span>
                    <span className="text-[13px] text-text-muted mr-0.5">/לחודש</span>
                  </div>
                </div>
                <div>
                  <div className="text-[17px] font-semibold">{plan.name}</div>
                  <div className="text-[13px] text-text-secondary mt-0.5">{plan.features[0]}</div>
                </div>
              </div>

              {active && (
                <ul className="mt-4 pt-4 border-t border-border-light space-y-2">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-[13px] text-text-secondary">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#30D158" strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </button>
          )
        })}
      </div>

      <button onClick={handlePay} disabled={loading}
        className="btn-brand w-full">
        {loading ? 'מעבד...' : 'המשך'}
      </button>

      <p className="text-center text-[12px] text-text-muted mt-5">
        תשלום מדומה — לא יחויב חיוב אמיתי
      </p>
    </div>
  )
}
