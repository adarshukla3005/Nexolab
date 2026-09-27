import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { api } from '../lib/api.js'
import { toast } from 'sonner'

export interface ChatMessage {
  id?: string
  role: 'user' | 'assistant'
  text: string
  artifact_slug_updated?: string | null
  user_name?: string | null
  user_id?: string | null
  version?: number
  created_at?: string
}

export interface ArtifactFull {
  id: string
  slug: string
  artifact_type: string
  title: string
  content_md: string
  version: number
}

export interface ArtifactChatProps {
  featureId: string
  /** The currently open artifact tab (or null). Used only as an initial edit hint;
   * the AI can still target any artifact by name. */
  artifact: ArtifactFull | null
  onArtifactUpdated: (updated: { slug: string; content_md: string; version: number }) => void
  /** True when the current user is the feature creator; shows the Clear-chat trash button. */
  canClearChat?: boolean
  /** Layout mode. 'dock' = horizontal strip at bottom of center panel. 'side' = vertical column at right of center panel. */
  mode?: 'dock' | 'side'
  /** Toggle between dock and side layout. When absent, no toggle button is shown. */
  onToggleMode?: () => void
  /** Close the chat entirely. When absent, no close button is shown. */
  onClose?: () => void
  /** Optional one-shot input pre-fill (e.g. from a selection popover's "Move to chat"). */
  draft?: string | null
  /** Fired once after we consume `draft` so the parent can clear it. */
  onDraftConsumed?: () => void
}

const QUICK_PROMPTS = [
  'Summarise the whole plan',
  'What stage comes next?',
  'Any blockers or risks?',
  'Show stage statuses',
]

function BotIcon({ size = 24 }: { size?: number }) {
  return (
    <div
      className="rounded-full bg-primary flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size }}
    >
      <svg
        width={size * 0.54}
        height={size * 0.54}
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v4" />
        <line x1="8" y1="16" x2="8" y2="16" />
        <line x1="16" y1="16" x2="16" y2="16" />
      </svg>
    </div>
  )
}

