import { useEffect, useState } from 'react'
import { getDashboard } from '../lib/api'
import StepIndicator from '../components/StepIndicator'
import type { Agent, AppUser, Subscription } from '../lib/types'

interface AgentSpend {
  agent_id: string
  subscription?: {
    plan_id: string
    plan_name?: string
    billing_mode?: string
    status: string
    period_start: string
    period_end: string
    base_allowance_micros: number
    used_micros: number
    overage_enabled: boolean
    overage_cap_micros: number | null
    overage_used_micros: number
    wallet_balance_micros: number
  }
  totals?: {
    llm_micros: number
    search_micros: number
    llm_input_tokens: number
    llm_output_tokens: number
    search_queries: number
    event_count: number
  }
}

interface AgentWithSpend extends Agent {
  spend: AgentSpend | null
}

interface DashboardData {
  user: AppUser
  agents: AgentWithSpend[]
  subscription: Subscription | null
}

const MICROS_PER_DOLLAR = 1_000_000

function fmtUsd(micros: number | null | undefined): string {
  if (micros == null) return '—'
  return `$${(micros / MICROS_PER_DOLLAR).toFixed(3)}`
}

function usagePct(used: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)

  useEffect(() => {
    getDashboard().then(setData).catch(console.error)
  }, [])

  if (!data) {
    return (
      <div className="flex items-center justify-center py-24">
        <svg className="animate-spin h-8 w-8 text-brand" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  return (
    <div>
      <StepIndicator steps={['תוכנית', 'הגדרות', 'מוכן']} current={2} />

      <div className="text-center mb-10">
        <h2 className="text-[28px] font-bold tracking-[-0.6px] mb-2">הסוכן שלך מוכן</h2>
        <p className="text-[15px] text-text-secondary">שלח הודעה בוואטסאפ והסוכן יענה לך</p>
      </div>

      <div className="space-y-4">
        {data.agents.map((agent) => (
          <div key={agent.agent_id} className="glass-card-elevated rounded-[22px] p-6 relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-[3px] bg-brand rounded-t-[22px]" />

            <div className="flex items-start justify-between mb-5">
              <span className={`text-[12px] font-semibold px-3 py-1 rounded-full ${
                agent.status === 'active'
                  ? 'bg-success-light text-success'
                  : 'bg-yellow-100 text-yellow-600'
              }`}>
                {agent.status === 'active' ? 'פעיל' : agent.status}
              </span>
              <div className="flex items-center gap-3">
                <div className="text-left">
                  <h3 className="text-[20px] font-bold tracking-[-0.3px]">{agent.agent_name}</h3>
                  <p className="text-[13px] text-text-muted">
                    {agent.agent_gender === 'male' ? 'זכר' : 'נקבה'}
                  </p>
                </div>
                <div className="w-12 h-12 rounded-[14px] bg-brand flex items-center justify-center shadow-[0_8px_24px_rgba(212,98,43,0.2)]">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
              </div>
            </div>

            <div className="glass-card rounded-[14px] p-4">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-mono text-text-muted" dir="ltr">{agent.agent_id}</span>
                <span className="text-text-secondary">מזהה סוכן</span>
              </div>
            </div>

            {/* Plan + usage section */}
            {agent.spend?.subscription ? (
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-text-muted">
                    {agent.spend.subscription.plan_name || agent.spend.subscription.plan_id}
                  </span>
                  <span className="text-text-secondary">תוכנית</span>
                </div>
                {agent.spend.subscription.billing_mode !== 'wallet' && (
                  <UsageBar
                    used={agent.spend.subscription.used_micros}
                    total={
                      agent.spend.subscription.base_allowance_micros +
                      (agent.spend.subscription.overage_enabled
                        ? agent.spend.subscription.overage_cap_micros || 0
                        : 0)
                    }
                  />
                )}
                {agent.spend.subscription.billing_mode === 'wallet' && (
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="font-mono text-text-primary" dir="ltr">
                      {fmtUsd(agent.spend.subscription.wallet_balance_micros)}
                    </span>
                    <span className="text-text-secondary">יתרת ארנק</span>
                  </div>
                )}
                {agent.spend.totals && (
                  <div className="grid grid-cols-2 gap-2 text-[12px] text-text-muted">
                    <div className="flex items-center justify-between">
                      <span dir="ltr">{fmtUsd(agent.spend.totals.llm_micros)}</span>
                      <span>LLM</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span dir="ltr">{fmtUsd(agent.spend.totals.search_micros)}</span>
                      <span>חיפוש</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span dir="ltr">
                        {agent.spend.totals.llm_input_tokens.toLocaleString()}
                      </span>
                      <span>טוקנים (in)</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span dir="ltr">
                        {agent.spend.totals.llm_output_tokens.toLocaleString()}
                      </span>
                      <span>טוקנים (out)</span>
                    </div>
                  </div>
                )}
                {agent.spend.subscription.status === 'exhausted' && (
                  <div className="rounded-[14px] bg-red-50 text-red-700 px-3 py-2 text-[13px] text-center">
                    נגמרה הקצבה החודשית. לשדרוג — צור קשר.
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-4 rounded-[14px] bg-yellow-50 text-yellow-700 px-3 py-2 text-[12px] text-center">
                מנוי לא מוגדר — צור קשר לקבלת תוכנית.
              </div>
            )}
          </div>
        ))}

        {data.agents.length === 0 && (
          <div className="glass-card rounded-[22px] p-12 text-center">
            <p className="text-text-muted text-[15px]">אין סוכנים עדיין</p>
          </div>
        )}

      </div>
    </div>
  )
}

function UsageBar({ used, total }: { used: number; total: number }) {
  const pct = usagePct(used, total)
  const color =
    pct >= 95 ? 'bg-red-500' : pct >= 75 ? 'bg-yellow-500' : 'bg-success'
  return (
    <div>
      <div className="flex items-center justify-between text-[12px] text-text-muted mb-1">
        <span dir="ltr">
          {fmtUsd(used)} / {fmtUsd(total)}
        </span>
        <span>שימוש ({pct}%)</span>
      </div>
      <div className="w-full h-2 rounded-full bg-gray-100 overflow-hidden">
        <div
          className={`h-full ${color} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
