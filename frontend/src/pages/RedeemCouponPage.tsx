import { useEffect, useMemo, useState } from 'react'
import {
  CouponApiError,
  previewCoupon,
  redeemCoupon,
  type CouponPreview,
} from '../lib/api'
import StepIndicator from '../components/StepIndicator'
import type { AppUser } from '../lib/types'

interface RedeemCouponPageProps {
  user: AppUser | null
  onComplete: () => void
}

interface PlanCard {
  id: string
  name: string
  price: string
  badge?: string
  features: string[]
}

const PLANS: PlanCard[] = [
  { id: 'minimal', name: 'מינימלי', price: '99', features: ['עוזר אישי בסיסי', 'בלי קול', 'בדיקות מהירות'] },
  { id: 'starter', name: 'סטארטר', price: '399', features: ['עוזר אישי בוואטסאפ', 'הודעות קוליות', 'תמיכה בעברית'] },
  { id: 'business', name: 'עסקי', price: '699', badge: 'הכי פופולרי', features: ['הכל בסטארטר', 'אינטגרציות (Gmail, Calendar)', 'תמיכה מועדפת'] },
  { id: 'premium', name: 'פרימיום', price: '1199', features: ['הכל בעסקי', 'מכסה גבוהה במיוחד', 'התאמה אישית מלאה'] },
]

const ERROR_MSG_HE: Record<string, string> = {
  coupon_not_found: 'הקוד שהזנת לא קיים',
  coupon_disabled: 'הקופון הושבת',
  coupon_expired: 'הקופון פג תוקף',
  coupon_not_yet_valid: 'הקופון עדיין לא פעיל',
  coupon_exhausted: 'הקופון נוצל במלואו',
  coupon_already_redeemed: 'כבר השתמשת בקופון הזה',
  invalid_plan: 'תוכנית הקופון אינה תקפה',
  invalid_duration: 'משך הקופון אינו תקף',
  rate_limited: 'יותר מדי ניסיונות — נסה שוב בעוד דקה',
  tenant_not_found: 'סביבת עבודה לא נמצאה',
}

function fmtScheduleHe(p: CouponPreview): string {
  switch (p.schedule.kind) {
    case 'immediate':
      return `יופעל מיד · ${p.duration_days} ימים`
    case 'renewal':
      return `יתווסף לתום התקופה הנוכחית · ${p.duration_days} ימים נוספים`
    case 'upgrade_immediate':
      return `שדרוג מיידי · ${p.duration_days} ימים`
    case 'downgrade_queued':
      return `יופעל בתום התקופה הנוכחית · ${p.duration_days} ימים`
  }
}