export function ArtifactChat({
  featureId,
  artifact,
  onArtifactUpdated,
  canClearChat = false,
  mode = 'dock',
  onToggleMode,
  onClose,
  draft,
  onDraftConsumed,
}: ArtifactChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(true)
  // Last user prompt that failed / was aborted — enables the Retry button.
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const seenIdsRef = useRef<Set<string>>(new Set())
  // Synchronous dedupe guard against burst double-clicks / rapid Enter presses.
  const sendInFlight = useRef(false)
  // AbortController for in-flight chat POST — lets the Stop button cancel a slow LLM call.
  const abortRef = useRef<AbortController | null>(null)

  // Load persisted chat history on mount / feature change.
  useEffect(() => {
    let cancelled = false
    setLoadingHistory(true)
    api.get<{ messages: ChatMessage[] }>(`/api/features/${featureId}/chat/history`)
      .then((r) => {
        if (cancelled) return
        setMessages(r.messages)
        seenIdsRef.current = new Set(r.messages.map((m) => m.id!).filter(Boolean))
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingHistory(false) })
    return () => { cancelled = true }
  }, [featureId])

  // Subscribe to live chat events (messages + artifact updates) via SSE.
  useEffect(() => {
    const url = `/api/features/${featureId}/chat/stream`
    const es = new EventSource(url, { withCredentials: true })
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (data.type === 'message' && data.id && !seenIdsRef.current.has(data.id)) {
          seenIdsRef.current.add(data.id)
          setMessages((prev) => [...prev, {
            id: data.id,
            role: data.role,
            text: data.text,
            artifact_slug_updated: data.artifact_slug_updated ?? null,
            user_name: data.user_name ?? null,
            user_id: data.user_id ?? null,
            created_at: data.created_at,
          }])
        } else if (data.type === 'message_ref' && data.id && !seenIdsRef.current.has(data.id)) {
          // Server said "there's a new message but it was too big to inline" — refetch history.
          // Preserves seenIdsRef guard so we don't double-append.
          seenIdsRef.current.add(data.id)
          api.get<{ messages: ChatMessage[] }>(`/api/features/${featureId}/chat/history`)
            .then((r) => setMessages(r.messages))
            .catch(() => { /* ignore */ })
        } else if (data.type === 'artifact_updated') {
          onArtifactUpdated({ slug: data.slug, content_md: data.content_md, version: data.version })
        } else if (data.type === 'artifact_changed') {
          // Lightweight change event (large artifacts don't fit in NOTIFY payload).
          // Fetch the fresh content, then apply the same update.
          fetch(`/api/features/${featureId}/artifacts/by-slug/${encodeURIComponent(data.slug)}`, { credentials: 'include' })
            .then((r) => r.ok ? r.json() : null)
            .then((art) => {
              if (art?.content_md !== undefined) {
                onArtifactUpdated({ slug: data.slug, content_md: art.content_md, version: data.version })
              }
            })
            .catch(() => { /* ignore */ })
        } else if (data.type === 'cleared') {
          setMessages([])
          seenIdsRef.current.clear()
          setLastFailedPrompt(null)
        }
      } catch { /* ignore */ }
    }
    es.onerror = () => { /* browser auto-retries */ }
    return () => es.close()
  }, [featureId, onArtifactUpdated])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  // Consume the one-shot draft (from "Move to chat" on a selection): pre-fill the input,
  // focus it, place caret at the end, and tell the parent we've read it.
  useEffect(() => {
    if (!draft) return
    setInput(draft)
    onDraftConsumed?.()
    setTimeout(() => {
      const el = inputRef.current
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
    }, 30)
  }, [draft, onDraftConsumed])

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Synchronous re-entry guard — a burst of double-clicks / rapid Enter presses can't
    // queue multiple requests before setSending(true) reaches the DOM.
    if (sendInFlight.current) return
    sendInFlight.current = true
    setInput('')
    setSending(true)
    setLastFailedPrompt(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch(`/api/features/${featureId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: ctrl.signal,
        body: JSON.stringify({ message: trimmed, targetSlug: artifact?.slug }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      // Message + assistant reply arrive via SSE — no local state mutation needed here.
    } catch (e) {
      const aborted = (e instanceof DOMException && e.name === 'AbortError')
        || (e instanceof Error && /aborted/i.test(e.message))
      if (aborted) {
        toast.info('Stopped')
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`Chat failed: ${msg}`)
      }
      // Remember the prompt so the user can Retry it with one click.
      setLastFailedPrompt(trimmed)
    } finally {
      setSending(false)
      sendInFlight.current = false
      abortRef.current = null
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [featureId, artifact])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const retry = useCallback(() => {
    if (lastFailedPrompt) send(lastFailedPrompt)
  }, [lastFailedPrompt, send])

  const clearHistory = useCallback(async () => {
    if (!window.confirm('Clear the entire chat history for this feature? This affects all collaborators.')) return
    try {
      await api.delete(`/api/features/${featureId}/chat/history`)
      // Local clear happens via the 'cleared' SSE event, but do it optimistically too.
      setMessages([])
      seenIdsRef.current.clear()
      setLastFailedPrompt(null)
      toast.success('Chat history cleared')
    } catch (e) {
      toast.error(String(e))
    }
  }, [featureId])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
        <BotIcon size={24} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground leading-none">AI Assistant</p>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            Shared with all collaborators
            {artifact ? ` · focused on ${artifact.title || artifact.slug}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {canClearChat && messages.length > 0 && (
            <button
              onClick={clearHistory}
              title="Clear chat history (owner only)"
              className="p-1 rounded text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
                <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
            </button>
          )}
          {/* Dock ↔ side layout toggle */}
          {onToggleMode && (
            <button
              onClick={onToggleMode}
              title={mode === 'dock' ? 'Dock chat to the right side' : 'Dock chat to the bottom'}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              {mode === 'dock' ? (
                // Icon: sidebar-right — moves chat to a vertical panel on the right.
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                </svg>
              ) : (
                // Icon: sidebar-bottom — moves chat back down to a horizontal strip.
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="3" y1="15" x2="21" y2="15" />
                </svg>
              )}
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              title="Close chat"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0 px-3 py-3 space-y-3">
        {loadingHistory && (
          <p className="text-xs text-muted-foreground text-center">Loading chat history…</p>
        )}
        {!loadingHistory && messages.length === 0 && (
          <>
            <div className="flex gap-2 items-start">
              <BotIcon size={24} />
              <div className="bg-secondary/70 rounded-2xl rounded-tl-sm px-3 py-2 text-sm text-foreground leading-relaxed max-w-[88%]">
                Ask anything about this workspace — stages, artifacts, logs, or what comes next. Say <em>"in the Spec artifact…"</em> to edit that artifact directly.
              </div>
            </div>
            <div className="pl-8 flex flex-col gap-1.5">
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => send(p)}
                  disabled={sending}
                  className="text-left text-sm px-3 py-1.5 rounded-full border border-border hover:border-primary/40 hover:bg-primary/5 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                >
                  {p}
                </button>
              ))}
            </div>
          </>
        )}

        {messages.map((m, i) => (
          <div key={m.id ?? i} className={`flex gap-2 items-end ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
            {m.role === 'assistant' ? (
              <BotIcon size={24} />
            ) : (
              <div
                className="w-6 h-6 rounded-full bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-bold text-muted-foreground"
                title={m.user_name ?? ''}
              >
                {(m.user_name?.[0] ?? 'Y').toUpperCase()}
              </div>
            )}
            <div className={`max-w-[84%] flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              {m.role === 'user' && m.user_name && (
                <p className="text-xs text-muted-foreground mb-0.5 px-1">{m.user_name}</p>
              )}
              <div className={`rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-br-sm whitespace-pre-wrap'
                  : 'bg-secondary/70 text-foreground rounded-bl-sm prose prose-xs dark:prose-invert max-w-none'
              }`}>
                {m.role === 'user' ? m.text : (
                  <ReactMarkdown
                    components={{
                      p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
                      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      em: ({ children }) => <em className="italic">{children}</em>,
                      ul: ({ children }) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal pl-4 mb-1.5 space-y-0.5">{children}</ol>,
                      li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                      code: ({ children, className }) => className
                        ? <pre className="bg-background/60 border border-border rounded px-2 py-1.5 text-xs font-mono overflow-x-auto my-1.5 whitespace-pre-wrap"><code>{children}</code></pre>
                        : <code className="bg-background/60 border border-border rounded px-1 py-0.5 text-xs font-mono">{children}</code>,
                      h1: ({ children }) => <p className="font-bold mb-1">{children}</p>,
                      h2: ({ children }) => <p className="font-semibold mb-1">{children}</p>,
                      h3: ({ children }) => <p className="font-semibold mb-0.5">{children}</p>,
                      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 opacity-80 hover:opacity-100">{children}</a>,
                      blockquote: ({ children }) => <blockquote className="border-l-2 border-primary/40 pl-2 opacity-80 my-1">{children}</blockquote>,
                    }}
                  >
                    {m.text}
                  </ReactMarkdown>
                )}
              </div>
              {m.role === 'assistant' && m.artifact_slug_updated && (
                <div className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 px-1 mt-1">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Updated <strong className="font-semibold">{m.artifact_slug_updated}</strong>
                </div>
              )}
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex gap-2 items-end">
            <BotIcon size={24} />
            <div className="bg-secondary/70 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: '120ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: '240ms' }} />
              <button
                onClick={stop}
                className="ml-2 text-xs px-2 py-0.5 rounded border border-border bg-background hover:bg-secondary transition-colors"
              >
                Stop
              </button>
            </div>
          </div>
        )}

        {!sending && lastFailedPrompt && (
          <div className="flex gap-2 items-start">
            <BotIcon size={24} />
            <div className="flex-1 max-w-[88%] rounded-2xl rounded-bl-sm px-3 py-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm">
              <p className="text-red-700 dark:text-red-300 mb-2">The AI didn't respond. Retry?</p>
              <div className="flex gap-2">
                <button
                  onClick={retry}
                  className="text-xs px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-medium transition-colors"
                >
                  ↺ Retry
                </button>
                <button
                  onClick={() => setLastFailedPrompt(null)}
                  className="text-xs px-3 py-1 rounded border border-border hover:bg-secondary transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-3 pb-3 pt-2 border-t border-border flex-shrink-0">
        <div className="flex gap-2 items-end bg-secondary/40 border border-border rounded-2xl px-3 py-2 focus-within:border-primary/50 focus-within:bg-background transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything or request a change…"
            disabled={sending}
            rows={1}
            className="flex-1 text-sm bg-transparent resize-none focus:outline-none disabled:opacity-50 placeholder:text-muted-foreground/50 max-h-24"
            style={{ lineHeight: '1.5' }}
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || sending}
            className="w-7 h-7 rounded-full bg-primary flex items-center justify-center disabled:opacity-30 hover:opacity-90 transition-opacity flex-shrink-0"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1.5 px-1">Enter · Shift+Enter new line · shared with all members</p>
      </div>
    </div>
  )
}
