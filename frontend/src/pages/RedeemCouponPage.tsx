import { useEffect, useMemo, useState } from 'react'
import {
  CouponApiError,
  previewCoupon,
  redeemCoupon,
  type CouponPreview,
} from '../lib/api'
import StepIndicator from '../components/StepIndicator'
import { useI18n, type Bilingual } from '../lib/i18n'
import type { AppUser } from '../lib/types'

interface RedeemCouponPageProps {
  user: AppUser | null
  onComplete: () => void
}

interface PlanCard {
  id: string
  name: Bilingual
  price: string
  badge?: Bilingual
  features: Bilingual[]
}

// Plans are listed here with bilingual names + features. Only the first
// feature is rendered in the card summary; the rest are kept as context
// for the upgrade dialog and for future feature-comparison tables.
const PLANS: PlanCard[] = [
  {
    id: 'minimal',
    name: { he: 'מינימלי', en: 'Minimal' },
    price: '99',
    features: [
      { he: 'עוזר אישי בסיסי', en: 'Basic personal assistant' },
      { he: 'בלי קול', en: 'No voice messages' },
      { he: 'בדיקות מהירות', en: 'Quick-start plan' },
    ],
  },
  {
    id: 'starter',
    name: { he: 'סטארטר', en: 'Starter' },
    price: '399',
    features: [
      { he: 'עוזר אישי בוואטסאפ', en: 'WhatsApp personal assistant' },
      { he: 'הודעות קוליות', en: 'Voice messages' },
      { he: 'תמיכה בעברית', en: 'Hebrew support' },
    ],
  },
  {
    id: 'business',
    name: { he: 'עסקי', en: 'Business' },
    price: '699',
    badge: { he: 'הכי פופולרי', en: 'Most popular' },
    features: [
      { he: 'הכל בסטארטר', en: 'Everything in Starter' },
      { he: 'אינטגרציות (Gmail, Calendar)', en: 'Integrations (Gmail, Calendar)' },
      { he: 'תמיכה מועדפת', en: 'Priority support' },
    ],
  },
  {
    id: 'premium',
    name: { he: 'פרימיום', en: 'Premium' },
    price: '1199',
    features: [
      { he: 'הכל בעסקי', en: 'Everything in Business' },
      { he: 'מכסה גבוהה במיוחד', en: 'Higher quota ceiling' },
      { he: 'התאמה אישית מלאה', en: 'Full customization' },
    ],
  },
]

// Server-side coupon error codes → bilingual user messages.
// Unknown codes fall through to a generic "error: <code>" so bugs
// surface in QA rather than being swallowed.
const ERROR_MSG: Record<string, Bilingual> = {
  coupon_not_found: { he: 'הקוד שהזנת לא קיים', en: "That code doesn't exist" },
  coupon_disabled: { he: 'הקופון הושבת', en: 'This coupon was disabled' },
  coupon_expired: { he: 'הקופון פג תוקף', en: 'This coupon has expired' },
  coupon_not_yet_valid: { he: 'הקופון עדיין לא פעיל', en: 'This coupon is not yet active' },
  coupon_exhausted: { he: 'הקופון נוצל במלואו', en: 'This coupon is fully redeemed' },
  coupon_already_redeemed: { he: 'כבר השתמשת בקופון הזה', en: "You've already used this coupon" },
  invalid_plan: { he: 'תוכנית הקופון אינה תקפה', en: "Coupon's plan is invalid" },
  invalid_duration: { he: 'משך הקופון אינו תקף', en: "Coupon's duration is invalid" },
  rate_limited: {
    he: 'יותר מדי ניסיונות — נסה שוב בעוד דקה',
    en: 'Too many attempts — try again in a minute',
  },
  tenant_not_found: { he: 'סביבת עבודה לא נמצאה', en: 'Workspace not found' },
}

