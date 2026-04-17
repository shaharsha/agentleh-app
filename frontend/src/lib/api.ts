import { supabase } from './supabase'
import type {
  IntegrationsResponse,
  GoogleConnectStartResponse,
  GoogleDisconnectResponse,
  TenantUsage,
} from './types'

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

  if (res.status !== 401) return res

  // 401 path: the JWT may have expired, OR the backend has revoked this
  // account (app_users.deleted_at is set). Try a token refresh once; if
  // the refreshed request still 401s, the server has actively revoked us
  // and we need to drop the stale Supabase session from localStorage so a
  // reload doesn't silently re-authenticate the dead account.
  const { data: { session: refreshed } } = await supabase.auth.refreshSession()
  if (refreshed?.access_token) {
    headers['Authorization'] = `Bearer ${refreshed.access_token}`
    const retry = await fetch(url, { ...options, headers })
    if (retry.status !== 401) return retry
  }

  // Local sign-out only — the refresh token may already be invalid at
  // Supabase, and we don't want to block UI on a network call. The app
  // re-renders the landing page the moment this promise resolves.
  await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
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

// ─── Coupons (plan activation) ────────────────────────────────────────
//
// Plan activation flows through coupon redemption — no Stripe yet.
// Both endpoints are user-scoped and rate-limited server-side.

export interface CouponPreview {
  code: string
  duration_days: number
  plan: {
    plan_id: string
    name_he: string
    price_ils_cents: number
    billing_mode: string
    base_allowance_micros: number
    allows_overage: boolean
    plan_has_tts: boolean
  }
  schedule: {
    kind: 'immediate' | 'renewal' | 'upgrade_immediate' | 'downgrade_queued'
    period_start: string
    period_end: string
    supersedes_subscription_id: number | null
  }
  one_per_user: boolean
  already_redeemed_by_user: boolean
  max_redemptions: number | null
  redemption_count: number
}

export interface CouponRedemption {
  subscription_id: number
  redemption_id: number
  tenant_id: number
  plan_id: string
  period_start: string
  period_end: string
  is_immediate: boolean
  superseded_subscription_id: number | null
}

