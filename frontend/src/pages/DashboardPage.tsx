import { useEffect, useState } from 'react'
import { getDashboard } from '../lib/api'
import StepIndicator from '../components/StepIndicator'
import type { Agent, AppUser, Subscription } from '../lib/types'

interface DashboardData {
  user: AppUser
  agents: Agent[]
  subscription: Subscription | null
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
          <div key={agent.agent_id} className="glass-elevated rounded-[22px] p-6 relative overflow-hidden">
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

            <div className="glass rounded-[14px] p-4">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-mono text-text-muted" dir="ltr">{agent.agent_id}</span>
                <span className="text-text-secondary">מזהה סוכן</span>
              </div>
            </div>
          </div>
        ))}

        {data.agents.length === 0 && (
          <div className="glass rounded-[22px] p-12 text-center">
            <p className="text-text-muted text-[15px]">אין סוכנים עדיין</p>
          </div>
        )}

        {data.subscription && (
          <div className="glass rounded-[22px] p-5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold bg-success-light text-success px-3 py-1 rounded-full">
                {data.subscription.status === 'mock_active' ? 'פעיל' : data.subscription.status}
              </span>
              <div className="flex items-center gap-3">
                <div className="text-left">
                  <p className="text-[15px] font-semibold">{data.subscription.plan}</p>
                  <p className="text-[12px] text-text-muted">מנוי</p>
                </div>
                <div className="w-9 h-9 rounded-[12px] bg-success-light flex items-center justify-center">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30D158" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
