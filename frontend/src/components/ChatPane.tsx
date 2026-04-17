import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildChatWebsocketUrl } from '../lib/api'
import { useI18n } from '../lib/i18n'

interface ChatPaneProps {
  tenantId: number
  agentId: string
  agentName?: string
}

type Role = 'user' | 'assistant' | 'system'

interface Message {
  id: string
  role: Role
  text: string
  ts: number
  /** True when the assistant is still streaming tokens into this bubble. */
  streaming?: boolean
  /** runId from the gateway, used to correlate chat.abort. */
  runId?: string
}

type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'offline'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

function firstStrongIsRtl(text: string): boolean {
  // Conservative first-strong detector. Matches Hebrew + Arabic. Used
  // to set `dir="auto"` equivalent per-bubble so Hebrew messages from
  // the assistant render RTL even inside an LTR page, and vice versa.
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0
    if ((code >= 0x0590 && code <= 0x08FF) || (code >= 0xFB1D && code <= 0xFDFF)) return true
    if (code >= 0x41 && code <= 0x7A) return false
  }
  return false
}

/**
 * In-app web chat with an agent. Speaks OpenClaw's gateway protocol
 * through the backend WebSocket proxy at
 *   wss://.../api/tenants/{tid}/agents/{aid}/chat?access_token=...
 * The proxy:
 *   - authenticates the Supabase JWT + tenant membership
 *   - signs the Ed25519 device handshake on our behalf
 *   - pins sessionKey to webchat-u<user>-a<agent>
 *   - enforces the chat.* method allowlist
 * So from the browser's perspective the socket is a thin JSON-RPC
 * transport where we send `req` frames and receive `res` / `event`
 * frames.
 */
