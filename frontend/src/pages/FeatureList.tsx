import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useSession } from '../hooks/useSession.js'
import { UserMenu } from '../components/UserMenu.js'
import { toast } from 'sonner'

interface Feature {
  id: string
  slug: string
  title: string
  status: string
  current_stage_id: string | null
  created_at: string
  creator_id: string
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-blue-100 text-blue-800',
  committed: 'bg-green-100 text-green-800',
  archived: 'bg-gray-100 text-gray-600',
}

function parseShareLink(raw: string): string | null {
  try {
    // Accept full URLs or just the path portion
    const url = raw.startsWith('http') ? new URL(raw) : new URL(raw, window.location.origin)
    const m = url.pathname.match(/\/features\/([0-9a-f-]{36})/)
    if (!m) return null
    const join = url.searchParams.get('join') ?? '1'
    return `/features/${m[1]}?join=${join}`
  } catch {
    return null
  }
}

export function FeatureList() {
  const [features, setFeatures] = useState<Feature[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [showJoin, setShowJoin] = useState(false)
  const [joinLink, setJoinLink] = useState('')
  const { user } = useSession()
  const navigate = useNavigate()

  useEffect(() => {
    api.get<Feature[]>('/api/features')
      .then(setFeatures)
      .catch((e) => toast.error(String(e)))
      .finally(() => setLoading(false))

    const es = new EventSource('/api/notify/features')
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (data.id) {
          setFeatures((prev) => {
            const idx = prev.findIndex((f) => f.id === data.id)
            if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], ...data }; return next }
            return [data, ...prev]
          })
        }
      } catch { /* ignore */ }
    }
    return () => es.close()
  }, [])

  const handleJoin = () => {
    const path = parseShareLink(joinLink.trim())
    if (!path) { toast.error('Invalid share link — paste the full workspace URL'); return }
    navigate(path)
  }

  const handleDelete = async (e: React.MouseEvent, feature: Feature) => {
    e.preventDefault()
    e.stopPropagation()
    const isCreator = feature.creator_id === user?.id
    const msg = isCreator
      ? 'Delete this feature for everyone? This cannot be undone.'
      : 'Leave this workspace? You can rejoin via the share link.'
    if (!window.confirm(msg)) return
    setDeletingId(feature.id)
    try {
      await api.delete(`/api/features/${feature.id}`)
      setFeatures((prev) => prev.filter((f) => f.id !== feature.id))
      toast.success(isCreator ? 'Feature deleted' : 'Left workspace')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Join workspace modal */}
      {showJoin && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setShowJoin(false)}>
          <div
            className="border border-border rounded-lg w-full max-w-md shadow-xl p-5 space-y-4"
            style={{ background: 'hsl(var(--card))', color: 'hsl(var(--card-foreground))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h2 className="text-sm font-semibold">Join a workspace</h2>
              <p className="text-sm text-muted-foreground mt-1">Paste the share link from a teammate's workspace.</p>
            </div>
            <input
              autoFocus
              type="text"
              value={joinLink}
              onChange={(e) => setJoinLink(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              placeholder="https://…/features/abc-123?join=1"
              className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowJoin(false); setJoinLink('') }}
                className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleJoin}
                disabled={!joinLink.trim()}
                className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 disabled:opacity-50"
              >
                Join
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {/* Logo mark */}
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="8" fill="hsl(var(--primary))"/>
            {/* Two overlapping chat-bubble nodes representing collaboration */}
            <circle cx="11" cy="13" r="5" fill="white" fillOpacity="0.9"/>
            <circle cx="21" cy="13" r="5" fill="white" fillOpacity="0.55"/>
            <circle cx="16" cy="21" r="4" fill="white" fillOpacity="0.75"/>
            {/* Center connector dot */}
            <circle cx="16" cy="15" r="1.5" fill="hsl(var(--primary))"/>
          </svg>
          <h1 className="text-base font-bold tracking-tight">Nexolab</h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowJoin(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-md text-sm hover:bg-secondary transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
            </svg>
            Join workspace
          </button>
          <Link
            to="/features/new"
            className="px-4 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90"
          >
            + New feature
          </Link>
          {user && <UserMenu user={user} />}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <h2 className="text-xl font-bold mb-6">Features</h2>
        {loading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : features.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-lg mb-2">No features yet</p>
            <p className="text-sm">Create your first feature to start planning with OpenSpec.</p>
            <Link to="/features/new" className="mt-4 inline-block px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
              Create first feature
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {features.map((f) => (
              <div key={f.id} className="relative group">
                <Link
                  to={`/features/${f.id}`}
                  className="block p-4 border border-border rounded-lg hover:border-ring transition-colors"
                >
                  <div className="flex items-center justify-between pr-8">
                    <div>
                      <p className="font-medium">{f.title}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Stage: {f.current_stage_id ?? 'starting…'}
                      </p>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLORS[f.status] ?? 'bg-gray-100'}`}>
                      {f.status}
                    </span>
                  </div>
                </Link>
                <button
                  onClick={(e) => handleDelete(e, f)}
                  disabled={deletingId === f.id}
                  className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded text-muted-foreground hover:text-red-600 hover:bg-red-50 disabled:opacity-30"
                  title={f.creator_id === user?.id ? 'Delete feature' : 'Leave workspace'}
                >
                  {deletingId === f.id
                    ? <span className="text-xs">…</span>
                    : f.creator_id === user?.id
                      ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                      : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                  }
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
