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
    return <div className="text-center text-gray-500 py-12">Loading...</div>
  }

  return (
    <div>
      <StepIndicator steps={['תשלום', 'הגדרות', 'מוכן!']} current={2} />

      <h2 className="text-2xl font-bold text-center mb-6">Dashboard</h2>

      <div className="space-y-4">
        {data.agents.map((agent) => (
          <div key={agent.agent_id} className="bg-white rounded-xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <span
                className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                  agent.status === 'active'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-yellow-100 text-yellow-700'
                }`}
              >
                {agent.status}
              </span>
              <h3 className="text-xl font-semibold">{agent.agent_name}</h3>
            </div>
            <div className="text-sm text-gray-500 space-y-1">
              <p>Agent ID: <span dir="ltr" className="font-mono">{agent.agent_id}</span></p>
              <p>Gender: {agent.agent_gender}</p>
            </div>
          </div>
        ))}

        {data.agents.length === 0 && (
          <p className="text-center text-gray-400">No agents yet</p>
        )}

        {data.subscription && (
          <div className="bg-white rounded-xl p-6 shadow-sm">
            <h3 className="font-semibold mb-2">Subscription</h3>
            <p className="text-sm text-gray-500">
              Plan: <span className="font-medium text-gray-900">{data.subscription.plan}</span>
              {' — '}
              Status: <span className="font-medium text-green-600">{data.subscription.status}</span>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
