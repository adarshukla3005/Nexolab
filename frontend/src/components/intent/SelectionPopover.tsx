import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.js'
import { toast } from 'sonner'

interface SelectionPopoverProps {
  featureId: string
  artifactSlug: string
  artifactId: string
  /** Selected text (already trimmed by parent). */
  selection: string
  /** Anchor position in viewport coordinates from the selection's bounding rect. */
  anchor: { top: number; left: number }
  /** Close the popover (called on Escape, outside click, or after a successful action). */
  onClose: () => void
  /** Open the side chat and pre-fill it with the selection quoted + a draft prompt. */
  onMoveToChat: (draft: string) => void
  /** Called after AI edit succeeds so parent can refresh the artifact editor content. */
  onEdited?: () => void
}

/**
 * Floating popover anchored to a text selection inside an artifact.
 * Three actions: Ask AI (inline targeted edit), Move to chat, Comment (new discussion thread).
 */
export function SelectionPopover({
  featureId,
  artifactSlug,
  artifactId,
  selection,
  anchor,
  onClose,
  onMoveToChat,
  onEdited,
}: SelectionPopoverProps) {
  type Mode = 'menu' | 'ai' | 'comment'
  const [mode, setMode] = useState<Mode>('menu')
  const [prompt, setPrompt] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Close on outside click / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // Delay attaching mousedown so the click that opened us doesn't close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  useEffect(() => {
    if (mode === 'ai' || mode === 'comment') setTimeout(() => inputRef.current?.focus(), 20)
  }, [mode])

  const submitAskAi = async () => {
    const p = prompt.trim()
    if (!p || busy) return
    setBusy(true)
    try {
      await api.post(`/api/features/${featureId}/chat`, {
        message: p,
        targetSlug: artifactSlug,
        selectionContext: { slug: artifactSlug, selection },
      })
      // Chat reply + artifact update arrive via SSE (see ArtifactChat); the editor also
      // re-reads content_md when it changes. Signal parent so it can refresh proactively.
      onEdited?.()
      toast.success('AI edit requested')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const submitComment = async () => {
    const c = comment.trim()
    if (!c || busy) return
    setBusy(true)
    try {
      // Create a discussion thread titled with the first line of the selection, quoting it in the message.
      const title = selection.split('\n')[0].slice(0, 80)
      const thread = await api.post<{ id: string }>(`/api/features/${featureId}/discussions`, {
        title: `Re: ${title}`,
        artifact_id: artifactId,
      })
      const body = `> ${selection.split('\n').join('\n> ')}\n\n${c}`
      await api.post(`/api/discussions/${thread.id}/messages`, { body })
      toast.success('Comment posted')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const handleMoveToChat = () => {
    // Pre-fill the chat with a quoted-block + empty ask.
    const quoted = selection.split('\n').map((l) => `> ${l}`).join('\n')
    onMoveToChat(`${quoted}\n\n`)
    onClose()
  }

  // Constrain popover to viewport so it never renders off-screen.
  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.max(8, Math.min(window.innerHeight - 200, anchor.top)),
    left: Math.max(8, Math.min(window.innerWidth - 340, anchor.left)),
    zIndex: 60,
  }

  return (
    <div
      ref={rootRef}
      style={style}
      className="w-[320px] rounded-lg border border-border bg-background shadow-lg p-2"
    >
      {mode === 'menu' && (
        <div className="flex flex-col">
          <p className="text-[11px] text-muted-foreground px-2 pt-1 pb-1.5 line-clamp-2 italic">
            “{selection.length > 120 ? selection.slice(0, 120) + '…' : selection}”
          </p>
          <button
            onClick={() => setMode('ai')}
            className="flex items-center gap-2 text-left text-sm px-2 py-1.5 rounded hover:bg-secondary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L14.5 8.5L21 11L14.5 13.5L12 20L9.5 13.5L3 11L9.5 8.5L12 2z" />
            </svg>
            <span>Ask AI to edit</span>
          </button>
          <button
            onClick={handleMoveToChat}
            className="flex items-center gap-2 text-left text-sm px-2 py-1.5 rounded hover:bg-secondary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
            <span>Move to AI chat</span>
          </button>
          <button
            onClick={() => setMode('comment')}
            className="flex items-center gap-2 text-left text-sm px-2 py-1.5 rounded hover:bg-secondary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
            </svg>
            <span>Comment (new thread)</span>
          </button>
        </div>
      )}

      {mode === 'ai' && (
        <div className="p-1">
          <p className="text-[11px] text-muted-foreground italic mb-1 line-clamp-2">“{selection.length > 100 ? selection.slice(0, 100) + '…' : selection}”</p>
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitAskAi() }
              if (e.key === 'Escape') onClose()
            }}
            placeholder="How should the AI change this?"
            rows={3}
            className="w-full text-sm px-2 py-1.5 border border-input rounded resize-none focus:outline-none focus:border-primary/60"
            disabled={busy}
          />
          <div className="flex justify-end gap-1 mt-1">
            <button
              onClick={() => setMode('menu')}
              disabled={busy}
              className="text-xs px-2 py-1 rounded hover:bg-secondary text-muted-foreground"
            >
              Back
            </button>
            <button
              onClick={submitAskAi}
              disabled={busy || !prompt.trim()}
              className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 font-medium"
            >
              {busy ? 'Sending…' : 'Ask AI'}
            </button>
          </div>
        </div>
      )}

      {mode === 'comment' && (
        <div className="p-1">
          <p className="text-[11px] text-muted-foreground italic mb-1 line-clamp-2">“{selection.length > 100 ? selection.slice(0, 100) + '…' : selection}”</p>
          <textarea
            ref={inputRef}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment() }
              if (e.key === 'Escape') onClose()
            }}
            placeholder="Your comment (starts a new discussion thread)…"
            rows={3}
            className="w-full text-sm px-2 py-1.5 border border-input rounded resize-none focus:outline-none focus:border-primary/60"
            disabled={busy}
          />
          <div className="flex justify-end gap-1 mt-1">
            <button
              onClick={() => setMode('menu')}
              disabled={busy}
              className="text-xs px-2 py-1 rounded hover:bg-secondary text-muted-foreground"
            >
              Back
            </button>
            <button
              onClick={submitComment}
              disabled={busy || !comment.trim()}
              className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 font-medium"
            >
              {busy ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
