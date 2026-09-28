import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api } from '../../lib/api.js'
import { toast } from 'sonner'
import { SelectionPopover } from './SelectionPopover.js'

interface ArtifactEditorProps {
  featureId: string
  artifactId: string
  slug: string
  title: string
  initialContent: string
  /** Optional: open the AI chat pre-filled with a draft. Enables the "Move to chat" popover action. */
  onOpenChatWithDraft?: (draft: string) => void
}

interface ArtifactVersionRow {
  version: number
  title: string | null
  edit_source: string
  created_at: string
  editor_id: string | null
  editor_name: string | null
  content_preview: string
  content_len: number
}

const AUTOSAVE_DELAY_MS = 1500

export function ArtifactEditor({ featureId, artifactId, slug, title, initialContent, onOpenChatWithDraft }: ArtifactEditorProps) {
  const [content, setContent] = useState(initialContent)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [lastSavedContent, setLastSavedContent] = useState(initialContent)
  const [lastSaveError, setLastSaveError] = useState<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest content ref so the debounced flush + unmount cleanup send the freshest value,
  // not whatever content was in state when the timer was scheduled.
  const contentRef = useRef(initialContent)
  const saveInFlight = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Selection popover state — anchored to a highlighted text range inside the editor.
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(null)

  // Version history dropdown state.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [versions, setVersions] = useState<ArtifactVersionRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // View mode: 'edit' shows raw markdown in a textarea; 'preview' renders it read-only.
  // Persisted per-artifact so switching tabs remembers your choice.
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>(() => {
    try {
      return (window.localStorage.getItem(`artifact.viewMode.${artifactId}`) as 'edit' | 'preview') ?? 'edit'
    } catch { return 'edit' }
  })
  useEffect(() => {
    try { window.localStorage.setItem(`artifact.viewMode.${artifactId}`, viewMode) } catch { /* ignore */ }
  }, [artifactId, viewMode])

  // Reset editor when a different artifact is loaded, but only when the id truly changes.
  useEffect(() => {
    setContent(initialContent)
    setLastSavedContent(initialContent)
    contentRef.current = initialContent
    setDirty(false)
    setLastSaveError(null)
  }, [artifactId])

  // If a live update arrives via SSE (e.g. another user edited it), the parent will pass
  // a new initialContent — reflect it here IF the local view is not dirty (avoid clobber).
  useEffect(() => {
    if (!dirty) {
      setContent(initialContent)
      setLastSavedContent(initialContent)
      contentRef.current = initialContent
    }
  }, [initialContent, dirty])

  const doSave = useCallback(async (val: string, opts: { silent?: boolean } = {}): Promise<boolean> => {
    if (saveInFlight.current) return false
    saveInFlight.current = true
    setSaving(true)
    setLastSaveError(null)
    try {
      await api.post(`/api/features/${featureId}/artifacts/${artifactId}`, { content_md: val })
      setLastSavedContent(val)
      setDirty(false)
      if (!opts.silent) toast.success('Saved')
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setLastSaveError(msg)
      // Surface autosave failures too — silent failures are what caused the original bug.
      toast.error(`Save failed: ${msg}`)
      return false
    } finally {
      setSaving(false)
      saveInFlight.current = false
    }
  }, [featureId, artifactId])

  const scheduleAutoSave = useCallback((val: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      // Only fire if content still differs from last saved (user may have reverted mid-debounce).
      if (contentRef.current !== lastSavedContent) doSave(contentRef.current, { silent: true })
    }, AUTOSAVE_DELAY_MS)
  }, [doSave, lastSavedContent])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setContent(val)
    contentRef.current = val
    if (val !== lastSavedContent) setDirty(true)
    scheduleAutoSave(val)
  }

  const handleSaveClick = useCallback(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    if (contentRef.current === lastSavedContent && !lastSaveError) return
    doSave(contentRef.current)
  }, [doSave, lastSavedContent, lastSaveError])

  // Cmd/Ctrl+S saves — works from anywhere inside the textarea.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      handleSaveClick()
    }
  }

  // Selection detection: after the user finishes selecting text in the textarea, show the popover
  // anchored just above the selection's midpoint.
  const handleSelect = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    const s = ta.value.substring(ta.selectionStart, ta.selectionEnd).trim()
    if (s.length < 2) { setSelection(null); return }
    // Anchor: use the textarea's bounding rect + caret-based approximation. Textarea doesn't
    // expose per-char coordinates, so place the popover above the top of the textarea and to
    // the right of the caret line — close enough and never off-screen.
    const rect = ta.getBoundingClientRect()
    setSelection({
      text: s,
      top: Math.max(8, rect.top - 8),
      left: Math.min(window.innerWidth - 340, rect.left + 40),
    })
  }, [])

  // ── Version history ─────────────────────────────────────────────────────
  const loadVersions = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const r = await api.get<{ versions: ArtifactVersionRow[] }>(
        `/api/features/${featureId}/artifacts/${artifactId}/versions`,
      )
      setVersions(r.versions)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setHistoryLoading(false)
    }
  }, [featureId, artifactId])

  const restoreVersion = useCallback(async (v: number) => {
    if (!window.confirm(`Restore this artifact to version ${v}? The current content is saved to history first, so this is reversible.`)) return
    try {
      await api.post(`/api/features/${featureId}/artifacts/${artifactId}/restore/${v}`)
      toast.success(`Restored to version ${v}`)
      // Reload the artifact content by refetching — the SSE broadcast will also fire.
      const art = await api.get<{ content_md: string; version: number }>(
        `/api/features/${featureId}/artifacts/${artifactId}`,
      )
      setContent(art.content_md)
      setLastSavedContent(art.content_md)
      contentRef.current = art.content_md
      setDirty(false)
      setHistoryOpen(false)
      loadVersions()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }, [featureId, artifactId, loadVersions])

  const toggleHistory = useCallback(() => {
    if (!historyOpen) loadVersions()
    setHistoryOpen((o) => !o)
  }, [historyOpen, loadVersions])

  // Close history dropdown on outside click.
  useEffect(() => {
    if (!historyOpen) return
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      if (!el.closest('[data-history-root]')) setHistoryOpen(false)
    }
    setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => document.removeEventListener('mousedown', onDown)
  }, [historyOpen])

  // FLUSH on unmount: if the tab is being closed with pending edits, fire the save synchronously
  // (best-effort) using sendBeacon so content isn't lost. This is the fix for the original bug.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      const pending = contentRef.current
      if (pending !== lastSavedContent && !saveInFlight.current) {
        // sendBeacon is fire-and-forget, survives page unload, and doesn't block.
        // Falls back to fetch keepalive when Beacon isn't available.
        try {
          const blob = new Blob([JSON.stringify({ content_md: pending })], { type: 'application/json' })
          const url = `/api/features/${featureId}/artifacts/${artifactId}`
          const ok = navigator.sendBeacon?.(url, blob)
          if (!ok) {
            fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              keepalive: true,
              body: JSON.stringify({ content_md: pending }),
            }).catch(() => {})
          }
        } catch { /* ignore */ }
      }
    }
    // Intentionally not depending on lastSavedContent — we always want the freshest ref value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId, artifactId])

  // Warn on browser tab close if there are unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const statusLabel = saving
    ? 'Saving…'
    : lastSaveError
      ? 'Save failed'
      : dirty
        ? 'Unsaved changes'
        : 'Saved'
  const statusColor = lastSaveError
    ? 'text-red-600 dark:text-red-400'
    : dirty
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-muted-foreground'

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
        <div className="min-w-0">
          <h3 className="font-medium text-sm truncate">{title}</h3>
          <p className="text-xs text-muted-foreground truncate">{slug}</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className={`text-xs flex items-center gap-1 ${statusColor}`}>
            {saving && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="animate-spin">
                <path d="M21 12a9 9 0 11-6.219-8.56" />
              </svg>
            )}
            {!saving && dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />}
            {!saving && !dirty && !lastSaveError && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {statusLabel}
          </span>
          {/* Edit / Preview segmented toggle. Preview is read-only rendered markdown;
              switching back to Edit lets you type again. */}
          <div className="flex items-center rounded-md border border-border overflow-hidden text-xs">
            <button
              onClick={() => setViewMode('edit')}
              className={`px-2 py-1 transition-colors ${
                viewMode === 'edit' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'
              }`}
              title="Edit markdown source"
            >
              Edit
            </button>
            <button
              onClick={() => setViewMode('preview')}
              className={`px-2 py-1 transition-colors ${
                viewMode === 'preview' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'
              }`}
              title="Preview rendered markdown (read-only)"
            >
              Preview
            </button>
          </div>
          {/* History dropdown */}
          <div className="relative" data-history-root>
            <button
              onClick={toggleHistory}
              title="Version history"
              className="text-xs px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex items-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v5h5" />
                <path d="M3.05 13A9 9 0 106 5.3L3 8" />
                <path d="M12 7v5l4 2" />
              </svg>
              History
            </button>
            {historyOpen && (
              <div className="absolute right-0 top-full mt-1 w-[340px] max-h-[420px] overflow-auto rounded-lg border border-border bg-background shadow-lg z-50">
                <div className="px-3 py-2 border-b border-border sticky top-0 bg-background">
                  <p className="text-xs font-semibold">Version history</p>
                  <p className="text-[10px] text-muted-foreground">Click restore to bring back an old version. Current content is snapshotted first.</p>
                </div>
                {historyLoading ? (
                  <p className="text-xs text-muted-foreground text-center py-6">Loading…</p>
                ) : versions.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-6">No previous versions yet</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {versions.map((v) => (
                      <li key={v.version} className="p-2 hover:bg-secondary/40">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold">v{v.version}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                              v.edit_source === 'ai-chat' || v.edit_source === 'ai-inline'
                                ? 'bg-primary/10 text-primary'
                                : v.edit_source === 'restore'
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                                  : 'bg-secondary text-muted-foreground'
                            }`}>
                              {v.edit_source}
                            </span>
                            {v.editor_name && (
                              <span className="text-[10px] text-muted-foreground">· {v.editor_name}</span>
                            )}
                          </div>
                          <button
                            onClick={() => restoreVersion(v.version)}
                            className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-secondary"
                          >
                            Restore
                          </button>
                        </div>
                        <p className="text-[10px] text-muted-foreground line-clamp-2 font-mono">{v.content_preview}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {new Date(v.created_at).toLocaleString()} · {v.content_len} chars
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <button
            onClick={handleSaveClick}
            disabled={saving || (!dirty && !lastSaveError)}
            className={`text-xs px-3 py-1 rounded font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              dirty || lastSaveError
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : 'bg-secondary text-muted-foreground'
            }`}
            title="Save (⌘/Ctrl + S)"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {viewMode === 'edit' ? (
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onMouseUp={handleSelect}
          onKeyUp={handleSelect}
          className="flex-1 p-4 font-mono text-sm resize-none focus:outline-none bg-background text-foreground"
          placeholder="Artifact content (Markdown)…"
          spellCheck={false}
        />
      ) : (
        <div className="flex-1 overflow-auto p-6 bg-background">
          <div className="max-w-3xl mx-auto text-foreground">
            <ReactMarkdown
              components={{
                h1: ({ children }) => <h1 className="text-2xl font-bold mt-6 mb-3 first:mt-0 pb-2 border-b border-border">{children}</h1>,
                h2: ({ children }) => <h2 className="text-xl font-semibold mt-5 mb-2">{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-semibold mt-4 mb-2">{children}</h3>,
                h4: ({ children }) => <h4 className="text-sm font-semibold mt-3 mb-1.5 uppercase tracking-wide text-muted-foreground">{children}</h4>,
                p: ({ children }) => <p className="text-sm leading-relaxed mb-3">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                em: ({ children }) => <em className="italic">{children}</em>,
                ul: ({ children }) => <ul className="list-disc pl-6 mb-3 space-y-1 text-sm">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-6 mb-3 space-y-1 text-sm">{children}</ol>,
                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                code: ({ children, className }) => className
                  ? <pre className="bg-secondary/50 border border-border rounded-md px-3 py-2 text-xs font-mono overflow-x-auto my-3 whitespace-pre-wrap"><code>{children}</code></pre>
                  : <code className="bg-secondary/60 border border-border rounded px-1.5 py-0.5 text-[0.85em] font-mono">{children}</code>,
                a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 hover:opacity-80">{children}</a>,
                blockquote: ({ children }) => <blockquote className="border-l-4 border-primary/40 pl-4 py-1 my-3 italic text-muted-foreground">{children}</blockquote>,
                hr: () => <hr className="my-6 border-border" />,
                table: ({ children }) => <div className="overflow-x-auto my-4"><table className="min-w-full text-sm border border-border">{children}</table></div>,
                thead: ({ children }) => <thead className="bg-secondary/50">{children}</thead>,
                th: ({ children }) => <th className="px-3 py-2 text-left font-semibold border-b border-border">{children}</th>,
                td: ({ children }) => <td className="px-3 py-2 border-b border-border">{children}</td>,
              }}
            >
              {content || '_(empty artifact — switch to Edit to add content)_'}
            </ReactMarkdown>
          </div>
        </div>
      )}
      {viewMode === 'edit' && selection && (
        <SelectionPopover
          featureId={featureId}
          artifactSlug={slug}
          artifactId={artifactId}
          selection={selection.text}
          anchor={{ top: selection.top, left: selection.left }}
          onClose={() => setSelection(null)}
          onMoveToChat={(draft) => {
            onOpenChatWithDraft?.(draft)
            setSelection(null)
          }}
        />
      )}
    </div>
  )
}
