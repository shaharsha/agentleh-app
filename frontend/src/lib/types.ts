export interface AppUser {
  id: number
  email: string
  full_name: string
  phone: string
  gender: string
  onboarding_status: 'pending' | 'payment_done' | 'complete'
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
