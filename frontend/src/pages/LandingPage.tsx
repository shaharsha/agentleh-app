import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'

const LANDING_URL = import.meta.env.VITE_LANDING_URL

interface LandingPageProps {
  initialMode?: 'login' | 'signup'
}

export default function LandingPage({ initialMode = 'login' }: LandingPageProps) {
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode)
  const { t, dir } = useI18n()

  async function loginWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
  }

  const tagline = t(
    mode === 'login'
      ? { he: 'העוזר החכם שלך בוואטסאפ', en: 'Your smart assistant on WhatsApp' }
      : { he: 'צור חשבון חדש', en: 'Create a new account' },
  )
  const googleCta = t(
    mode === 'login'
      ? { he: 'המשך עם Google', en: 'Continue with Google' }
      : { he: 'הרשמה עם Google', en: 'Sign up with Google' },
  )

  return (
    <div className="min-h-screen section-gradient-hero flex flex-col items-center justify-center px-5 py-16">
      <div className="text-center mb-12">
        <h1 className="text-[36px] font-extrabold tracking-[-1px] text-text-primary mb-3">Agentiko</h1>
        <p className="text-[17px] text-text-secondary leading-relaxed">{tagline}</p>
      </div>

      <div className="glass-card-elevated rounded-[22px] p-8 w-full max-w-[400px]">
        <button onClick={loginWithGoogle} className="btn-secondary btn-md w-full">
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          <span className="font-medium">{googleCta}</span>
        </button>

        <div className="relative my-7">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-white/80 px-4 text-[13px] text-text-muted">
              {t({ he: 'או', en: 'or' })}
            </span>
          </div>
        </div>

        <EmailForm mode={mode} />

        <p className="text-center text-[14px] text-text-secondary pt-4">
          {mode === 'login' ? (
            <>
              {t({ he: 'אין לך חשבון?', en: "Don't have an account?" })}{' '}
              <button
                type="button"
                onClick={() => { setMode('signup'); history.pushState(null, '', '/signup') }}
                className="text-brand font-medium hover:underline cursor-pointer"
              >
                {t({ he: 'הרשמה', en: 'Sign up' })}
              </button>
            </>
          ) : (
            <>
              {t({ he: 'יש לך חשבון?', en: 'Already have an account?' })}{' '}
              <button
                type="button"
                onClick={() => { setMode('login'); history.pushState(null, '', '/') }}
                className="text-brand font-medium hover:underline cursor-pointer"
              >
                {t({ he: 'התחברות', en: 'Log in' })}
              </button>
            </>
          )}
        </p>
      </div>

      <p className="text-center text-[13px] text-text-muted mt-8 max-w-[340px] leading-relaxed" dir={dir}>
        {t({ he: 'בהרשמה את/ה מסכימ/ה ל', en: 'By signing up you agree to the ' })}
        <a href={LANDING_URL + '/terms'} className="text-brand hover:underline">
          {t({ he: 'תנאי השימוש', en: 'Terms of Service' })}
        </a>
        {t({ he: ' ול', en: ' and ' })}
        <a href={LANDING_URL + '/privacy'} className="text-brand hover:underline">
          {t({ he: 'מדיניות הפרטיות', en: 'Privacy Policy' })}
        </a>
      </p>
    </div>
  )
}

function EmailForm({ mode }: { mode: 'login' | 'signup' }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { t, dir } = useI18n()

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const form = new FormData(e.currentTarget)
    const email = form.get('email') as string
    const password = form.get('password') as string
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) setError(error.message)
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) setError(error.message)
      }
    } finally {
      setLoading(false)
    }
  }

  // Email + password stay LTR (both are always Latin/numeric); the
  // placeholder should flow in the active text direction so it doesn't
  // look misaligned in RTL mode.
  const placeholderAlign = dir === 'rtl' ? 'placeholder:text-right' : 'placeholder:text-left'

  return (
    <form onSubmit={handleSubmit} className="space-y-3.5">
      <input
        name="email"
        type="email"
        placeholder={t({ he: 'אימייל', en: 'Email' })}
        required
        dir="ltr"
        className={`input-glass w-full px-4 py-3 text-[15px] placeholder:text-text-muted ${placeholderAlign} text-left`}
      />
      <input
        name="password"
        type="password"
        placeholder={t({ he: 'סיסמה', en: 'Password' })}
        required
        minLength={6}
        dir="ltr"
        className={`input-glass w-full px-4 py-3 text-[15px] placeholder:text-text-muted ${placeholderAlign} text-left`}
      />

      {error && (
        <div className="bg-red-50 border border-red-200/60 rounded-[14px] px-4 py-2.5">
          <p className="text-[13px] text-red-600">{error}</p>
        </div>
      )}

      <button type="submit" disabled={loading} className="btn-brand btn-md w-full">
        {loading
          ? '...'
          : mode === 'login'
            ? t({ he: 'התחברות', en: 'Log in' })
            : t({ he: 'הרשמה', en: 'Sign up' })}
      </button>
    </form>
  )
}
