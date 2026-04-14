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
  tts_voice_name?: string
}) {
  const res = await authFetch('/api/onboarding/submit', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Onboarding failed')
  return res.json()
}

// ─── Voices (voice picker for onboarding + dashboard) ──────────────
// The voice picker reads the manifest via our backend proxy so we
// don't hardcode the GCS bucket URL on the client. Per-agent voice
// updates flow through the tenant-scoped PATCH endpoint.

export interface VoiceManifestEntry {
  name: string
  gender: 'female' | 'male'
  is_default: boolean
  sample_path: string
  size_bytes: number
  url_prod: string
  url_dev: string
}

export interface VoiceManifest {
  model: string
  language_code: string
  sample_text: string
  default_voice: string
  voices: VoiceManifestEntry[]
}

export async function getVoiceManifest(): Promise<VoiceManifest> {
  // Public — no auth needed.
  const res = await fetch('/api/voices/manifest')
  if (!res.ok) throw new Error('Voice manifest fetch failed')
  return res.json()
}

export async function getAgentVoice(
  tenantId: number,
  agentId: string,
): Promise<{ agent_id: string; tts_voice_name: string }> {
  const res = await authFetch(
    `/api/tenants/${tenantId}/agents/${encodeURIComponent(agentId)}/voice`,
  )
  if (!res.ok) throw new Error('Get agent voice failed')
  return res.json()
}

export async function updateAgentVoice(
  tenantId: number,
  agentId: string,
  ttsVoiceName: string,
): Promise<{ agent_id: string; tts_voice_name: string; note: string }> {
  const res = await authFetch(
    `/api/tenants/${tenantId}/agents/${encodeURIComponent(agentId)}/voice`,
    {
      method: 'PATCH',
      body: JSON.stringify({ tts_voice_name: ttsVoiceName }),
    },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      detail?: { error?: string }
    }
    throw new Error(body?.detail?.error || 'Update voice failed')
  }
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

// ─── Superadmin ──────────────────────────────────────────────────────

export async function getAdminOverview() {
  const res = await authFetch('/api/admin/overview')
  if (!res.ok) throw new Error('Admin overview failed')
  return res.json()
}

export async function getAdminVmStats() {
  const res = await authFetch('/api/admin/vm-stats')
  if (!res.ok) throw new Error('VM stats failed')
  return res.json()
}

export async function getAdminAgentDetail(agentId: string) {
  const res = await authFetch(`/api/admin/agents/${encodeURIComponent(agentId)}`)
  if (!res.ok) throw new Error('Agent detail failed')
  return res.json()
}

export async function rotateMeterKey(agentId: string) {
  const res = await authFetch(
    `/api/admin/agents/${encodeURIComponent(agentId)}/keys/rotate`,
    { method: 'POST' },
  )
  if (!res.ok) throw new Error('Key rotation failed')
  return res.json()
}

export async function setUserRole(userId: number, role: 'user' | 'superadmin') {
  const res = await authFetch(`/api/admin/users/${userId}/role`, {
    method: 'POST',
    body: JSON.stringify({ role }),
  })
  if (!res.ok) throw new Error('Role update failed')
  return res.json()
}

// ─── Tenants ──────────────────────────────────────────────────────────

export async function getMyTenants() {
  const res = await authFetch('/api/tenants')
  if (!res.ok) throw new Error('List tenants failed')
  return res.json()
}

export async function createTenant(name: string, billing_email?: string) {
  const res = await authFetch('/api/tenants', {
    method: 'POST',
    body: JSON.stringify({ name, billing_email: billing_email || '' }),
  })
  if (!res.ok) throw new Error('Create tenant failed')
  return res.json()
}

export async function getTenantDetail(tenantId: number) {
  const res = await authFetch(`/api/tenants/${tenantId}`)
  if (!res.ok) throw new Error('Tenant detail failed')
  return res.json()
}

export async function updateTenant(
  tenantId: number,
  body: { name?: string; billing_email?: string },
) {
  const res = await authFetch(`/api/tenants/${tenantId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Update tenant failed')
  return res.json()
}

export async function deleteTenant(tenantId: number) {
  const res = await authFetch(`/api/tenants/${tenantId}`, { method: 'DELETE' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.detail?.error || 'Delete tenant failed')
  }
}

export async function transferTenantOwner(tenantId: number, newOwnerUserId: number) {
  const res = await authFetch(`/api/tenants/${tenantId}/transfer-owner`, {
    method: 'POST',
    body: JSON.stringify({ new_owner_user_id: newOwnerUserId }),
  })
  if (!res.ok) throw new Error('Transfer ownership failed')
  return res.json()
}

export async function changeMemberRole(tenantId: number, userId: number, role: 'admin' | 'member') {
  const res = await authFetch(`/api/tenants/${tenantId}/members/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  })
  if (!res.ok) throw new Error('Change role failed')
  return res.json()
}

export async function removeMember(tenantId: number, userId: number) {
  const res = await authFetch(`/api/tenants/${tenantId}/members/${userId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Remove member failed')
}

export async function createInvite(tenantId: number, email: string, role: 'admin' | 'member') {
  const res = await authFetch(`/api/tenants/${tenantId}/invites`, {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  })
  if (!res.ok) throw new Error('Create invite failed')
  return res.json()
}

export async function revokeInvite(tenantId: number, inviteId: number) {
  const res = await authFetch(`/api/tenants/${tenantId}/invites/${inviteId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Revoke invite failed')
}

export async function previewInvite(token: string) {
  const res = await fetch(`/api/invites/preview?token=${encodeURIComponent(token)}`)
  if (!res.ok) throw new Error('Invite preview failed')
  return res.json()
}

export async function acceptInvite(token: string) {
  const res = await authFetch('/api/invites/accept', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.detail?.error || 'Accept invite failed')
  }
  return res.json()
}

export async function getTenantDashboard(tenantId: number) {
  const res = await authFetch(`/api/dashboard/tenants/${tenantId}`)
  if (!res.ok) throw new Error('Tenant dashboard failed')
  return res.json()
}

// ─── Superadmin ──────────────────────────────────────────────────────

export async function upsertAgentSubscription(
  agentId: string,
  body: {
    user_id: number
    plan_id: string
    period_start: string
    period_end: string
    base_allowance_micros?: number
    overage_enabled?: boolean
    overage_cap_micros?: number | null
    wallet_balance_micros?: number
  },
) {
  const res = await authFetch(
    `/api/admin/agents/${encodeURIComponent(agentId)}/subscription`,
    { method: 'POST', body: JSON.stringify(body) },
  )
  if (!res.ok) throw new Error('Subscription upsert failed')
  return res.json()
}
