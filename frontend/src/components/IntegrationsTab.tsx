import { useEffect, useState } from 'react'
import { getAgentIntegrations } from '../lib/api'
import type { IntegrationsResponse } from '../lib/types'
import { useI18n } from '../lib/i18n'

/**
 * Tenant-level integrations tab — shows Google + Telegram status for every
 * agent in the tenant and provides actions (connect / disconnect / copy link).
 *
 * Architecture note: integrations are per-agent, not per-tenant. This tab
 * collects them per agent and renders a row per integration per agent, which
 * scales naturally to multi-agent tenants.
 *
 * Telegram deep-link pattern: clicking the link opens Telegram and sends
 * `/start {agent_id}` to the bot, which the bridge intercepts to register
 * the (telegram, chat_id) → agent route. No OAuth flow; no backend call.
 */

interface AgentRow {
  agent_id: string
  agent_name: string
}

interface Props {
  tenantId: number
  agents: AgentRow[]
  isAdminOrOwner: boolean
}

interface AgentIntegrations {
  loading: boolean
  error: string | null
  data: IntegrationsResponse | null
}

export default function IntegrationsTab({ tenantId, agents, isAdminOrOwner }: Props) {
  const { t } = useI18n()
  const [byAgent, setByAgent] = useState<Record<string, AgentIntegrations>>({})
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    // Initialise loading state for all agents
    setByAgent(
      Object.fromEntries(agents.map(a => [a.agent_id, { loading: true, error: null, data: null }]))
    )
    // Fetch concurrently — typically 1-3 agents per tenant
    agents.forEach(agent => {
      getAgentIntegrations(tenantId, agent.agent_id)
        .then(data => {
          setByAgent(prev => ({ ...prev, [agent.agent_id]: { loading: false, error: null, data } }))
        })
        .catch(() => {
          setByAgent(prev => ({
            ...prev,
            [agent.agent_id]: {
              loading: false,
              error: t({ he: 'שגיאה בטעינה', en: 'Failed to load' }),
              data: null,
            },
          }))
        })
    })
  }, [tenantId, agents.map(a => a.agent_id).join(',')])

  const copyLink = (link: string, key: string) => {
    navigator.clipboard.writeText(link).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 2000)
    })
  }

  if (agents.length === 0) {
    return (
      <div className="glass-card p-6 text-text-muted text-center text-sm">
        {t({ he: 'אין סוכנים פעילים', en: 'No active agents' })}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {agents.map(agent => {
        const state = byAgent[agent.agent_id]
        return (
          <div key={agent.agent_id} className="glass-card p-5">
            <h3 className="text-sm font-medium text-text-primary mb-4">
              {agent.agent_name || agent.agent_id}
            </h3>

            {state?.loading && (
              <div className="text-text-muted text-sm animate-pulse">
                {t({ he: 'טוען...', en: 'Loading…' })}
              </div>
            )}
            {state?.error && (
              <div className="text-danger text-sm">{state.error}</div>
            )}
            {state?.data && (
              <div className="space-y-3">
                {/* Google */}
                <IntegrationRow
                  icon="G"
                  name="Google Calendar + Gmail"
                  connected={state.data.integrations.google.connected}
                  detail={
                    state.data.integrations.google.connected
                      ? state.data.integrations.google.email ?? undefined
                      : t({ he: 'לא מחובר', en: 'Not connected' })
                  }
                  actionLabel={
                    state.data.integrations.google.connected
                      ? t({ he: 'מנהל', en: 'Manage' })
                      : isAdminOrOwner
                      ? t({ he: 'חבר', en: 'Connect' })
                      : undefined
                  }
                  onAction={
                    isAdminOrOwner
                      ? () => window.open(`/tenants/${tenantId}/${agent.agent_id}/integrations`, '_blank')
                      : undefined
                  }
                />

                {/* Telegram */}
                <TelegramRow
                  agentId={agent.agent_id}
                  entry={state.data.integrations.telegram}
                  isAdminOrOwner={isAdminOrOwner}
                  copied={copied}
                  onCopy={copyLink}
                  t={t}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Generic integration row ───────────────────────────────────────────────

function IntegrationRow({
  icon, name, connected, detail, actionLabel, onAction,
}: {
  icon: string
  name: string
  connected: boolean
  detail?: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 rounded-md bg-surface-soft flex items-center justify-center text-xs font-bold text-text-secondary flex-shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{name}</div>
        {detail && <div className="text-xs text-text-muted truncate">{detail}</div>}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className={`text-xs font-medium ${connected ? 'text-success' : 'text-text-muted'}`}>
          {connected ? '●' : '○'}
        </span>
        {actionLabel && onAction && (
          <button onClick={onAction} className="btn-sm btn-secondary text-xs px-2 py-1">
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Telegram-specific row ─────────────────────────────────────────────────

import type { TelegramIntegrationEntry } from '../lib/types'

function TelegramRow({
  agentId, entry, isAdminOrOwner, copied, onCopy, t,
}: {
  agentId: string
  entry: TelegramIntegrationEntry
  isAdminOrOwner: boolean
  copied: string | null
  onCopy: (link: string, key: string) => void
  t: (b: { he: string; en: string }) => string
}) {
  const deeplink = entry.deeplink?.replace('{agent_id}', agentId) ?? null
  const copyKey = `tg-${agentId}`
  const isCopied = copied === copyKey

  let detail: string
  if (!entry.configured) {
    detail = t({ he: 'לא מוגדר — פנה לתמיכה', en: 'Not configured — contact support' })
  } else if (entry.linked_count === 0) {
    detail = t({ he: 'אין משתמשים מקושרים', en: 'No linked users yet' })
  } else {
    detail = t({
      he: `${entry.linked_count} משתמש${entry.linked_count !== 1 ? 'ים' : ''} מקושר${entry.linked_count !== 1 ? 'ים' : ''}`,
      en: `${entry.linked_count} linked user${entry.linked_count !== 1 ? 's' : ''}`,
    })
  }

  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-md bg-surface-soft flex items-center justify-center text-xs font-bold text-text-secondary flex-shrink-0 mt-0.5">
        TG
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">Telegram</div>
        <div className="text-xs text-text-muted">{detail}</div>

        {entry.configured && deeplink && isAdminOrOwner && (
          <div className="mt-2">
            <div className="text-xs text-text-muted mb-1">
              {t({
                he: 'שתף את הקישור הזה עם משתמשים כדי לאפשר להם להתחבר דרך טלגרם:',
                en: 'Share this link so users can connect via Telegram:',
              })}
            </div>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-surface-soft px-2 py-1 rounded font-mono text-text-secondary truncate max-w-xs">
                {deeplink}
              </code>
              <button
                onClick={() => onCopy(deeplink, copyKey)}
                className="btn-sm btn-secondary text-xs px-2 py-1 flex-shrink-0"
              >
                {isCopied
                  ? t({ he: 'הועתק!', en: 'Copied!' })
                  : t({ he: 'העתק', en: 'Copy' })}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
        <span className={`text-xs font-medium ${entry.configured && entry.linked_count > 0 ? 'text-success' : 'text-text-muted'}`}>
          {entry.configured && entry.linked_count > 0 ? '●' : '○'}
        </span>
      </div>
    </div>
  )
}
