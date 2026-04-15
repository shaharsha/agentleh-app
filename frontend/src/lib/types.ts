export interface AppUser {
  id: number
  email: string
  full_name: string
  phone: string
  gender: string
  onboarding_status: 'pending' | 'payment_done' | 'complete'
  role: 'user' | 'superadmin'
  tenants?: TenantMembership[]
  default_tenant_id?: number | null
}

export type TenantRole = 'owner' | 'admin' | 'member'

export interface TenantMembership {
  id: number
  slug: string
  name: string
  /** Raw owner-name source for auto-generated tenants; NULL once the
   *  user explicitly renames the workspace. Frontend's <TenantName />
   *  uses this to render per-language default labels without
   *  overwriting user renames. */
  name_base: string | null
  role: TenantRole
  owner_user_id: number
}

export interface TenantMember {
  user_id: number
  email: string
  full_name: string
  role: TenantRole
  joined_at: string
}

export interface TenantAgent {
  agent_id: string
  agent_name: string
  agent_gender: string
  status: string
  gateway_url?: string
}

export interface TenantInvite {
  id: number
  email: string
  role: TenantRole
  created_at?: string
  expires_at: string
}

export interface TenantDetail {
  tenant: {
    id: number
    slug: string
    name: string
    name_base: string | null
    owner_user_id: number
    billing_email: string
    created_at: string | null
    role: TenantRole
  }
  members: TenantMember[]
  agents: TenantAgent[]
  pending_invites: TenantInvite[]
}

export interface InvitePreview {
  tenant_name: string
  tenant_slug: string
  inviter_name: string
  inviter_email: string
  email: string
  role: TenantRole
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expires_at: string | null
}

export interface AdminUserRow {
  id: number
  email: string
  full_name: string
  phone: string
  role: 'user' | 'superadmin'
  onboarding_status: string
  agent_count: number
  created_at: string
}

export interface AdminAgentRow {
  agent_id: string
  gateway_url: string
  agent_name: string | null
  agent_gender: string | null
  user_id: number | null
  user_email: string | null
  user_full_name: string | null
  plan_id: string | null
  plan_name_he: string | null
  billing_mode: string | null
  subscription_status: string | null
  base_allowance_micros: number | null
  used_micros: number | null
  overage_enabled: boolean | null
  overage_cap_micros: number | null
  overage_used_micros: number | null
  wallet_balance_micros: number | null
}

export interface BillingPlan {
  plan_id: string
  name_he: string
  price_ils_cents: number
  billing_mode: 'plan_hardblock' | 'plan_overage' | 'wallet'
  base_allowance_micros: number
  allows_overage: boolean
  default_overage_cap_micros: number | null
  rate_limit_rpm: number
}

export interface AdminOverview {
  users: AdminUserRow[]
  agents: AdminAgentRow[]
  plans: BillingPlan[]
}

export interface UsageEvent {
  event_id: number
  ts: string
  kind: 'llm' | 'search'
  upstream: string
  model: string
  input_tokens: number | null
  output_tokens: number | null
  search_queries: number | null
  cost_micros: number
  is_overage: boolean
  upstream_status: number | null
  latency_ms: number | null
}

export interface AdminAgentDetail {
  agent: {
    agent_id: string
    gateway_url: string
    agent_name: string | null
    user_id: number | null
    user_email: string | null
    user_full_name: string | null
  }
  recent_events: UsageEvent[]
  spend: {
    subscription?: Record<string, unknown>
    totals?: Record<string, unknown>
    error?: string
  }
}

export interface Agent {
  id: number
  agent_id: string
  agent_name: string
  agent_gender: string
  status: string
  gateway_url: string
  created_at: string
  // Added by db.get_user_agents JOIN on agents — populated on recent agents
  // (created post-meter-migration-008) but may be absent for legacy rows.
  tenant_id?: number
  tts_voice_name?: string
}

export interface Subscription {
  id: number
  plan: string
  status: string
  created_at: string
}

// ─────────────────────────────────────────────────────────────────────────
// Integrations (per-agent Google Calendar + Gmail connection)
// ─────────────────────────────────────────────────────────────────────────

export interface GoogleCapabilities {
  /** Capability keys the agent currently has — e.g. `manage_calendar`,
   *  `send_email`. Frontend maps to Hebrew labels. */
  can: string[]
  /** Capability keys explicitly NOT granted in the current scope set.
   *  Surfaced in the UI as a trust-building "what the agent cannot do"
   *  list — e.g. `read_email_bodies`. */
  cannot: string[]
}

export type IntegrationEntry =
  | {
      name: string
      connected: false
    }
  | {
      name: string
      connected: true
      email: string
      scopes: string[]
      capabilities: GoogleCapabilities
      granted_at: string | null
      last_refreshed_at: string | null
    }

export interface IntegrationsResponse {
  agent_id: string
  tenant_id: number
  integrations: {
    google: IntegrationEntry
  }
}

export interface GoogleConnectStartResponse {
  connect_url: string
  expires_in_seconds: number
}

export interface GoogleDisconnectResponse {
  revoked: boolean
  email: string | null
}
