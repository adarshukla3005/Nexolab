import { useState, useEffect, useRef } from 'react'
import { api } from '../../lib/api.js'
import { toast } from 'sonner'

interface Thread {
  id: string
  artifact_id: string | null
  title: string | null
  resolved: boolean
  created_at: string
  created_by: string
}

interface Message {
  id: string
  author_id: string
  author_name: string
  author_email: string
  body: string
  redacted: boolean
  created_at: string
}

interface Member {
  id: string
  name: string
  email: string
  role: string
  joined_at: string
}

type PanelView = 'threads' | 'members'

export function DiscussionPanel({
  featureId,
  artifactId,
  currentUserId,
  featureCreatorId,
}: {
  featureId: string
  artifactId?: string
  currentUserId?: string | null
  featureCreatorId?: string | null
}) {
  const [view, setView] = useState<PanelView>('threads')
  const [threads, setThreads] = useState<Thread[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [activeThread, setActiveThread] = useState<string | null>(null)
  // When true, the user is intentionally on the thread list and we must not auto-open
  // a thread on the next poll. Cleared when the user picks a thread themselves.
  const userClosedThread = useRef(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [newThreadTitle, setNewThreadTitle] = useState('')
  const [showNewThread, setShowNewThread] = useState(false)
  // Inline edit state for renaming a thread from either list or active view.
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  // Fetch ALL threads for this feature — never filter by artifactId here
  // (filtering would make threads disappear when the active artifact tab changes)
  useEffect(() => {
    const url = `/api/features/${featureId}/discussions`
    api.get<Thread[]>(url).then((ts) => {
      setThreads(ts)
      // Auto-open the latest thread only on first load, and only if the user
      // hasn't explicitly closed a thread since.
      if (ts.length > 0 && !userClosedThread.current) {
        setActiveThread((prev) => prev ?? ts[0].id)
      }
    }).catch(() => {})
    const interval = setInterval(() => {
      api.get<Thread[]>(url).then((ts) => {
        setThreads(ts)
        // Poll auto-open is intentionally disabled — the user's "Back to list" click
        // must stick. If a brand-new thread arrives while on the list, we still don't
        // steal focus; the user can click it themselves.
      }).catch(() => {})
    }, 3000)
    return () => clearInterval(interval)
  }, [featureId])

  useEffect(() => {
    if (view !== 'members') return
    api.get<Member[]>(`/api/features/${featureId}/members`).then(setMembers).catch(() => {})
  }, [featureId, view])

  useEffect(() => {
    if (!activeThread) return
    api.get<Message[]>(`/api/discussions/${activeThread}/messages`)
      .then(setMessages).catch(() => {})

    const interval = setInterval(() => {
      api.get<Message[]>(`/api/discussions/${activeThread}/messages`)
        .then((msgs) => setMessages((prev) => msgs.length !== prev.length ? msgs : prev))
        .catch(() => {})
    }, 2000)
    return () => clearInterval(interval)
  }, [activeThread])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async () => {
    if (!newMessage.trim() || !activeThread) return
    const body = newMessage.trim()
    setNewMessage('')
    try {
      await api.post(`/api/discussions/${activeThread}/messages`, { body })
      const msgs = await api.get<Message[]>(`/api/discussions/${activeThread}/messages`)
      setMessages(msgs)
    } catch (e) { toast.error(String(e)) }
  }

  const createThread = async () => {
    if (!newThreadTitle.trim()) return
    try {
      const r = await api.post<{ id: string }>(`/api/features/${featureId}/discussions`, {
        title: newThreadTitle,
        artifact_id: artifactId,
      })
      setThreads((p) => [{
        id: r.id, title: newThreadTitle, artifact_id: artifactId ?? null,
        resolved: false, created_at: new Date().toISOString(),
        created_by: currentUserId ?? '',
      }, ...p])
      userClosedThread.current = false
      setActiveThread(r.id)
      setNewThreadTitle('')
      setShowNewThread(false)
    } catch (e) { toast.error(String(e)) }
  }

  const canEditThread = (t: Thread) => currentUserId && t.created_by === currentUserId
  const canDeleteThread = (t: Thread) =>
    currentUserId && (t.created_by === currentUserId || featureCreatorId === currentUserId)

  const startEditThread = (t: Thread) => {
    setEditingThreadId(t.id)
    setEditingTitle(t.title ?? '')
  }
  const saveEditThread = async () => {
    if (!editingThreadId) return
    const title = editingTitle.trim()
    if (!title) return
    try {
      await api.patch(`/api/discussions/${editingThreadId}`, { title })
      setThreads((p) => p.map((t) => t.id === editingThreadId ? { ...t, title } : t))
      setEditingThreadId(null)
    } catch (e) { toast.error(String(e)) }
  }
  const deleteThread = async (t: Thread) => {
    if (!window.confirm(`Delete thread "${t.title ?? 'Untitled'}" and all its messages? This can't be undone.`)) return
    try {
      await api.delete(`/api/discussions/${t.id}`)
      setThreads((p) => p.filter((x) => x.id !== t.id))
      if (activeThread === t.id) setActiveThread(null)
    } catch (e) { toast.error(String(e)) }
  }

  const removeUser = async (userId: string) => {
    try {
      await api.delete(`/api/features/${featureId}/members/${userId}`)
      setMembers((p) => p.filter((m) => m.id !== userId))
      toast.success('Member removed')
    } catch (e) { toast.error(String(e)) }
  }

  const ROLE_COLORS: Record<string, string> = {
    owner: 'bg-violet-500',
    editor: 'bg-blue-500',
    viewer: 'bg-slate-400',
  }

  return (
    <div className="flex flex-col h-full border-l border-border">
      {/* Header with tabs */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setView('threads')}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${view === 'threads' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Discussion
          </button>
          <button
            onClick={() => setView('members')}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${view === 'members' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Members
          </button>
        </div>
        {view === 'threads' && (
          <button
            onClick={() => setShowNewThread(!showNewThread)}
            className="text-xs text-primary hover:underline flex-shrink-0"
          >
            + Thread
          </button>
        )}
      </div>

      {/* Members view */}
      {view === 'members' && (
        <div className="flex-1 overflow-auto p-3 space-y-2">
          {members.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">No members loaded</p>
          ) : members.map((m) => (
            <div key={m.id} className="flex items-center gap-2 p-2 rounded border border-border bg-secondary/20">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${ROLE_COLORS[m.role] ?? 'bg-slate-400'}`}
                title={`${m.name} (${m.role})`}
              >
                {(m.name || m.email || '?')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{m.name || m.email.split('@')[0]}</p>
                <p className="text-[10px] text-muted-foreground truncate">{m.email}</p>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full text-white font-medium ${ROLE_COLORS[m.role] ?? 'bg-slate-400'}`}>
                  {m.role}
                </span>
                {m.role !== 'owner' && (
                  <button
                    onClick={() => removeUser(m.id)}
                    className="text-[10px] text-muted-foreground hover:text-destructive transition-colors px-1"
                    title="Remove from workspace"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Threads view */}
      {view === 'threads' && (
        <>
          {showNewThread && (
            <div className="p-2 border-b border-border bg-accent flex-shrink-0">
              <input
                type="text"
                value={newThreadTitle}
                onChange={(e) => setNewThreadTitle(e.target.value)}
                placeholder="Thread title…"
                className="w-full text-xs px-2 py-1 border border-input rounded mb-1"
                onKeyDown={(e) => e.key === 'Enter' && createThread()}
              />
              <button onClick={createThread} className="text-xs px-2 py-1 bg-primary text-white rounded">Create</button>
            </div>
          )}

          {!activeThread ? (
            <div className="flex-1 overflow-auto p-2 space-y-1">
              {threads.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">No discussions yet</p>
              ) : threads.map((t) => {
                const isCurrentArtifact = t.artifact_id && t.artifact_id === artifactId
                const editing = editingThreadId === t.id
                if (editing) {
                  return (
                    <div key={t.id} className={`p-2 rounded bg-accent text-sm ${isCurrentArtifact ? 'border-l-2 border-primary pl-3' : ''}`}>
                      <input
                        type="text"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); saveEditThread() }
                          if (e.key === 'Escape') { setEditingThreadId(null) }
                        }}
                        autoFocus
                        className="w-full text-xs px-2 py-1 border border-input rounded mb-1"
                      />
                      <div className="flex gap-1">
                        <button onClick={saveEditThread} className="text-[10px] px-2 py-0.5 bg-primary text-primary-foreground rounded">Save</button>
                        <button onClick={() => setEditingThreadId(null)} className="text-[10px] px-2 py-0.5 border border-border rounded">Cancel</button>
                      </div>
                    </div>
                  )
                }
                return (
                  <div
                    key={t.id}
                    className={`group flex items-start gap-1 p-2 rounded hover:bg-accent text-sm transition-colors ${isCurrentArtifact ? 'border-l-2 border-primary pl-3' : ''}`}
                  >
                    <button
                      onClick={() => { userClosedThread.current = false; setActiveThread(t.id) }}
                      className="flex-1 text-left min-w-0"
                    >
                      <span className={t.resolved ? 'line-through text-muted-foreground' : ''}>{t.title ?? 'Untitled thread'}</span>
                      {t.artifact_id && !isCurrentArtifact && (
                        <span className="block text-[10px] text-muted-foreground mt-0.5 truncate">📎 other artifact</span>
                      )}
                    </button>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      {canEditThread(t) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); startEditThread(t) }}
                          className="p-1 text-muted-foreground hover:text-foreground rounded"
                          title="Edit title"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                      )}
                      {canDeleteThread(t) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteThread(t) }}
                          className="p-1 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 rounded"
                          title="Delete thread"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (() => {
            const active = threads.find((x) => x.id === activeThread)
            const editingActive = active && editingThreadId === active.id
            return (
            <div className="flex flex-col flex-1 overflow-hidden">
              <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 flex-shrink-0">
                <button
                  onClick={() => { userClosedThread.current = true; setActiveThread(null) }}
                  className="text-xs text-muted-foreground hover:text-foreground px-1"
                  title="Back to thread list"
                >
                  ←
                </button>
                {editingActive ? (
                  <>
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); saveEditThread() }
                        if (e.key === 'Escape') { setEditingThreadId(null) }
                      }}
                      autoFocus
                      className="flex-1 text-xs px-2 py-0.5 border border-input rounded"
                    />
                    <button onClick={saveEditThread} className="text-[10px] px-2 py-0.5 bg-primary text-primary-foreground rounded">Save</button>
                    <button onClick={() => setEditingThreadId(null)} className="text-[10px] px-2 py-0.5 border border-border rounded">Cancel</button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-xs font-semibold truncate">{active?.title ?? 'Untitled thread'}</span>
                    {active && canEditThread(active) && (
                      <button
                        onClick={() => startEditThread(active)}
                        className="p-1 text-muted-foreground hover:text-foreground rounded"
                        title="Edit title"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                    )}
                    {active && canDeleteThread(active) && (
                      <button
                        onClick={() => deleteThread(active)}
                        className="p-1 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 rounded"
                        title="Delete thread"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                        </svg>
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className="flex-1 overflow-auto p-3 space-y-3">
                {messages.map((m) => (
                  <div key={m.id} className="text-xs">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span
                        className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold flex-shrink-0 cursor-default"
                        title={m.author_name || m.author_email}
                      >
                        {(m.author_name || m.author_email || '?')[0].toUpperCase()}
                      </span>
                      <span className="font-semibold text-foreground">{m.author_name || m.author_email.split('@')[0]}</span>
                      <span className="text-muted-foreground text-[10px]">
                        {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className={`pl-6 leading-snug ${m.redacted ? 'text-muted-foreground italic' : 'text-foreground'}`}>
                      {m.redacted ? '[redacted]' : m.body}
                    </p>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
              <div className="p-2 border-t border-border flex gap-1 flex-shrink-0">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder="Write a message…"
                  className="flex-1 text-xs px-2 py-1.5 border border-input rounded"
                />
                <button
                  onClick={sendMessage}
                  disabled={!newMessage.trim()}
                  className="px-2 py-1.5 bg-primary text-white rounded text-xs disabled:opacity-50"
                >
                  ↑
                </button>
              </div>
            </div>
            )
          })()}
        </>
      )}
    </div>
  )
}
