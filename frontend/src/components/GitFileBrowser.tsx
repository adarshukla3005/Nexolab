import { useState, useEffect, useRef, useMemo } from 'react'
import { api } from '../lib/api.js'

interface TreeEntry {
  path: string
  kind: 'file' | 'dir'
}

interface GitFileBrowserProps {
  featureId: string
  onOpenFile?: (path: string, content: string) => void
}

function FileTree({ entries, selected, onSelect, filter }: {
  entries: TreeEntry[]
  selected: string | null
  onSelect: (path: string) => void
  filter: string
}) {
  const filtered = filter
    ? entries.filter((e) => e.path.toLowerCase().includes(filter.toLowerCase()))
    : entries

  // Collect all directory paths so we can start all collapsed
  const allDirs = useMemo(() => {
    const dirs = new Set<string>()
    for (const e of entries) {
      const parts = e.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'))
      }
    }
    return dirs
  }, [entries])

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(allDirs))

  // When entries change (new repo loaded), reset collapsed to all dirs
  useEffect(() => {
    setCollapsed(new Set(allDirs))
  }, [allDirs])

  const toggleDir = (dir: string) => setCollapsed((p) => { const n = new Set(p); n.has(dir) ? n.delete(dir) : n.add(dir); return n })

  const renderItems = (prefix = '', depth = 0): JSX.Element[] => {
    const items: JSX.Element[] = []
    const seen = new Set<string>()

    for (const e of filtered) {
      if (prefix && !e.path.startsWith(prefix + '/')) continue
      const rel = prefix ? e.path.slice(prefix.length + 1) : e.path
      const relParts = rel.split('/')

      if (relParts.length === 0) continue
      const name = relParts[0]
      const fullPath = prefix ? `${prefix}/${name}` : name

      if (seen.has(fullPath)) continue
      seen.add(fullPath)

      if (relParts.length > 1) {
        const isCollapsed = collapsed.has(fullPath)
        items.push(
          <div key={fullPath}>
            <button
              onClick={() => toggleDir(fullPath)}
              style={{ paddingLeft: depth * 12 + 8 }}
              className="w-full text-left flex items-center gap-1 py-0.5 text-sm hover:bg-accent text-muted-foreground"
            >
              <span className="text-[10px]">{isCollapsed ? '▶' : '▼'}</span>
              <span>📁 {name}</span>
            </button>
            {!isCollapsed && renderItems(fullPath, depth + 1)}
          </div>
        )
      } else {
        items.push(
          <button
            key={fullPath}
            onClick={() => onSelect(fullPath)}
            style={{ paddingLeft: depth * 12 + 20 }}
            className={`w-full text-left py-0.5 text-sm truncate hover:bg-accent ${
              selected === fullPath ? 'bg-primary/10 text-primary' : ''
            }`}
          >
            📄 {name}
          </button>
        )
      }
    }
    return items
  }

  return <div className="font-mono">{renderItems()}</div>
}