export default function RedeemCouponPage({ user, onComplete }: RedeemCouponPageProps) {
  const { t, lang, dir } = useI18n()
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<CouponPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [redeeming, setRedeeming] = useState(false)
  const [redeemError, setRedeemError] = useState<string | null>(null)

  function fmtSchedule(p: CouponPreview): string {
    switch (p.schedule.kind) {
      case 'immediate':
        return t({
          he: `יופעל מיד · ${p.duration_days} ימים`,
          en: `Activates immediately · ${p.duration_days} days`,
        })
      case 'renewal':
        return t({
          he: `יתווסף לתום התקופה הנוכחית · ${p.duration_days} ימים נוספים`,
          en: `Queued at end of current period · ${p.duration_days} extra days`,
        })
      case 'upgrade_immediate':
        return t({
          he: `שדרוג מיידי · ${p.duration_days} ימים`,
          en: `Immediate upgrade · ${p.duration_days} days`,
        })
      case 'downgrade_queued':
        return t({
          he: `יופעל בתום התקופה הנוכחית · ${p.duration_days} ימים`,
          en: `Activates at end of current period · ${p.duration_days} days`,
        })
    }
  }

  function errorFor(code: string): string {
    const msg = ERROR_MSG[code]
    if (msg) return t(msg)
    return t({ he: `שגיאה: ${code}`, en: `Error: ${code}` })
  }

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
          setPreviewError(errorFor(e.code))
        } else {
          setPreviewError(t({ he: 'שגיאה בטעינת הקופון', en: 'Failed to load coupon' }))
        }
      }
    }, 350)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, tenantId, lang])

  async function handleRedeem() {
    setRedeeming(true)
    setRedeemError(null)
    try {
      await redeemCoupon(code.trim(), tenantId)
      onComplete()
    } catch (e) {
      if (e instanceof CouponApiError) {
        setRedeemError(errorFor(e.code))
      } else {
        setRedeemError(t({ he: 'הפדיון נכשל. נסה שוב.', en: 'Redemption failed. Try again.' }))
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

  // Plan card alignment: price sits on the free edge of the row (end of
  // the reading direction) in each language — that's `left` in Hebrew
  // (RTL: end-of-line is on the left) and `right` in English. We keep
  // the card's overall content alignment consistent with the reading
  // direction too.
  return (
    <div>
      <StepIndicator
        steps={[
          t({ he: 'תוכנית', en: 'Plan' }),
          t({ he: 'הגדרות', en: 'Setup' }),
          t({ he: 'מוכן', en: 'Ready' }),
        ]}
        current={0}
      />

      <div className="text-center mb-6 sm:mb-8">
        <h2 className="text-[clamp(22px,6vw,28px)] font-bold tracking-[-0.6px] mb-2">
          {t({ he: 'הפעלת תוכנית', en: 'Activate a plan' })}
        </h2>
        <p className="text-[clamp(14px,3.5vw,15px)] text-text-secondary">
          {t({
            he: 'השתמש בקוד קופון כדי להפעיל את התוכנית שלך',
            en: 'Use a coupon code to activate your plan',
          })}
        </p>
      </div>

      {ownedTenants.length > 1 && (
        <div className="mb-5">
          <label className="block text-[13px] font-medium mb-1.5">
            {t({ he: 'סביבת עבודה', en: 'Workspace' })}
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
          {t({ he: 'קוד קופון', en: 'Coupon code' })}
        </label>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={t({ he: 'לדוגמה: BIZ-30-ABC', en: 'e.g. BIZ-30-ABC' })}
          className="input-glass w-full px-4 py-3 font-mono tracking-wider text-[clamp(14px,3.8vw,16px)] uppercase placeholder:normal-case placeholder:font-sans placeholder:tracking-normal"
          dir={dir}
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          maxLength={32}
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
            <span className="text-[12px] uppercase tracking-wide text-text-muted">
              {t({ he: 'קופון זוהה', en: 'Coupon valid' })}
            </span>
            <code className="font-mono text-[12px] text-text-secondary">{preview.code}</code>
          </div>
          <div className="text-[18px] font-semibold mb-1">
            {/* Prefer the local bilingual name from PLANS; fall back to
                the server-returned Hebrew label for any unknown plan_id
                (forward-compat if the backend ships a new plan before
                this file is updated). */}
            {(() => {
              const match = PLANS.find((p) => p.id === preview.plan.plan_id)
              return match ? t(match.name) : preview.plan.name_he
            })()}
          </div>
          <div className="text-[13px] text-text-secondary mb-2">
            {fmtSchedule(preview)}
          </div>
          {preview.schedule.kind === 'upgrade_immediate' && (
            <div className="text-[12px] text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-2">
              {t({
                he: 'שים לב: הפעלת קופון זה תחליף את התוכנית הפעילה כעת באופן מיידי.',
                en: 'Heads up: redeeming this coupon will replace your active plan immediately.',
              })}
            </div>
          )}
          {preview.schedule.kind === 'downgrade_queued' && (
            <div className="text-[12px] text-text-secondary mt-2">
              {t({
                he: 'התוכנית הנוכחית תמשיך לפעול עד תום התקופה, ואז התוכנית החדשה תיכנס לתוקף.',
                en: 'Your current plan stays active until the period ends, then the new plan takes over.',
              })}
            </div>
          )}
          {preview.already_redeemed_by_user && (
            <div className="text-[12px] text-red-700 mt-2">
              {t({ he: 'כבר השתמשת בקוד זה.', en: "You've already used this code." })}
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
        {redeeming
          ? t({ he: 'מפעיל…', en: 'Activating…' })
          : t({ he: 'הפעל תוכנית', en: 'Activate plan' })}
      </button>

      <p className="text-center text-[12px] text-text-muted mt-5">
        {t({
          he: 'אין לך קוד? פנה לתמיכה לקבלת קוד',
          en: "Don't have a code? Contact support to get one",
        })}
      </p>
    </div>
  )
}