export default function ChatPane({ tenantId, agentId, agentName }: ChatPaneProps) {
  const { t, dir } = useI18n()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [connState, setConnState] = useState<ConnState>('connecting')
  const [canSend, setCanSend] = useState(false)
  const [streamingRunId, setStreamingRunId] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reqSeqRef = useRef(0)
  const reconnectAttemptRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const sessionKeyRef = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const nextReqId = () => {
    reqSeqRef.current += 1
    return `webchat-${reqSeqRef.current}`
  }

  /** Turn a gateway `chat` event payload into a consumer-friendly
   *  assistant bubble update. Per OpenClaw's ChatEventSchema:
   *    state ∈ {"delta", "final", "aborted", "error"}
   *    message is the opaque assistant-message object — we pull text
   *    out of its `.content` blocks or its direct `.text` property,
   *    whichever exists (OpenClaw has evolved both shapes). */
  const handleChatEvent = useCallback(
    (payload: any) => {
      const runId: string | undefined = payload?.runId
      const state: string | undefined = payload?.state
      const text: string = extractText(payload?.message) || (payload?.errorMessage || '')
      if (!runId) return
      const terminal = state === 'final' || state === 'aborted' || state === 'error'

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.runId === runId)
        if (idx === -1) {
          return [
            ...prev,
            {
              id: `a-${runId}`,
              role: 'assistant',
              text,
              ts: Date.now(),
              streaming: !terminal,
              runId,
            },
          ]
        }
        const existing = prev[idx]
        // OpenClaw's delta events carry the full assistant message
        // so far (not per-token diffs), so overwrite rather than
        // append. If a later event lacks text (e.g. a pure-state
        // terminal event), keep what we've rendered.
        const next: Message = {
          ...existing,
          text: text || existing.text,
          streaming: !terminal,
        }
        return [...prev.slice(0, idx), next, ...prev.slice(idx + 1)]
      })

      if (terminal) {
        setStreamingRunId((prevId) => (prevId === runId ? null : prevId))
      }
    },
    [],
  )

  const handleFrame = useCallback(
    (raw: string) => {
      let frame: any
      try {
        frame = JSON.parse(raw)
      } catch {
        return
      }
      // Proxy status frames:
      if (frame.type === 'ready') {
        sessionKeyRef.current = frame.sessionKey || null
        setCanSend(true)
        setConnState('connected')
        // Request history for this session so the user sees what they
        // said before (and what the agent replied with) on reload.
        const id = nextReqId()
        wsRef.current?.send(
          JSON.stringify({
            type: 'req',
            id,
            method: 'chat.history',
            params: { sessionKey: frame.sessionKey, limit: 50 },
          }),
        )
        return
      }
      if (frame.type === 'error') {
        // Dedupe: a failing gateway handshake loops the reconnect
        // attempts, which would pile up identical system bubbles. Only
        // append if the last system message was a different error.
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          const text = `Proxy error: ${frame.error}`
          if (last && last.role === 'system' && last.text === text) {
            return prev
          }
          return [
            ...prev,
            { id: `err-${Date.now()}`, role: 'system', text, ts: Date.now() },
          ]
        })
        return
      }

      // Gateway frames:
      if (frame.type === 'res') {
        // OpenClaw wraps successful responses as {type:"res", id, ok,
        // payload}. Earlier this was keyed off `frame.result` which
        // never populated — that's why closing + reopening the pane
        // was losing history.
        const body = frame?.payload ?? frame?.result ?? {}
        if (Array.isArray(body?.messages)) {
          const loaded: Message[] = body.messages
            .map((m: any, idx: number) => {
              const role = normalizeRole(m?.role)
              if (!role) return null
              const text = extractText(m)
              if (!text) return null
              return {
                id: m?.id || `h-${idx}-${Date.now()}`,
                role,
                text,
                ts:
                  typeof m?.ts === 'number' ? m.ts : Date.parse(m?.createdAt || '') || Date.now(),
              }
            })
            .filter(Boolean) as Message[]
          if (loaded.length > 0) {
            setMessages(loaded)
          }
          return
        }
        // chat.send response carries the runId — stash it so we can
        // route chat events + abort, AND pre-create an empty assistant
        // bubble right now so the typing-dots indicator shows
        // immediately, not only after the first `delta` event arrives
        // (which often already has text, skipping the empty state).
        const runId = body?.runId
        if (runId) {
          setStreamingRunId(runId)
          setMessages((prev) => {
            // Don't duplicate if a bubble for this runId already exists
            // (shouldn't happen, but belt + suspenders).
            if (prev.some((m) => m.runId === runId)) return prev
            return [
              ...prev,
              {
                id: `a-${runId}`,
                role: 'assistant',
                text: '',
                ts: Date.now(),
                streaming: true,
                runId,
              },
            ]
          })
        }
        return
      }
      if (frame.type === 'event' && frame.event === 'chat') {
        handleChatEvent(frame.payload || {})
        return
      }
    },
    [handleChatEvent],
  )

  const connect = useCallback(async () => {
    setConnState((s) => (s === 'connected' ? 'reconnecting' : s))
    try {
      const url = await buildChatWebsocketUrl(tenantId, agentId)
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onopen = () => {
        reconnectAttemptRef.current = 0
      }
      ws.onmessage = (e: MessageEvent) => handleFrame(String(e.data))
      ws.onerror = () => {
        setConnState('reconnecting')
      }
      ws.onclose = (ev: CloseEvent) => {
        setCanSend(false)
        // 1008 = policy violation (bad token / not a member). Don't
        // auto-reconnect — the user needs to log in again or has no
        // access. Everything else we treat as transient.
        if (ev.code === 1008) {
          setConnState('offline')
          setMessages((prev) => [
            ...prev,
            {
              id: `denied-${Date.now()}`,
              role: 'system',
              text:
                ev.reason ||
                t({ he: 'גישה נדחתה', en: 'Access denied' }),
              ts: Date.now(),
            },
          ])
          return
        }
        setConnState('reconnecting')
        const attempt = reconnectAttemptRef.current + 1
        reconnectAttemptRef.current = attempt
        const wait = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current)
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          void connect()
        }, wait)
      }
    } catch (err) {
      setConnState('offline')
      setMessages((prev) => [
        ...prev,
        {
          id: `nocon-${Date.now()}`,
          role: 'system',
          text: (err as Error).message,
          ts: Date.now(),
        },
      ])
    }
  }, [tenantId, agentId, handleFrame, t])

  useEffect(() => {
    void connect()
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      wsRef.current?.close(1000, 'unmount')
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, agentId])

  // Auto-scroll to bottom when a new message arrives.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const sendMessage = () => {
    const text = input.trim()
    if (!text || !canSend || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const id = nextReqId()
    wsRef.current.send(
      JSON.stringify({
        type: 'req',
        id,
        method: 'chat.send',
        params: {
          message: text,
          // sessionKey is pinned server-side — our value is overwritten
          // by the proxy. We still pass one so the gateway schema is
          // happy.
          sessionKey: sessionKeyRef.current || undefined,
        },
      }),
    )
    setMessages((prev) => [
      ...prev,
      { id: `u-${id}`, role: 'user', text, ts: Date.now() },
    ])
    setInput('')
  }

  const abortStream = () => {
    if (!streamingRunId || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const id = nextReqId()
    wsRef.current.send(
      JSON.stringify({
        type: 'req',
        id,
        method: 'chat.abort',
        params: { runId: streamingRunId },
      }),
    )
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (streamingRunId) abortStream()
      else sendMessage()
    }
  }

  const stateBadge = useMemo(() => {
    const labels: Record<ConnState, { he: string; en: string }> = {
      connecting: { he: 'מתחבר…', en: 'Connecting…' },
      connected: { he: 'מחובר', en: 'Connected' },
      reconnecting: { he: 'מתחבר מחדש…', en: 'Reconnecting…' },
      offline: { he: 'לא זמין', en: 'Offline' },
    }
    return t(labels[connState])
  }, [connState, t])

  return (
    <div className="flex flex-col h-full" dir={dir}>
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="text-sm">
          <div className="font-semibold text-text-primary">
            {agentName || agentId}
          </div>
          <div className="text-[11px] text-text-muted">{stateBadge}</div>
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto p-4 space-y-3 bg-surface"
        role="log"
        aria-live="polite"
      >
        {messages.map((m) => {
          const isUser = m.role === 'user'
          const isSystem = m.role === 'system'
          const bubbleDir = firstStrongIsRtl(m.text) ? 'rtl' : 'ltr'
          const awaitingFirstToken = m.streaming && !m.text
          return (
            <div
              key={m.id}
              className={
                'flex ' + (isSystem ? 'justify-center' : isUser ? 'justify-end' : 'justify-start')
              }
            >
              <div
                dir={bubbleDir}
                className={[
                  'max-w-[75%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words',
                  // Assistant bubbles: bg-gray-100 correctly inverts in
                  // dark mode via the app's [data-theme="dark"] token
                  // remap (gray-100 becomes dark brown), with
                  // text-text-primary providing the matching foreground.
                  // The earlier `dark:bg-gray-800` was fighting the
                  // inversion — that token resolves to CREAM in dark
                  // mode, which is why the bubble looked washed out.
                  isSystem
                    ? 'bg-yellow-100 text-yellow-900 text-xs'
                    : isUser
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 text-text-primary',
                ].join(' ')}
              >
                {awaitingFirstToken ? <TypingIndicator /> : m.text}
              </div>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 border-t border-border flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          // dir="auto" lets the browser flip the typing direction per
          // first-strong directional character: Hebrew input renders
          // RTL, Latin input LTR, even inside an LTR-display page.
          // Matches what the assistant/user bubbles already do for
          // their text content.
          dir="auto"
          placeholder={t({
            he: 'כתוב הודעה… (Enter לשליחה, Shift+Enter לשורה חדשה)',
            en: 'Type a message… (Enter to send, Shift+Enter for newline)',
          })}
          rows={2}
          disabled={!canSend}
          className="input-glass flex-1 px-3 py-2 text-sm resize-none disabled:opacity-50"
        />
        {streamingRunId ? (
          <button
            onClick={abortStream}
            className="btn-secondary btn-sm"
          >
            {t({ he: 'עצור', en: 'Stop' })}
          </button>
        ) : (
          <button
            onClick={sendMessage}
            disabled={!canSend || !input.trim()}
            className="btn-brand btn-sm disabled:opacity-50"
          >
            {t({ he: 'שלח', en: 'Send' })}
          </button>
        )}
      </div>
    </div>
  )
}

// "Agent is typing..." indicator shown in the assistant bubble while
// we've received a runId/acknowledgement but no text tokens yet. Three
// dots with a staggered bounce, matching WhatsApp's pattern. Uses
// Tailwind's built-in `animate-bounce` with inline delays so we don't
// need to touch index.css for keyframes.
function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="typing">
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce"
        style={{ animationDelay: '0ms' }}
      />
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce"
        style={{ animationDelay: '150ms' }}
      />
      <span
        className="inline-block w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce"
        style={{ animationDelay: '300ms' }}
      />
    </span>
  )
}

function normalizeRole(role: unknown): Role | null {
  if (role === 'user' || role === 'assistant' || role === 'system') return role
  if (typeof role !== 'string') return null
  const lower = role.toLowerCase()
  if (lower === 'user' || lower === 'assistant' || lower === 'system') return lower as Role
  return null
}

// Strip OpenClaw's `<final>...</final>` wrapper that agents emit to
// mark the user-facing portion of their reply. OpenClaw's own
// sanitizeUserFacingText helper drops these via the same regex; we
// mirror it here so the web-chat bubble doesn't leak the raw tag.
// Case-insensitive + whitespace-tolerant so minor LLM drift
// (`<FINAL >`, `< /final>`) still gets stripped.
const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/gi

function extractText(message: any): string {
  if (!message) return ''
  let raw = ''
  if (typeof message.text === 'string') {
    raw = message.text
  } else {
    const content = message.content
    if (typeof content === 'string') {
      raw = content
    } else if (Array.isArray(content)) {
      raw = content
        .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n')
    }
  }
  return raw.replace(FINAL_TAG_RE, '').trim()
}
