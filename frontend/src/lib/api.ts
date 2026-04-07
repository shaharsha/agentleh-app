import { supabase } from './supabase'

async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(url, { ...options, headers })

  if (res.status === 401) {
    // Try refreshing the session
    const { data: { session: refreshed } } = await supabase.auth.refreshSession()
    if (refreshed?.access_token) {
      headers['Authorization'] = `Bearer ${refreshed.access_token}`
      return fetch(url, { ...options, headers })
    }
  }

  return res
}

export async function getMe() {
  const res = await authFetch('/api/auth/me')
  if (!res.ok) throw new Error('Not authenticated')
  return res.json()
}

export async function syncUser() {
  const res = await authFetch('/api/auth/sync', { method: 'POST' })
  if (!res.ok) throw new Error('Sync failed')
  return res.json()
}

export async function createCheckout(plan: string) {
  const res = await authFetch('/api/payment/checkout', {
    method: 'POST',
    body: JSON.stringify({ plan }),
  })
  if (!res.ok) throw new Error('Checkout failed')
  return res.json()
}

export async function confirmPayment(sessionId: string) {
  const res = await authFetch('/api/payment/confirm', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId }),
  })
  if (!res.ok) throw new Error('Confirm failed')
  return res.json()
}

export async function submitOnboarding(data: {
  full_name: string
  phone: string
  gender: string
  agent_name: string
  agent_gender: string
}) {
  const res = await authFetch('/api/onboarding/submit', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Onboarding failed')
  return res.json()
}

export async function getOnboardingStatus() {
  const res = await authFetch('/api/onboarding/status')
  if (!res.ok) throw new Error('Status failed')
  return res.json()
}

export async function getDashboard() {
  const res = await authFetch('/api/dashboard')
  if (!res.ok) throw new Error('Dashboard failed')
  return res.json()
}