export class CouponApiError extends Error {
  status: number
  code: string
  detail: Record<string, unknown>
  constructor(status: number, code: string, detail: Record<string, unknown>, msg?: string) {
    super(msg || code)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

async function _couponCall<T>(url: string, body: unknown): Promise<T> {
  const res = await authFetch(url, { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as {
      detail?: Record<string, unknown> & { error?: string }
    }
    const detail = errBody?.detail || {}
    const code = (detail.error as string) || 'coupon_error'
    throw new CouponApiError(res.status, code, detail)
  }
  return res.json()
}

export async function previewCoupon(
  code: string,
  tenantId?: number,
): Promise<CouponPreview> {
  return _couponCall<CouponPreview>('/api/coupons/preview', {
    code,
    tenant_id: tenantId ?? null,
  })
}

export async function redeemCoupon(
  code: string,
  tenantId?: number | null,
): Promise<{ redemption: CouponRedemption }> {
  return _couponCall<{ redemption: CouponRedemption }>('/api/coupons/redeem', {
    code,
    tenant_id: tenantId ?? null,
  })
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
): Promise<{ agent_id: string; tts_voice_name: string; bot_gender: 'male' | 'female' }> {
  const res = await authFetch(
    `/api/tenants/${tenantId}/agents/${encodeURIComponent(agentId)}/voice`,
  )
  if (!res.ok) throw new Error('Get agent voice failed')
  return res.json()
}

export async function updateAgentVoice(
  tenantId: number,
  agentId: string,
  update: { tts_voice_name?: string; bot_gender?: 'male' | 'female' },
): Promise<{
  agent_id: string
  tts_voice_name: string
  bot_gender: 'male' | 'female'
  note: string
}> {
  const res = await authFetch(
    `/api/tenants/${tenantId}/agents/${encodeURIComponent(agentId)}/voice`,
    {
      method: 'PATCH',
      body: JSON.stringify(update),
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

export async function deleteAgent(tenantId: number, agentId: string) {
  const res = await authFetch(
    `/api/tenants/${tenantId}/agents/${encodeURIComponent(agentId)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.detail?.message || body?.detail?.error || 'Delete agent failed')
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

export async function getTenantUsage(
  tenantId: number,
  opts?: { from?: string; to?: string },
): Promise<TenantUsage> {
  const qs = new URLSearchParams()
  if (opts?.from) qs.set('from', opts.from)
  if (opts?.to) qs.set('to', opts.to)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const res = await authFetch(`/api/dashboard/tenants/${tenantId}/usage${suffix}`)
  if (!res.ok) throw new Error('Tenant usage failed')
  return res.json()
}

export interface AuditEvent {
  id: number
  actor_user_id: number | null
  actor_email: string | null
  actor_full_name: string | null
  action: string
  target_type: string | null
  target_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string | null
}

export async function listTenantAudit(
  tenantId: number,
  opts?: { limit?: number; offset?: number },
): Promise<{ events: AuditEvent[]; limit: number; offset: number }> {
  const qs = new URLSearchParams()
  if (opts?.limit !== undefined) qs.set('limit', String(opts.limit))
  if (opts?.offset !== undefined) qs.set('offset', String(opts.offset))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const res = await authFetch(`/api/tenants/${tenantId}/audit${suffix}`)
  if (!res.ok) throw new Error('Audit log failed')
  return res.json()
}

// ─── Superadmin: cross-tenant views ────────────────────────────────

export interface AdminTenantRow {
  id: number
  slug: string
  name: string
  name_base: string | null
  created_at: string | null
  billing_email: string | null
  owner_user_id: number
  owner_email: string | null
  owner_full_name: string | null
  member_count: number
  agent_count: number
  plan_id: string | null
  plan_name_he: string | null
  price_ils_cents: number | null
  subscription_status: string | null
  subscription_period_end: string | null
}

export async function adminListTenants(): Promise<{ tenants: AdminTenantRow[] }> {
  const res = await authFetch('/api/admin/tenants')
  if (!res.ok) throw new Error('Admin tenants failed')
  return res.json()
}

export async function adminTenantDetail(tenantId: number): Promise<Record<string, unknown>> {
  const res = await authFetch(`/api/admin/tenants/${tenantId}`)
  if (!res.ok) throw new Error('Admin tenant detail failed')
  return res.json()
}

export interface ProvisionProgress {
  step: number
  total: number
  label: string
}

export interface ProvisionSuccess {
  agent_id: string
  gateway_url: string
  port: number
  status: string
}

export async function provisionTenantAgent(
  tenantId: number,
  body: {
    agent_name: string
    agent_gender?: string
    phone: string
    user_name?: string
    tts_voice_name?: string
  },
  onProgress?: (progress: ProvisionProgress) => void,
): Promise<ProvisionSuccess> {
  // The backend returns an NDJSON stream:
  //   {"type": "progress", "step": N, "total": M, "label": "..."}
  //   ...
  //   {"type": "result", "success": true,  "agent_id": "...", "gateway_url": "...", "port": ..., "status": "active"}
  // OR
  //   {"type": "result", "success": false, "error": "..."}
  const res = await authFetch(`/api/tenants/${tenantId}/agents`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    throw new Error(
      errBody?.detail?.message || errBody?.detail?.error || 'Provision failed',
    )
  }
  if (!res.body) throw new Error('No response body from provision endpoint')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Process complete lines. Keep any trailing partial line in buffer.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        let event: any
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'progress') {
          onProgress?.({ step: event.step, total: event.total, label: event.label })
        } else if (event.type === 'result') {
          if (event.success) {
            return {
              agent_id: event.agent_id,
              gateway_url: event.gateway_url || '',
              port: event.port || 0,
              status: event.status || 'active',
            }
          }
          throw new Error(event.error || 'Provision failed')
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Stream ended without a result event
  throw new Error('Provision stream ended unexpectedly')
}

// ─── Superadmin ──────────────────────────────────────────────────────

// ─── Superadmin coupons ───────────────────────────────────────────────

export interface AdminCouponRow {
  id: number
  code: string
  plan_id: string
  plan_name_he: string
  price_ils_cents: number
  duration_days: number
  max_redemptions: number | null
  redemption_count: number
  valid_from: string
  valid_until: string | null
  one_per_user: boolean
  notes: string
  disabled_at: string | null
  created_by: number | null
  created_by_email: string | null
  created_at: string
}

export interface AdminCouponRedemptionRow {
  id: number
  coupon_id: number | null
  user_id: number
  user_email: string
  user_full_name: string
  tenant_id: number
  tenant_name: string
  tenant_slug: string
  subscription_id: number
  plan_id: string
  duration_days: number
  period_start: string
  period_end: string
  granted_by_admin: number | null
  granted_by_admin_email: string | null
  redeemed_at: string
}

export async function adminListCoupons(): Promise<{ coupons: AdminCouponRow[] }> {
  const res = await authFetch('/api/admin/coupons')
  if (!res.ok) throw new Error('List coupons failed')
  return res.json()
}

export async function adminCreateCoupon(body: {
  code?: string
  plan_id: string
  duration_days: number
  max_redemptions?: number | null
  valid_until?: string | null
  one_per_user?: boolean
  notes?: string
}): Promise<AdminCouponRow> {
  const res = await authFetch('/api/admin/coupons', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.detail?.error || 'Create coupon failed')
  }
  return res.json()
}

export async function adminUpdateCoupon(
  couponId: number,
  body: Partial<{
    notes: string
    max_redemptions: number | null
    valid_until: string | null
    one_per_user: boolean
  }>,
): Promise<AdminCouponRow> {
  const res = await authFetch(`/api/admin/coupons/${couponId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Update coupon failed')
  return res.json()
}

export async function adminSetCouponDisabled(
  couponId: number,
  disabled: boolean,
): Promise<AdminCouponRow> {
  const path = disabled
    ? `/api/admin/coupons/${couponId}/disable`
    : `/api/admin/coupons/${couponId}/enable`
  const res = await authFetch(path, { method: 'POST' })
  if (!res.ok) throw new Error('Toggle coupon failed')
  return res.json()
}

export async function adminListCouponRedemptions(
  couponId: number,
): Promise<{ redemptions: AdminCouponRedemptionRow[] }> {
  const res = await authFetch(`/api/admin/coupons/${couponId}/redemptions`)
  if (!res.ok) throw new Error('List redemptions failed')
  return res.json()
}

export async function adminGrantPlan(
  tenantId: number,
  body: { plan_id: string; duration_days: number },
): Promise<{ redemption: CouponRedemption }> {
  const res = await authFetch(`/api/admin/tenants/${tenantId}/grant-plan`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.detail?.error || 'Grant plan failed')
  }
  return res.json()
}

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

// ─────────────────────────────────────────────────────────────────────────
// Integrations (per-agent Google Calendar + Gmail connection)
// ─────────────────────────────────────────────────────────────────────────

export async function getAgentIntegrations(
  tenantId: number,
  agentId: string,
): Promise<IntegrationsResponse> {
  const res = await authFetch(
    `/api/tenants/${tenantId}/agents/${encodeURIComponent(agentId)}/integrations`,
  )
  if (!res.ok) throw new Error('Failed to load integrations')
  return res.json()
}

export async function startGoogleConnect(
  tenantId: number,
  agentId: string,
  opts: { login_hint?: string; capabilities?: string[] } = {},
): Promise<GoogleConnectStartResponse> {
  const res = await authFetch(
    `/api/tenants/${tenantId}/agents/${encodeURIComponent(
      agentId,
    )}/integrations/google/connect`,
    { method: 'POST', body: JSON.stringify(opts) },
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      detail?: { error?: string; message?: string }
    }
    throw new Error(
      body?.detail?.message || body?.detail?.error || 'Failed to start Google connect flow',
    )
  }
  return res.json()
}

export async function disconnectGoogle(
  tenantId: number,
  agentId: string,
): Promise<GoogleDisconnectResponse> {
  const res = await authFetch(
    `/api/tenants/${tenantId}/agents/${encodeURIComponent(
      agentId,
    )}/integrations/google`,
    { method: 'DELETE' },
  )
  if (!res.ok) throw new Error('Failed to disconnect Google')
  return res.json()
}