export default function RedeemCouponPage({ user, onComplete }: RedeemCouponPageProps) {
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<CouponPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [redeeming, setRedeeming] = useState(false)
  const [redeemError, setRedeemError] = useState<string | null>(null)

  // Pre-select tenant: the user's first owned tenant (default), or null
  // if they're brand new — the redeem endpoint will lazily create one.
  const ownedTenants = useMemo(
    () => (user?.tenants || []).filter((t) => t.role === 'owner' || t.role === 'admin'),
    [user],
  )
  const [tenantId, setTenantId] = useState<number | null>(
    ownedTenants[0]?.id ?? null,
  )

  // Debounced preview when the user types ≥6 chars. Server rate-limits
  // to 30/min/user — the debounce keeps the typical case well under that.
  useEffect(() => {
    const trimmed = code.trim()
    if (trimmed.length < 6) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    const handle = setTimeout(async () => {
      try {
        const p = await previewCoupon(trimmed, tenantId ?? undefined)
        setPreview(p)
        setPreviewError(null)
      } catch (e) {
        setPreview(null)
        if (e instanceof CouponApiError) {
          setPreviewError(ERROR_MSG_HE[e.code] || `שגיאה: ${e.code}`)
        } else {
          setPreviewError('שגיאה בטעינת הקופון')
        }
      }
    }, 350)
    return () => clearTimeout(handle)
  }, [code, tenantId])

  async function handleRedeem() {
    setRedeeming(true)
    setRedeemError(null)
    try {
      await redeemCoupon(code.trim(), tenantId)
      onComplete()
    } catch (e) {
      if (e instanceof CouponApiError) {
        setRedeemError(ERROR_MSG_HE[e.code] || `שגיאה: ${e.code}`)
      } else {
        setRedeemError('הפדיון נכשל. נסה שוב.')
      }
    } finally {
      setRedeeming(false)
    }
  }

  const canRedeem =
    !!preview &&
    !preview.already_redeemed_by_user &&
    !redeeming &&
    code.trim().length >= 6

  return (
    <div>
      <StepIndicator steps={['תוכנית', 'הגדרות', 'מוכן']} current={0} />

      <div className="text-center mb-8">
        <h2 className="text-[28px] font-bold tracking-[-0.6px] mb-2">הפעלת תוכנית</h2>
        <p className="text-[15px] text-text-secondary">
          השתמש בקוד קופון כדי להפעיל את התוכנית שלך
        </p>
      </div>

      <div className="space-y-3 mb-8">
        {PLANS.map((plan) => (
          <div
            key={plan.id}
            className={`w-full text-right rounded-[22px] p-5 relative glass-card ${
              preview?.plan.plan_id === plan.id
                ? 'border-brand/30 shadow-[0_16px_48px_rgba(212,98,43,0.08)]'
                : ''
            }`}
          >
            {plan.badge && (
              <span className="absolute top-4 left-4 text-[11px] font-semibold bg-brand text-white px-3 py-0.5 rounded-full">
                {plan.badge}
              </span>
            )}
            <div className="flex items-center justify-between">
              <div dir="ltr" className="text-left">
                <span className="text-[22px] font-bold">₪{plan.price}</span>
                <span className="text-[13px] text-text-muted mr-0.5">/לחודש</span>
              </div>
              <div>
                <div className="text-[16px] font-semibold">{plan.name}</div>
                <div className="text-[13px] text-text-secondary mt-0.5">{plan.features[0]}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {ownedTenants.length > 1 && (
        <div className="mb-5">
          <label className="block text-[13px] font-medium mb-1.5">
            סביבת עבודה
          </label>
          <select
            value={tenantId ?? ''}
            onChange={(e) => setTenantId(Number(e.target.value))}
            className="input-glass w-full"
          >
            {ownedTenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mb-5">
        <label className="block text-[13px] font-medium mb-1.5">
          קוד קופון
        </label>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="לדוגמה: BIZ-30-ABC"
          className="input-glass w-full font-mono tracking-wider text-[16px] uppercase"
          dir="ltr"
          autoFocus
        />
      </div>

      {previewError && (
        <div className="mb-5 p-3 rounded-xl bg-red-50 text-red-700 text-[13px]">
          {previewError}
        </div>
      )}

      {preview && !previewError && (
        <div className="mb-5 p-4 rounded-xl glass-card-elevated">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-[12px] uppercase tracking-wide text-text-muted">קופון זוהה</span>
            <code className="font-mono text-[12px] text-text-secondary">{preview.code}</code>
          </div>
          <div className="text-[18px] font-semibold mb-1">{preview.plan.name_he}</div>
          <div className="text-[13px] text-text-secondary mb-2">
            {fmtScheduleHe(preview)}
          </div>
          {preview.schedule.kind === 'upgrade_immediate' && (
            <div className="text-[12px] text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-2">
              שים לב: הפעלת קופון זה תחליף את התוכנית הפעילה כעת באופן מיידי.
            </div>
          )}
          {preview.schedule.kind === 'downgrade_queued' && (
            <div className="text-[12px] text-text-secondary mt-2">
              התוכנית הנוכחית תמשיך לפעול עד תום התקופה, ואז התוכנית החדשה תיכנס לתוקף.
            </div>
          )}
          {preview.already_redeemed_by_user && (
            <div className="text-[12px] text-red-700 mt-2">
              כבר השתמשת בקוד זה.
            </div>
          )}
        </div>
      )}

      {redeemError && (
        <div className="mb-5 p-3 rounded-xl bg-red-50 text-red-700 text-[13px]">
          {redeemError}
        </div>
      )}

      <button
        onClick={handleRedeem}
        disabled={!canRedeem}
        className="btn-brand w-full"
      >
        {redeeming ? 'מפעיל…' : 'הפעל תוכנית'}
      </button>

      <p className="text-center text-[12px] text-text-muted mt-5">
        אין לך קוד? פנה לתמיכה לקבלת קוד
      </p>
    </div>
  )
}
