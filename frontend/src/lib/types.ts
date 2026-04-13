export interface AppUser {
  id: number
  email: string
  full_name: string
  phone: string
  gender: string
  onboarding_status: 'pending' | 'payment_done' | 'complete'
  role: 'user' | 'superadmin'
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
}

export interface Subscription {
  id: number
  plan: string
  status: string
  created_at: string
}