export function GitFileBrowser({ featureId, onOpenFile }: GitFileBrowserProps) {
  const [tree, setTree] = useState<TreeEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState<Record<string, string>>({})
  const [editedContent, setEditedContent] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [cloneStatus, setCloneStatus] = useState<'idle' | 'cloning' | 'ready' | 'no-repo'>('idle')
  const [filter, setFilter] = useState('')
  const [editMode, setEditMode] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadTree = () => {
    api.get<TreeEntry[]>(`/api/features/${featureId}/tree`)
      .then((t) => { setTree(t); setCloneStatus('ready') })
      .catch(() => {
        // Worktree not ready — trigger clone and start polling
        api.post<{ ok: boolean; skipped?: boolean; reason?: string; cloning?: boolean }>(
          `/api/features/${featureId}/ensure-worktree`, {}
        ).then((r) => {
          if (r.reason === 'no repo configured') { setCloneStatus('no-repo'); return }
          setCloneStatus('cloning')
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = setInterval(() => {
            api.get<{ ready: boolean }>(`/api/features/${featureId}/clone-status`)
              .then((s) => {
                if (s.ready) {
                  if (pollRef.current) clearInterval(pollRef.current)
                  loadTree()
                }
              })
              .catch(() => {})
          }, 3000)
        }).catch(() => setCloneStatus('no-repo'))
      })
  }

  useEffect(() => {
    setCloneStatus('idle')
    setTree([])
    loadTree()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId])

  const handleSelect = async (path: string) => {
    setSelected(path)
    setEditMode(false)

    let content = editedContent[path] ?? originalContent[path]
    if (content === undefined) {
      setLoading(true)
      try {
        const r = await api.get<{ content: string; language: string }>(
          `/api/features/${featureId}/file?path=${encodeURIComponent(path)}`
        )
        content = r.content
        setOriginalContent((prev) => ({ ...prev, [path]: content }))
      } catch {
        content = '(error loading file)'
        setOriginalContent((prev) => ({ ...prev, [path]: content }))
      } finally {
        setLoading(false)
      }
    }

    // If parent provided a callback, open as a tab in the center panel
    if (onOpenFile) {
      onOpenFile(path, content)
    }
  }

  const currentContent = selected
    ? (editedContent[selected] ?? originalContent[selected] ?? null)
    : null
  const isModified = selected && editedContent[selected] !== undefined && editedContent[selected] !== originalContent[selected]

  // When onOpenFile is provided, the file content is shown as a center tab — no inline pane needed
  const showInlinePain = !onOpenFile

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-2 border-b border-border">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files…"
          className="w-full text-xs px-2 py-1 border border-input rounded bg-background"
        />
      </div>
      <div className={`${showInlinePain ? 'flex flex-1 overflow-hidden' : 'flex-1 overflow-auto'}`}>
        <div className={showInlinePain ? 'w-48 border-r border-border overflow-auto flex-shrink-0' : 'w-full'}>
          {cloneStatus === 'no-repo' ? (
            <div className="p-3 text-sm text-muted-foreground">
              <p className="font-medium mb-1">No repo connected</p>
              <p className="opacity-70 text-xs">Add a GitHub/GitLab URL when creating a feature to browse its files.</p>
            </div>
          ) : cloneStatus === 'cloning' ? (
            <div className="p-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <p className="font-medium">Cloning repo…</p>
              </div>
              <p className="opacity-70 text-xs">This may take a minute for large repos. Files will appear automatically.</p>
            </div>
          ) : tree.length === 0 && cloneStatus !== 'ready' ? (
            <div className="p-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 border-2 border-muted-foreground/40 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <p>Loading…</p>
              </div>
            </div>
          ) : tree.length === 0 ? (
            <p className="text-sm text-muted-foreground p-3">No files found</p>
          ) : (
            <FileTree entries={tree} selected={selected} onSelect={handleSelect} filter={filter} />
          )}
        </div>
        {showInlinePain && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {selected && (
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-secondary/30 flex-shrink-0">
                <span className="text-xs font-mono truncate flex-1 text-muted-foreground">{selected}</span>
                {isModified && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium flex-shrink-0">Modified</span>
                )}
                <button
                  onClick={() => setEditMode((e) => !e)}
                  className={`text-xs px-2 py-0.5 rounded flex-shrink-0 transition-colors ${
                    editMode ? 'bg-primary text-primary-foreground' : 'bg-secondary hover:bg-accent text-muted-foreground'
                  }`}
                >
                  {editMode ? 'View' : 'Edit'}
                </button>
              </div>
            )}
            <div className="flex-1 overflow-auto p-3">
              {loading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : currentContent != null ? (
                editMode && selected ? (
                  <textarea
                    className="w-full h-full text-xs font-mono resize-none bg-background text-foreground outline-none"
                    value={currentContent}
                    onChange={(e) => setEditedContent((prev) => ({ ...prev, [selected]: e.target.value }))}
                    spellCheck={false}
                  />
                ) : (
                  <pre className="text-xs font-mono whitespace-pre-wrap text-foreground">
                    {currentContent}
                  </pre>
                )
              ) : (
                <p className="text-xs text-muted-foreground">Select a file to view</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
