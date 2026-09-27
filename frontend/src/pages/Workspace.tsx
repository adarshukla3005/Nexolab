import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useSession } from '../hooks/useSession.js'
import { useYjsDocument } from '../hooks/useYjsDocument.js'
import { UserMenu } from '../components/UserMenu.js'
import { GateCard } from '../components/intent/GateCard.js'
import { ArtifactEditor } from '../components/intent/ArtifactEditor.js'
import { QuestionForm } from '../components/intent/QuestionForm.js'
import { PhaseDiagram } from '../components/intent/PhaseDiagram.js'
import { GitFileBrowser } from '../components/GitFileBrowser.js'
import { PresenceBar } from '../components/PresenceBar.js'
import { DiscussionPanel } from '../components/discussion/DiscussionPanel.js'
import { ArtifactChat } from '../components/ArtifactChat.js'
import { StageLogPane } from '../components/StageLogPane.js'
import { toast } from 'sonner'

interface Feature {
  id: string
  slug: string
  title: string
  prompt: string
  status: string
  current_stage_id: string | null
  plan_branch: string | null
  base_branch: string
  quorum_size: number
  committed_sha: string | null
  repo_url: string | null
  created_at: string
  creator_id: string
}

interface MemberApproval {
  user_id: string
  name: string
  email: string
  verdict: string | null
  approved_at: string | null
}

interface Artifact {
  id: string
  slug: string
  artifact_type: string
  title: string
  updated_at: string
  stage_run_id: string | null
}

interface Gate {
  id: string
  kind: 'question' | 'validation'
  status: string
  step_id: string
  question_text: string
  question_schema: {
    text: string
    type: 'single' | 'multi'
    options: Array<{ label: string; description?: string }>
  } | null
  answer: unknown
  created_at: string
  approvals?: Array<{ user_id: string; name: string; verdict: string }>
  quorum?: number
  member_count?: number
}

interface ArtifactFull {
  id: string
  slug: string
  artifact_type: string
  title: string
  content_md: string
  version: number
}

interface FileTab {
  id: string // synthetic: 'file:' + path
  kind: 'file'
  path: string
  content: string
  editedContent?: string
}

interface LoadingTab {
  id: '__loading__'
  kind: 'loading'
  stageSlug: string
}

type CenterTab = (ArtifactFull & { kind?: undefined }) | FileTab | LoadingTab

type LeftTab = 'files' | 'phases' | 'artifacts'

export function Workspace() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const joinOnce = useRef(searchParams.get('join') === '1')
  const { user } = useSession()
  const [feature, setFeature] = useState<Feature | null>(null)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [gates, setGates] = useState<Gate[]>([])
  const [stageRuns, setStageRuns] = useState<Array<{ id: string; stage_slug: string; status: string }>>([])
  const [leftTab, setLeftTab] = useState<LeftTab>('phases')
  const [selectedStage, setSelectedStage] = useState<string | null>(null)
  const [stageArtifactView, setStageArtifactView] = useState<string | null>(null) // slug of stage whose artifacts are shown in center
  const [logsPanelHeight, setLogsPanelHeight] = useState(320) // px height of logs pane in left panel
  const logsDragRef = useRef<{ startY: number; startH: number } | null>(null)

  // Browser-style tabs: artifacts and file tabs unified
  const [openTabs, setOpenTabs] = useState<CenterTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)

  // Chat has three visibility states:
  //   'closed' — not visible
  //   'dock'   — horizontal panel below the artifact area
  //   'side'   — vertical panel to the right of the artifact area, before the discussion column
  // Behavior:
  //   - Nothing opens the chat automatically — user must click "AI Chat" once.
  //   - After that first click, the mode ('side' by default) is remembered across refreshes.
  //   - Clicking the X in the header closes it and that "closed" state also persists.
  type ChatMode = 'closed' | 'dock' | 'side'
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    try {
      const v = localStorage.getItem('chat.mode')
      if (v === 'dock' || v === 'side' || v === 'closed') return v
    } catch { /* ignore */ }
    return 'closed'
  })
  useEffect(() => { try { localStorage.setItem('chat.mode', chatMode) } catch { /* ignore */ } }, [chatMode])
  // Sizes persist across sessions so users don't re-drag every time.
  const [chatHeight, setChatHeight] = useState<number>(() => {
    const v = Number(typeof window !== 'undefined' && localStorage.getItem('chat.dockHeight'))
    return Number.isFinite(v) && v >= 160 && v <= 800 ? v : 224
  })
  const [chatSideWidth, setChatSideWidth] = useState<number>(() => {
    const v = Number(typeof window !== 'undefined' && localStorage.getItem('chat.sideWidth'))
    return Number.isFinite(v) && v >= 260 && v <= 900 ? v : 380
  })
  useEffect(() => { try { localStorage.setItem('chat.dockHeight', String(chatHeight)) } catch { /* ignore */ } }, [chatHeight])
  useEffect(() => { try { localStorage.setItem('chat.sideWidth', String(chatSideWidth)) } catch { /* ignore */ } }, [chatSideWidth])
  const chatDragRef = useRef<{ startY: number; startH: number } | null>(null)
  const chatSideDragRef = useRef<{ startX: number; startW: number } | null>(null)
  // A one-shot draft that pre-fills the chat input when set by "Move to chat" on a selection.
  // ArtifactChat reads it, applies it once, then clears.
  const [chatDraft, setChatDraft] = useState<string | null>(null)
  const openChatWithDraft = useCallback((draft: string) => {
    setChatDraft(draft)
    // If chat isn't visible, pop it open in side mode.
    setChatMode((m) => m === 'closed' ? 'side' : m)
  }, [])
  const [planPreview, setPlanPreview] = useState<string | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [approving, setApproving] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [stageStatus, setStageStatus] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<MemberApproval[]>([])
  const [showPrompt, setShowPrompt] = useState(false)

  const { remoteUsers } = useYjsDocument(id ?? null, user)

  const lastAutoStageRef = useRef<string | null>(null)
  const userPickedArtifact = useRef(false)
  const autoOpenedArtifactIds = useRef<Set<string>>(new Set())
  const initialLoadDone = useRef(false)

  const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null
  // LoadingTab/FileTab are NOT artifacts. Only tabs without a `kind` marker are real artifacts.
  const activeArtifact = (activeTab && !('kind' in activeTab && activeTab.kind !== undefined)) ? (activeTab as ArtifactFull) : null

  const openFileTab = useCallback((path: string, content: string) => {
    const tabId = `file:${path}`
    setOpenTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId)
      if (existing) {
        setActiveTabId(tabId)
        return prev
      }
      const tab: FileTab = { id: tabId, kind: 'file', path, content }
      setActiveTabId(tabId)
      return [...prev, tab]
    })
    userPickedArtifact.current = true
  }, [])

  const openArtifact = useCallback(async (art: Artifact, isAuto = false) => {
    if (!id) return
    // If already open, just focus it
    const existing = openTabs.find((t) => t.id === art.id)
    if (existing) {
      setActiveTabId(existing.id)
      if (!isAuto) { setStageArtifactView(null); userPickedArtifact.current = true }
      return
    }
    try {
      const full = await api.get<ArtifactFull>(`/api/features/${id}/artifacts/${art.id}`)
      setOpenTabs((prev) => [...prev, full as CenterTab])
      setActiveTabId(full.id)
      if (!isAuto) { setStageArtifactView(null); userPickedArtifact.current = true }
    } catch (e) {
      toast.error(String(e))
    }
  }, [id, openTabs])

  const closeTab = (tabId: string) => {
    userPickedArtifact.current = true
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId)
      const next = prev.filter((t) => t.id !== tabId)
      if (activeTabId === tabId) {
        const newActive = next[idx] ?? next[idx - 1] ?? null
        setActiveTabId(newActive?.id ?? null)
      }
      return next
    })
  }

  const updateTab = (updated: ArtifactFull) => {
    setOpenTabs((prev) => prev.map((t) => t.id === updated.id ? (updated as CenterTab) : t))
  }

  // Apply an SSE artifact update by slug — used by ArtifactChat when the AI rewrites an artifact.
  const applyArtifactUpdateBySlug = useCallback(
    (patch: { slug: string; content_md: string; version: number }) => {
      setOpenTabs((prev) => prev.map((t) => {
        if ('kind' in t && t.kind !== undefined) return t
        const art = t as ArtifactFull
        if (art.slug !== patch.slug) return t
        return { ...art, content_md: patch.content_md, version: patch.version } as CenterTab
      }))
      setArtifacts((prev) => prev.map((a) =>
        a.slug === patch.slug ? { ...a, content_md: patch.content_md, version: patch.version } : a,
      ))
    },
    [],
  )

  const updateFileTab = (tabId: string, editedContent: string) => {
    setOpenTabs((prev) => prev.map((t) =>
      t.id === tabId && t.kind === 'file' ? { ...t, editedContent } : t
    ))
  }

  const loadData = useCallback(async () => {
    if (!id) return
    try {
      const joinParam = joinOnce.current ? '?join=1' : ''
      joinOnce.current = false
      const [feat, arts, gts, approvs] = await Promise.all([
        api.get<Feature>(`/api/features/${id}${joinParam}`),
        api.get<Artifact[]>(`/api/features/${id}/artifacts`),
        api.get<Gate[]>(`/api/features/${id}/gates`),
        api.get<MemberApproval[]>(`/api/features/${id}/approvals`).catch(() => [] as MemberApproval[]),
      ])
      setFeature(feat)
      setArtifacts(arts)
      setGates(gts)
      setApprovals(approvs)

      let latestRunStatus: string | null = null
      try {
        const runs = await api.get<Array<{ id: string; status: string; stage_slug: string }>>(`/api/features/${id}/stage-runs`)
        const latest = runs[0]
        latestRunStatus = latest?.status ?? null
        setStageStatus(latestRunStatus)
        setStageRuns([...runs].reverse())
        // Default selected stage to current
        if (!selectedStage) setSelectedStage(feat.current_stage_id)
      } catch { /* ignore */ }

      // Stage-aware tab management
      const currentStage = feat.current_stage_id
      const stageChanged = currentStage !== lastAutoStageRef.current
      const isCommitted = feat.status === 'committed'
      const isRunning = latestRunStatus === 'running'

      if (!initialLoadDone.current) {
        // ── FIRST LOAD (page open / refresh) ──────────────────────────────────
        initialLoadDone.current = true
        lastAutoStageRef.current = currentStage

        // Mark every existing artifact as already seen — polling must not re-open them
        arts.forEach((a) => autoOpenedArtifactIds.current.add(a.id))

        if (!isCommitted) {
          if (isRunning) {
            // Stage actively running: show loading tab only
            const loadingTab: LoadingTab = { id: '__loading__', kind: 'loading', stageSlug: currentStage ?? '' }
            setOpenTabs([loadingTab])
            setActiveTabId('__loading__')
          } else if (arts.length > 0) {
            // Not running: open the single most-relevant artifact
            //   1. Questions artifact (needs user input) — last one wins
            //   2. Most recent artifact overall
            const questionsArt = [...arts].reverse().find((a) => a.artifact_type === 'questions')
            const toOpen = questionsArt ?? arts[arts.length - 1]
            try {
              const full = await api.get<ArtifactFull>(`/api/features/${id}/artifacts/${toOpen.id}`)
              setOpenTabs([full as CenterTab])
              setActiveTabId(full.id)
            } catch { /* ignore */ }
          }
        }
        return // skip polling logic on first load
      }

      // ── SUBSEQUENT POLLS ──────────────────────────────────────────────────
      if (stageChanged) {
        lastAutoStageRef.current = currentStage
        // New stage started: reset opened artifact tracking, add loading tab
        autoOpenedArtifactIds.current = new Set()
        if (!isCommitted) {
          setOpenTabs((prev) => {
            const withoutLoading = prev.filter((t) => t.id !== '__loading__')
            const loadingTab: LoadingTab = { id: '__loading__', kind: 'loading', stageSlug: currentStage ?? '' }
            return [loadingTab, ...withoutLoading]
          })
          setActiveTabId('__loading__')
          userPickedArtifact.current = false
        }
      }

      if (!isCommitted) {
        // Ensure loading tab is present while stage is running (and user hasn't dismissed it)
        if (isRunning) {
          setOpenTabs((prev) => {
            if (prev.find((t) => t.id === '__loading__')) return prev
            if (userPickedArtifact.current) return prev // user closed it intentionally
            const loadingTab: LoadingTab = { id: '__loading__', kind: 'loading', stageSlug: currentStage ?? '' }
            return [loadingTab, ...prev]
          })
          // If no user-selected tab is active, keep loading tab focused
          setActiveTabId((prev) => {
            if (userPickedArtifact.current) return prev
            return prev ?? '__loading__'
          })
        }

        // Auto-open NEW artifacts as they arrive (never re-open already-opened ones)
        const newArts = arts.filter((a) => !autoOpenedArtifactIds.current.has(a.id))
        for (const art of newArts) {
          autoOpenedArtifactIds.current.add(art.id)
          try {
            const full = await api.get<ArtifactFull>(`/api/features/${id}/artifacts/${art.id}`)
            setOpenTabs((prev) => {
              if (prev.find((t) => t.id === full.id)) return prev
              return [...prev, full as CenterTab]
            })
            // Only auto-focus new artifact if user hasn't manually picked something
            if (!userPickedArtifact.current) {
              setActiveTabId(full.id)
              // Remove loading tab once first artifact arrives
              setOpenTabs((prev) => prev.filter((t) => t.id !== '__loading__'))
            }
          } catch { /* ignore */ }
        }

        // When stage is no longer running and loading tab is still there with no artifacts, remove it
        if (!isRunning && arts.length > 0) {
          setOpenTabs((prev) => prev.filter((t) => t.id !== '__loading__'))
        }
      }
    } catch (e) {
      const msg = String(e)
      if (msg.includes('not found') || msg.includes('404')) {
        setNotFound(true)
      } else {
        toast.error(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [id, selectedStage])

  useEffect(() => {
    if (notFound) return
    loadData()
    const interval = setInterval(loadData, 4_000)
    return () => clearInterval(interval)
  }, [loadData, notFound])

  const handleStop = async () => {
    if (!id) return
    setStopping(true)
    try {
      await api.post(`/api/features/${id}/stop`)
      toast.success('Pipeline stopped')
      await loadData()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setStopping(false)
    }
  }

  const handleRetry = async () => {
    if (!id) return
    setRetrying(true)
    try {
      await api.post(`/api/features/${id}/retry`)
      toast.success('Stage retrying from last checkpoint')
      await loadData()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setRetrying(false)
    }
  }

  const handleViewPlan = async () => {
    if (!id) return
    setPlanLoading(true)
    try {
      const r = await api.get<{ planMd: string; fileCount: number }>(`/api/features/${id}/plan`)
      setPlanPreview(r.planMd)
    } catch (e) {
      toast.error(String(e))
    } finally {
      setPlanLoading(false)
    }
  }

  const commitInFlight = useRef(false)
  const handleCommit = async () => {
    if (!id || commitInFlight.current) return
    commitInFlight.current = true
    setCommitting(true)
    try {
      const r = await api.post<{ sha: string; branch: string; repo_url: string }>(`/api/features/${id}/commit`)
      toast.success(`Plan committed to ${r.branch}`)
      // Close any open artifact/chat tabs and clear the stage-artifact view so the
      // success screen (which renders when there's no activeTab) shows automatically.
      setOpenTabs([])
      setActiveTabId(null)
      setStageArtifactView(null)
      await loadData()
    } catch (e) {
      // Surface backend error text so the user knows why the push failed.
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`Commit failed: ${msg}`)
    } finally {
      setCommitting(false)
      commitInFlight.current = false
    }
  }

  const approveInFlight = useRef(false)
  const handleApprove = async () => {
    if (!id || approveInFlight.current) return
    approveInFlight.current = true
    setApproving(true)
    try {
      await api.post(`/api/features/${id}/approve`, { verdict: 'approved' })
      toast.success('Approval recorded')
      await loadData()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setApproving(false)
      approveInFlight.current = false
    }
  }

  const [restartingStage, setRestartingStage] = useState<string | null>(null)
  const restartInFlight = useRef<string | null>(null)
  const handleRestartStage = async (stageSlug: string) => {
    if (!id || restartInFlight.current === stageSlug) return
    if (!window.confirm(`Restart the "${stageSlug}" stage? This wipes it and every stage after it, then re-runs from here. Existing chat and approvals are preserved.`)) return
    restartInFlight.current = stageSlug
    setRestartingStage(stageSlug)
    try {
      await api.post(`/api/features/${id}/stages/${stageSlug}/restart`)
      toast.success(`Restarting from ${stageSlug}…`)
      await loadData()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setRestartingStage(null)
      restartInFlight.current = null
    }
  }

  const advanceInFlight = useRef(false)
  const [advancing, setAdvancing] = useState(false)
  const handleAdvance = async () => {
    if (!id || advanceInFlight.current) return
    advanceInFlight.current = true
    setAdvancing(true)
    try {
      await api.post(`/api/features/${id}/advance`)
      toast.success('Advancing to next stage…')
      await loadData()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setAdvancing(false)
      advanceInFlight.current = false
    }
  }

  // Approval stage has its own big center card and bottom bar — never render its validation
  // gate (if some legacy feature still has one) in the top strip.
  const pendingGates = gates.filter(
    (g) => g.status === 'pending' && g.step_id !== 'final-approval-gate',
  )
  const approvedCount = approvals.filter((a) => a.verdict === 'approved').length
  const quorumSize = feature?.quorum_size ?? 1
  const effectiveQuorum = Math.min(quorumSize, Math.max(approvals.length, 1))
  const quorumMet = approvedCount >= effectiveQuorum
  const myApproval = approvals.find((a) => a.user_id === user?.id)

  // Detect a stuck workflow: current stage is done, no pending gate, no next stage_run yet,
  // and the feature isn't already in a terminal state. Shows a Continue button.
  const currentStageRun = stageRuns.find((sr) => sr.stage_slug === feature?.current_stage_id)
  const stageRunSlugs = new Set(stageRuns.map((sr) => sr.stage_slug))
  const OPENSPEC_ORDER = ['proposal', 'spec', 'design', 'technical', 'review', 'approval']
  const currentIdx = OPENSPEC_ORDER.indexOf(feature?.current_stage_id ?? '')
  const nextStageSlug = currentIdx >= 0 && currentIdx < OPENSPEC_ORDER.length - 1
    ? OPENSPEC_ORDER[currentIdx + 1] : null
  const isStuckAtDone =
    !!feature &&
    feature.status !== 'planned' &&
    feature.status !== 'committed' &&
    currentStageRun?.status === 'done' &&
    pendingGates.length === 0 &&
    !!nextStageSlug &&
    !stageRunSlugs.has(nextStageSlug)
  // OpenSpec: 'approval' is the final stage — feature is ready for commit once quorum approves.
  // feature.status becomes 'planned' after approval, and 'committed' after a successful git push.
  const isApprovalStage =
    feature?.current_stage_id === 'approval' ||
    feature?.status === 'planned' ||
    feature?.status === 'committed'
  const canCommit = isApprovalStage && pendingGates.length === 0 && quorumMet

  const copyInviteLink = () => {
    const link = `${window.location.origin}/features/${id}?join=1`
    navigator.clipboard.writeText(link).then(() =>
      toast.success('Invite link copied! Send it to a collaborator — they paste it in their browser address bar to join this workspace.')
    )
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground animate-pulse">Loading workspace…</div>
      </div>
    )
  }

  if (notFound || (!loading && !feature)) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium">Workspace not found</p>
          <p className="text-sm text-muted-foreground">This feature may have been deleted or the link is invalid.</p>
          <Link to="/" className="mt-4 inline-block text-primary hover:underline text-sm">← Back to features</Link>
        </div>
      </div>
    )
  }

  if (!feature) return null  // narrowing guard — notFound/loading already handled above

  const currentStageStatus = stageRuns.find((sr) => sr.stage_slug === selectedStage)?.status ?? null

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      {/* Plan preview modal */}
      {planPreview !== null && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-background border border-border rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col shadow-xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
              <h2 className="text-sm font-semibold">Consolidated Plan Preview</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{feature.plan_branch}</span>
                <button onClick={() => setPlanPreview(null)} className="text-muted-foreground hover:text-foreground text-lg leading-none px-1">×</button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-xs font-mono whitespace-pre-wrap text-foreground leading-relaxed">{planPreview}</pre>
            </div>
            <div className="px-4 py-3 border-t border-border flex-shrink-0 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">This is a preview of what will be committed to the <code className="font-mono">{feature.plan_branch}</code> branch</p>
              {feature.status !== 'committed' && canCommit && (
                <button
                  onClick={() => { setPlanPreview(null); handleCommit() }}
                  className="px-4 py-1.5 rounded text-sm font-medium bg-green-600 text-white hover:bg-green-700"
                >
                  Commit to branch
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Feature details modal */}
      {showPrompt && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setShowPrompt(false)}>
          <div className="border border-border rounded-lg w-full max-w-xl shadow-xl" style={{ background: 'hsl(var(--card))', color: 'hsl(var(--card-foreground))' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h2 className="text-sm font-semibold">Feature Details</h2>
              <button onClick={() => setShowPrompt(false)} className="text-muted-foreground hover:text-foreground text-lg leading-none px-1">×</button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <div>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</span>
                <p className="mt-0.5 font-medium">{feature.title}</p>
              </div>
              <div>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Description / Prompt</span>
                <pre className="mt-1 text-xs bg-secondary/40 rounded p-3 whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-auto">{feature.prompt}</pre>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                {feature.repo_url && (
                  <div>
                    <span className="font-medium text-muted-foreground">Repo</span>
                    <p className="font-mono mt-0.5 break-all">{feature.repo_url}</p>
                  </div>
                )}
                <div>
                  <span className="font-medium text-muted-foreground">Base branch</span>
                  <p className="font-mono mt-0.5">{feature.base_branch}</p>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">Plan branch</span>
                  <p className="font-mono mt-0.5">{feature.plan_branch ?? '—'}</p>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">Quorum size</span>
                  <p className="mt-0.5">{feature.quorum_size} member{feature.quorum_size !== 1 ? 's' : ''}</p>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">Created</span>
                  <p className="mt-0.5">{new Date(feature.created_at).toLocaleString()}</p>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">Status</span>
                  <p className="mt-0.5 capitalize">{feature.status}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-2 border-b border-border flex-shrink-0">
        <Link to="/" className="text-muted-foreground hover:text-foreground text-sm">←</Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold truncate">{feature.title}</h1>
          <p className="text-xs text-muted-foreground">
            {feature.current_stage_id ?? 'starting…'} · {feature.status}
          </p>
        </div>
        {feature.repo_url && (
          <span className="hidden md:flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-2 py-0.5 rounded-full font-medium">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/></svg>
            Brownfield
          </span>
        )}
        <button
          onClick={() => setShowPrompt(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-secondary transition-colors border border-transparent hover:border-border"
          title="View feature details & prompt"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Details
        </button>
        {feature.plan_branch && (
          <span className="text-xs text-muted-foreground font-mono bg-secondary px-2 py-0.5 rounded hidden md:inline">
            {feature.plan_branch}
          </span>
        )}
        <button
          onClick={copyInviteLink}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          title="Copy invite link"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/>
            <polyline points="16 6 12 2 8 6"/>
            <line x1="12" y1="2" x2="12" y2="15"/>
          </svg>
          Share
        </button>
        {user && <UserMenu user={user} />}
      </header>

      {/* Main 3-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left column */}
        <div className="w-64 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
          <div className="flex border-b border-border">
            {(['phases', 'files', 'artifacts'] as LeftTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setLeftTab(tab)}
                className={`flex-1 py-2 text-sm font-medium capitalize ${
                  leftTab === tab
                    ? 'border-b-2 border-primary text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-hidden flex flex-col">
            {leftTab === 'phases' && (
              <>
                {/* Feature info card */}
                <div className="flex-shrink-0 mx-2 mt-2 mb-1 px-3 py-2 rounded-lg border border-border bg-secondary/30 text-sm space-y-1">
                  <p className="font-semibold truncate text-foreground">{feature.title}</p>
                  <p className="text-muted-foreground line-clamp-2 leading-relaxed">{feature.prompt}</p>
                  {feature.repo_url && (
                    <p className="text-muted-foreground font-mono truncate">
                      <span className="text-emerald-600 dark:text-emerald-400 font-sans font-medium mr-1">repo:</span>
                      {feature.repo_url.replace(/^https?:\/\/(www\.)?/, '')}
                    </p>
                  )}
                  <button onClick={() => setShowPrompt(true)} className="text-primary hover:underline text-sm">
                    View full details →
                  </button>
                </div>
                {/* Stage list — compact, scrollable, doesn't push logs too small */}
                <div className="overflow-auto flex-shrink-0" style={{ flex: '0 0 auto', maxHeight: '45%', minHeight: 80 }}>
                  <PhaseDiagram
                    currentStage={feature.current_stage_id}
                    selectedStage={selectedStage}
                    onSelectStage={(slug) => {
                      setSelectedStage(slug)
                      const run = stageRuns.find((r) => r.stage_slug === slug)
                      if (!run) return
                      if (run.status === 'running' || run.status === 'parked') {
                        // Active/running stage: show loading tab in center
                        setStageArtifactView(null)
                        setOpenTabs((prev) => {
                          if (prev.find((t) => t.id === '__loading__')) return prev
                          const loadingTab: LoadingTab = { id: '__loading__', kind: 'loading', stageSlug: slug }
                          return [loadingTab, ...prev]
                        })
                        setActiveTabId('__loading__')
                      } else if (run.status === 'done') {
                        // Done stage: show its artifact grid in center
                        setStageArtifactView(slug)
                        setActiveTabId(null)
                      }
                    }}
                  />
                </div>
                {/* Drag handle */}
                <div
                  className="flex-shrink-0 h-1.5 border-t border-border cursor-row-resize hover:bg-primary/20 active:bg-primary/30 transition-colors relative group"
                  onMouseDown={(e) => {
                    logsDragRef.current = { startY: e.clientY, startH: logsPanelHeight }
                    const onMove = (ev: MouseEvent) => {
                      if (!logsDragRef.current) return
                      const delta = logsDragRef.current.startY - ev.clientY
                      setLogsPanelHeight(Math.max(60, Math.min(700, logsDragRef.current.startH + delta)))
                    }
                    const onUp = () => {
                      logsDragRef.current = null
                      window.removeEventListener('mousemove', onMove)
                      window.removeEventListener('mouseup', onUp)
                    }
                    window.addEventListener('mousemove', onMove)
                    window.addEventListener('mouseup', onUp)
                  }}
                >
                  <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="w-8 h-0.5 rounded-full bg-muted-foreground/40" />
                  </div>
                </div>
                {/* Logs pane — resizable height */}
                <div className="flex-shrink-0 border-t border-border overflow-hidden" style={{ height: logsPanelHeight }}>
                  <StageLogPane
                    featureId={feature.id}
                    stageSlug={selectedStage ?? feature.current_stage_id}
                    stageStatus={currentStageStatus}
                  />
                </div>
              </>
            )}
            {leftTab === 'files' && (
              <div className="flex-1 overflow-hidden">
                <GitFileBrowser featureId={feature.id} onOpenFile={openFileTab} />
              </div>
            )}
            {leftTab === 'artifacts' && (
              <div className="flex-1 overflow-auto p-2 space-y-1">
                {artifacts.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-2">No artifacts yet — AI is generating…</p>
                ) : artifacts.map((a) => {
                  const isQuestion = a.artifact_type === 'questions'
                  const isOpen = openTabs.some((t) => t.id === a.id)
                  const isActive = activeTabId === a.id
                  return (
                    <button
                      key={a.id}
                      onClick={() => openArtifact(a)}
                      className={`w-full text-left px-2 py-2 rounded text-sm hover:bg-accent transition-colors ${
                        isActive ? 'bg-primary/10 text-primary' : isOpen ? 'bg-secondary/50' : ''
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isQuestion ? 'bg-amber-400' : 'bg-green-500'}`} />
                        <div className="font-medium truncate flex-1">{a.title || a.slug}</div>
                        {isOpen && <span className="text-xs text-muted-foreground flex-shrink-0">open</span>}
                      </div>
                      <div className="text-muted-foreground pl-3 mt-0.5 capitalize">{a.artifact_type}</div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Center column */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Browser-style artifact tab bar */}
          {openTabs.length > 0 && (
            <div className="flex border-b border-border overflow-x-auto flex-shrink-0 bg-background">
              {openTabs.map((tab) => {
                const isLoading = tab.kind === 'loading'
                const isFile = tab.kind === 'file'
                const label = isLoading
                  ? ((tab as LoadingTab).stageSlug.replace(/-/g, ' ') || 'working…')
                  : isFile
                    ? (tab as FileTab).path.split('/').pop()!
                    : ((tab as ArtifactFull).title || (tab as ArtifactFull).slug)
                const dotColor = isLoading ? 'bg-blue-400 animate-pulse'
                  : isFile ? 'bg-sky-400'
                  : (tab as ArtifactFull).artifact_type === 'questions' ? 'bg-amber-400' : 'bg-green-500'
                const isModified = isFile && (tab as FileTab).editedContent !== undefined && (tab as FileTab).editedContent !== (tab as FileTab).content
                return (
                  <button
                    key={tab.id}
                    className={`flex items-center gap-1.5 px-3 py-2 text-sm border-r border-border whitespace-nowrap flex-shrink-0 ${
                      activeTabId === tab.id
                        ? 'bg-background text-foreground border-b-2 border-b-primary'
                        : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'
                    }`}
                    onClick={() => { setActiveTabId(tab.id); if (!isLoading) userPickedArtifact.current = true }}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
                    <span className="max-w-[120px] truncate">{label}</span>
                    {isModified && <span className="text-amber-500 text-xs">●</span>}
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                      className="ml-1 opacity-50 hover:opacity-100 rounded hover:bg-destructive/20 px-0.5 leading-none"
                    >
                      ×
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Stage progress timeline */}
          {stageRuns.length > 0 && (
            <div className="border-b border-border px-3 py-2 flex items-center gap-1 flex-wrap overflow-x-auto flex-shrink-0">
              {stageRuns.map((sr, i) => {
                const isCurrent = sr.stage_slug === feature.current_stage_id
                const color =
                  sr.status === 'done' ? 'bg-green-500' :
                  sr.status === 'running' ? 'bg-blue-500 animate-pulse' :
                  sr.status === 'parked' ? 'bg-amber-400' :
                  sr.status === 'failed' ? 'bg-red-500' :
                  sr.status === 'stopped' ? 'bg-amber-500' : 'bg-muted'
                return (
                  <div key={sr.stage_slug} className="flex items-center gap-1">
                    {i > 0 && <div className="w-3 h-px bg-border" />}
                    <div
                      className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                        isCurrent ? 'ring-1 ring-primary' : ''
                      } bg-secondary text-muted-foreground`}
                      title={`${sr.stage_slug}: ${sr.status}`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full ${color}`} />
                      {sr.stage_slug.replace(/-/g, ' ')}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Stop button — shown while a stage is actively running or parked */}
          {(stageStatus === 'running' || stageStatus === 'parked') && (
            <div className="border-b border-border bg-secondary/30 px-4 py-2 flex items-center gap-3 flex-shrink-0">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse flex-shrink-0" />
                <span className="text-sm text-muted-foreground">
                  Stage <strong className="text-foreground">{feature.current_stage_id}</strong> is {stageStatus === 'parked' ? 'waiting for input' : 'running'}
                </span>
              </div>
              <button
                onClick={handleStop}
                disabled={stopping}
                className="flex-shrink-0 px-3 py-1 rounded text-sm font-medium border border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors"
              >
                {stopping ? 'Stopping…' : '⏹ Stop pipeline'}
              </button>
            </div>
          )}

          {/* Stage failed / stopped banner — always visible */}
          {(stageStatus === 'failed' || stageStatus === 'stopped') && (
            <div className={`border-b px-4 py-2.5 flex items-center gap-3 flex-shrink-0 ${
              stageStatus === 'stopped'
                ? 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40'
                : 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40'
            }`}>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`flex-shrink-0 ${stageStatus === 'stopped' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <span className={`text-sm font-medium ${stageStatus === 'stopped' ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300'}`}>
                  {stageStatus === 'stopped'
                    ? <>Stage <strong>{feature.current_stage_id}</strong> was stopped — pipeline is paused</>
                    : <>Stage <strong>{feature.current_stage_id}</strong> failed — pipeline is paused</>
                  }
                </span>
              </div>
              <button
                onClick={handleRetry}
                disabled={retrying}
                className={`flex-shrink-0 px-3 py-1 rounded text-sm font-medium text-white disabled:opacity-50 transition-colors ${
                  stageStatus === 'stopped' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {retrying ? 'Retrying…' : '↺ Retry'}
              </button>
            </div>
          )}

          {/* Stuck-at-done strip: current stage is done but pipeline hasn't advanced. */}
          {isStuckAtDone && (
            <div className="border-b border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 px-4 py-2.5 flex items-center gap-3 flex-shrink-0">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 text-blue-600 dark:text-blue-400">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                  Stage <strong>{feature.current_stage_id}</strong> is done. Continue to <strong>{nextStageSlug}</strong>.
                </span>
              </div>
              <button
                onClick={handleAdvance}
                disabled={advancing}
                className="flex-shrink-0 px-3 py-1 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {advancing ? 'Advancing…' : 'Continue →'}
              </button>
            </div>
          )}

          {/* Pending gates strip — scrollable so tall gate cards don't clip */}
          {pendingGates.length > 0 && (
            <div className="border-b border-border bg-amber-50/50 flex-shrink-0 overflow-auto" style={{ maxHeight: '55vh' }}>
              <p className="text-sm font-medium text-amber-700 px-3 pt-3 pb-2">
                {pendingGates.length} pending {pendingGates.length === 1 ? 'action' : 'actions'}
              </p>
              <div className="px-3 pb-3 space-y-2">
                {pendingGates.map((g) => (
                  <GateCard key={g.id} gate={g} currentUserId={user?.id} onAnswered={loadData} />
                ))}
              </div>
            </div>
          )}

          {/* Artifact editor area + chat panel.
              Outer is a vertical flex (top row = horizontal split of artifact+side-chat, bottom row = dock-chat). */}
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            <div className="flex-1 overflow-hidden flex flex-row min-w-0">
            <div className="flex-1 overflow-hidden min-w-0">
              {stageArtifactView && !activeTab ? (
                // Stage artifact panel — special-cases review (show plan) and approval (show approved-by).
                (() => {
                  const run = stageRuns.find((r) => r.stage_slug === stageArtifactView)
                  // Review stage → show the consolidated `plan` artifact directly.
                  const planArt = artifacts.find((a) => a.slug === 'plan')
                  const isReview = stageArtifactView === 'review'
                  const isApproval = stageArtifactView === 'approval'
                  const stageArts = run
                    ? (isReview && planArt ? [planArt] : artifacts.filter((a) => a.stage_run_id === run.id))
                    : []
                  // Hide restart once the plan is actually pushed to git — nothing to redo then.
                  const isCommitted = feature?.status === 'committed' && !!feature?.committed_sha
                  const canRestart = (run?.status === 'done' || run?.status === 'failed') && !isCommitted
                  return (
                    <div className="flex flex-col h-full overflow-hidden">
                      <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                        <span className="text-sm font-medium capitalize">{stageArtifactView.replace(/-/g, ' ')}</span>
                        {!isApproval && (
                          <span className="text-xs text-muted-foreground">· {stageArts.length} artifact{stageArts.length !== 1 ? 's' : ''}</span>
                        )}
                        {canRestart && !isApproval && (
                          <button
                            onClick={() => handleRestartStage(stageArtifactView)}
                            disabled={restartingStage === stageArtifactView}
                            className="ml-auto text-xs px-2 py-1 rounded border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950 disabled:opacity-50 transition-colors font-medium"
                            title="Restart this stage — wipes downstream work and re-runs from here"
                          >
                            {restartingStage === stageArtifactView ? 'Restarting…' : '↺ Restart stage'}
                          </button>
                        )}
                        <button onClick={() => setStageArtifactView(null)} className={`${!canRestart || isApproval ? 'ml-auto' : 'ml-2'} text-xs text-muted-foreground hover:text-foreground px-1`}>✕</button>
                      </div>
                      {isApproval ? (
                        // Approval stage: show who approved and when — NOT artifacts.
                        <div className="flex-1 overflow-auto p-4">
                          <div className="max-w-2xl mx-auto space-y-4">
                            <div className="text-center">
                              <div className={`inline-flex items-center justify-center w-12 h-12 rounded-full mb-3 ${quorumMet ? 'bg-green-100 dark:bg-green-950/50' : 'bg-amber-100 dark:bg-amber-950/40'}`}>
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={quorumMet ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}>
                                  {quorumMet
                                    ? <polyline points="20 6 9 17 4 12" />
                                    : <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>}
                                </svg>
                              </div>
                              <h3 className="text-base font-semibold text-foreground">
                                {quorumMet ? `Quorum reached — ${approvedCount}/${effectiveQuorum} approved` : `Waiting for approval (${approvedCount}/${effectiveQuorum})`}
                              </h3>
                            </div>
                            <div className="rounded-lg border border-border divide-y divide-border">
                              {approvals.map((a) => (
                                <div key={a.user_id} className="flex items-center gap-3 px-4 py-3">
                                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${a.verdict === 'approved' ? 'bg-green-100 dark:bg-green-950/50 text-green-700 dark:text-green-400' : 'bg-secondary text-muted-foreground'}`}>
                                    {(a.name?.[0] ?? '?').toUpperCase()}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{a.name}</p>
                                    <p className="text-xs text-muted-foreground truncate">{a.email}</p>
                                  </div>
                                  {a.verdict === 'approved' ? (
                                    <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400 font-medium">
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                                      Approved
                                    </span>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">Pending</span>
                                  )}
                                </div>
                              ))}
                              {approvals.length === 0 && (
                                <div className="px-4 py-6 text-center text-sm text-muted-foreground">No members to approve yet.</div>
                              )}
                            </div>

                            {/* Prominent Approve action — the primary CTA in this stage. */}
                            {(() => {
                              const iApproved = myApproval?.verdict === 'approved'
                              const disabled = approving || iApproved || quorumMet
                              const label = approving
                                ? 'Approving…'
                                : iApproved
                                  ? '✓ You approved this plan'
                                  : quorumMet
                                    ? `Quorum met — no more approvals needed`
                                    : `Approve final plan`
                              return (
                                <div className="flex flex-col items-center gap-2 pt-2">
                                  <button
                                    onClick={handleApprove}
                                    disabled={disabled}
                                    className={`px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                                      disabled
                                        ? 'bg-secondary text-muted-foreground cursor-not-allowed'
                                        : 'bg-primary text-primary-foreground hover:opacity-90 shadow-sm'
                                    }`}
                                  >
                                    {label}
                                  </button>
                                  <p className="text-xs text-muted-foreground text-center">
                                    Quorum: {effectiveQuorum} of {approvals.length || 1} member{approvals.length === 1 ? '' : 's'} · {approvedCount} approved so far
                                  </p>
                                </div>
                              )
                            })()}
                          </div>
                        </div>
                      ) : stageArts.length === 0 ? (
                        <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
                          {isReview ? 'PLAN artifact not built yet — complete the technical stage first.' : 'No artifacts for this stage'}
                        </div>
                      ) : (
                        <div className="flex-1 overflow-auto p-4">
                          <div className="grid grid-cols-2 gap-3">
                            {stageArts.map((a) => {
                              const isQuestion = a.artifact_type === 'questions'
                              const isPlan = a.artifact_type === 'openspec-plan'
                              return (
                                <button
                                  key={a.id}
                                  onClick={() => openArtifact(a)}
                                  className={`text-left p-3 rounded-lg border transition-colors group ${isPlan ? 'border-primary/40 bg-primary/5 hover:bg-primary/10 col-span-2' : 'border-border hover:border-ring hover:bg-accent'}`}
                                >
                                  <div className="flex items-start gap-2">
                                    <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${isQuestion ? 'bg-amber-400' : isPlan ? 'bg-primary' : 'bg-green-500'}`} />
                                    <div className="min-w-0 flex-1">
                                      <p className="text-xs font-semibold text-foreground truncate group-hover:text-primary">
                                        {isPlan ? 'Final Consolidated Plan' : (a.title || a.slug)}
                                      </p>
                                      <p className="text-xs text-muted-foreground capitalize mt-0.5">{isPlan ? 'Combined PLAN.md — proposal + spec + design + technical' : a.artifact_type}</p>
                                    </div>
                                  </div>
                                  <p className="text-xs text-muted-foreground mt-2 pl-4">Click to open →</p>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })()
              ) : activeTab?.kind === 'loading' ? (
                // Loading tab — shown while a stage is running
                <div className="flex items-center justify-center h-full">
                  <div className="text-center space-y-4">
                    <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
                    <div>
                      <p className="text-sm font-semibold text-foreground">AI is working…</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Stage: <strong>{(activeTab as LoadingTab).stageSlug.replace(/-/g, ' ') || feature.current_stage_id}</strong>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1 animate-pulse">Artifacts will appear as new tabs when ready</p>
                    </div>
                  </div>
                </div>
              ) : activeTab?.kind === 'file' ? (
                // File editor tab
                <div className="flex flex-col h-full overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-secondary/30 flex-shrink-0">
                    <span className="text-xs font-mono truncate flex-1 text-muted-foreground">{(activeTab as FileTab).path}</span>
                    {(activeTab as FileTab).editedContent !== undefined && (activeTab as FileTab).editedContent !== (activeTab as FileTab).content && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium flex-shrink-0">Modified</span>
                    )}
                  </div>
                  <div className="flex-1 overflow-hidden p-0">
                    <textarea
                      className="w-full h-full text-xs font-mono resize-none bg-background text-foreground outline-none p-3"
                      value={(activeTab as FileTab).editedContent ?? (activeTab as FileTab).content}
                      onChange={(e) => updateFileTab(activeTab.id, e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                </div>
              ) : activeArtifact ? (
                activeArtifact.artifact_type === 'questions' ? (
                  <QuestionForm
                    featureId={feature.id}
                    artifactId={activeArtifact.id}
                    artifactSlug={activeArtifact.slug}
                    content={activeArtifact.content_md}
                    onSubmitted={() => {
                      userPickedArtifact.current = false
                      lastAutoStageRef.current = null
                      closeTab(activeArtifact.id)
                      loadData()
                    }}
                  />
                ) : (
                  <ArtifactEditor
                    featureId={feature.id}
                    artifactId={activeArtifact.id}
                    slug={activeArtifact.slug}
                    title={activeArtifact.title}
                    initialContent={activeArtifact.content_md}
                    onOpenChatWithDraft={openChatWithDraft}
                  />
                )
              ) : (
                <div className="flex items-center justify-center h-full">
                  {feature.status === 'committed' ? (
                    /* Committed success card */
                    <div className="max-w-md w-full mx-6 space-y-5">
                      <div className="text-center">
                        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-100 dark:bg-green-950/50 mb-4">
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-600 dark:text-green-400">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        </div>
                        <h2 className="text-lg font-semibold text-foreground">Feature plan committed</h2>
                        <p className="text-sm text-muted-foreground mt-1">
                          The full plan has been pushed to the repository branch.
                        </p>
                      </div>
                      <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2 text-sm">
                        <div className="flex items-center gap-2">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/></svg>
                          <span className="font-mono text-xs text-muted-foreground truncate">{feature.plan_branch}</span>
                        </div>
                        {feature.committed_sha && (
                          <div className="flex items-center gap-2">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0"><circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="9"/><line x1="12" y1="15" x2="12" y2="21"/></svg>
                            <span className="font-mono text-xs text-green-600 dark:text-green-400">{feature.committed_sha.slice(0, 7)}</span>
                            <span className="text-xs text-muted-foreground">commit SHA</span>
                          </div>
                        )}
                      </div>
                      <div className="flex gap-3">
                        <button
                          onClick={handleViewPlan}
                          disabled={planLoading}
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border hover:bg-secondary transition-colors text-sm font-medium disabled:opacity-50"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                          {planLoading ? 'Loading…' : 'Preview Plan'}
                        </button>
                        {feature.repo_url && (
                          <a
                            href={`${feature.repo_url}/tree/${feature.plan_branch}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity text-sm font-medium"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/></svg>
                            View on GitHub
                          </a>
                        )}
                      </div>
                      <p className="text-center text-xs text-muted-foreground">
                        Click any stage on the left to browse its artifacts →
                      </p>
                    </div>
                  ) : (
                    <div className="text-center text-muted-foreground">
                      {stageStatus === 'running' ? (
                        <>
                          <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4 mx-auto" />
                          <p className="text-sm font-semibold">AI is working…</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Stage: <strong>{feature.current_stage_id}</strong>
                          </p>
                          <p className="text-xs text-muted-foreground mt-1 animate-pulse">Generating artifacts, please wait…</p>
                        </>
                      ) : stageStatus === 'failed' || stageStatus === 'stopped' ? (
                        <p className="text-sm text-muted-foreground">Use the {stageStatus === 'stopped' ? 'restart' : 'retry'} button above to continue</p>
                      ) : artifacts.length === 0 ? (
                        <>
                          <div className="w-10 h-10 border-4 border-primary/30 border-t-primary rounded-full animate-spin mb-4 mx-auto" />
                          <p className="text-sm font-medium">Starting OpenSpec…</p>
                          <p className="text-xs text-muted-foreground mt-1">Stage: <strong>{feature.current_stage_id ?? 'initializing'}</strong></p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">Select an artifact from the left panel</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* AI Chat panel — vertical side-dock inside the center panel, LEFT of the discussion column.
                Horizontal drag handle on the left edge resizes it. */}
            {chatMode === 'side' && (
              <div
                className="flex-shrink-0 border-l border-border overflow-hidden flex flex-row bg-background"
                style={{ width: chatSideWidth }}
              >
                {/* Vertical resize handle */}
                <div
                  className="w-1.5 cursor-col-resize bg-border/40 hover:bg-primary/30 transition-colors flex-shrink-0 group flex items-center"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    chatSideDragRef.current = { startX: e.clientX, startW: chatSideWidth }
                    const onMove = (ev: MouseEvent) => {
                      if (!chatSideDragRef.current) return
                      const delta = chatSideDragRef.current.startX - ev.clientX
                      setChatSideWidth(Math.max(260, Math.min(900, chatSideDragRef.current.startW + delta)))
                    }
                    const onUp = () => {
                      chatSideDragRef.current = null
                      window.removeEventListener('mousemove', onMove)
                      window.removeEventListener('mouseup', onUp)
                    }
                    window.addEventListener('mousemove', onMove)
                    window.addEventListener('mouseup', onUp)
                  }}
                >
                  <div className="w-0.5 h-8 mx-auto rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
                </div>
                <div className="flex-1 overflow-hidden min-w-0">
                  <ArtifactChat
                    featureId={feature.id}
                    artifact={activeArtifact}
                    onArtifactUpdated={applyArtifactUpdateBySlug}
                    canClearChat={feature.creator_id === user?.id}
                    mode="side"
                    onToggleMode={() => setChatMode('dock')}
                    onClose={() => setChatMode('closed')}
                    draft={chatDraft}
                    onDraftConsumed={() => setChatDraft(null)}
                  />
                </div>
              </div>
            )}
            </div>

            {/* AI Chat panel — resizable bottom strip (docked mode) */}
            {chatMode === 'dock' && (
              <div className="flex-shrink-0 border-t border-border overflow-hidden flex flex-col" style={{ height: chatHeight }}>
                {/* Resize handle */}
                <div
                  className="h-1.5 cursor-row-resize bg-border/40 hover:bg-primary/30 transition-colors flex-shrink-0 group"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    chatDragRef.current = { startY: e.clientY, startH: chatHeight }
                    const onMove = (ev: MouseEvent) => {
                      if (!chatDragRef.current) return
                      const delta = chatDragRef.current.startY - ev.clientY
                      setChatHeight(Math.max(160, Math.min(600, chatDragRef.current.startH + delta)))
                    }
                    const onUp = () => {
                      chatDragRef.current = null
                      window.removeEventListener('mousemove', onMove)
                      window.removeEventListener('mouseup', onUp)
                    }
                    window.addEventListener('mousemove', onMove)
                    window.addEventListener('mouseup', onUp)
                  }}
                >
                  <div className="h-0.5 w-8 mx-auto mt-0.5 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
                </div>
                <div className="flex-1 overflow-hidden">
                  <ArtifactChat
                    featureId={feature.id}
                    artifact={activeArtifact}
                    onArtifactUpdated={applyArtifactUpdateBySlug}
                    canClearChat={feature.creator_id === user?.id}
                    mode="dock"
                    onToggleMode={() => setChatMode('side')}
                    onClose={() => setChatMode('closed')}
                    draft={chatDraft}
                    onDraftConsumed={() => setChatDraft(null)}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Bottom bar */}
          <div className="border-t border-border px-3 py-2 flex flex-col gap-2 bg-background flex-shrink-0">
            {/* Approval status row — shown at final planning stage */}
            {isApprovalStage && approvals.length > 0 && feature.status !== 'committed' && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">Approvals:</span>
                {approvals.map((a) => (
                  <span
                    key={a.user_id}
                    title={`${a.email}${a.approved_at ? ` · ${new Date(a.approved_at).toLocaleString()}` : ''}`}
                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                      a.verdict === 'approved'
                        ? 'border-green-300 bg-green-50 text-green-700'
                        : 'border-amber-300 bg-amber-50 text-amber-700'
                    }`}
                  >
                    {a.verdict === 'approved' ? '✓' : '○'} {a.name.split(' ')[0]}
                  </span>
                ))}
                {(() => {
                  const iApproved = myApproval?.verdict === 'approved'
                  const disabled = approving || iApproved || quorumMet
                  const label = approving
                    ? 'Approving…'
                    : iApproved
                      ? '✓ You approved'
                      : quorumMet
                        ? `Quorum met (${approvedCount}/${effectiveQuorum})`
                        : `Approve plan (${approvedCount}/${effectiveQuorum})`
                  return (
                    <button
                      onClick={handleApprove}
                      disabled={disabled}
                      title={iApproved ? 'You have already approved this plan.' : quorumMet ? 'Quorum reached — no more approvals needed.' : ''}
                      className={`ml-1 px-3 py-0.5 rounded text-sm font-medium transition-colors ${
                        disabled
                          ? 'bg-secondary text-muted-foreground cursor-not-allowed'
                          : 'bg-blue-600 text-white hover:bg-blue-700'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })()}
              </div>
            )}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span>{artifacts.length} artifacts</span>
                {feature.committed_sha && (
                  <span className="text-green-600 font-mono">✓ {feature.committed_sha.slice(0, 7)}</span>
                )}
                <button
                  onClick={() => setChatMode((m) => m === 'closed' ? 'side' : 'closed')}
                  className={`px-2 py-0.5 rounded text-sm transition-colors ${
                    chatMode !== 'closed' ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
                  }`}
                >
                  AI Chat
                </button>
                {artifacts.length > 0 && (
                  <button
                    onClick={handleViewPlan}
                    disabled={planLoading}
                    className="px-2 py-0.5 rounded text-sm hover:bg-accent transition-colors disabled:opacity-50"
                  >
                    {planLoading ? 'Loading…' : 'View Plan'}
                  </button>
                )}
              </div>
              {feature.status !== 'committed' && isApprovalStage && (
                <button
                  onClick={handleCommit}
                  disabled={!canCommit || committing || !feature.plan_branch}
                  className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
                    canCommit && feature.plan_branch
                      ? 'bg-green-600 text-white hover:bg-green-700'
                      : 'bg-secondary text-muted-foreground cursor-not-allowed'
                  }`}
                  title={
                    !feature.plan_branch ? 'No repo connected' :
                    !quorumMet ? `Waiting for approval (${approvedCount}/${effectiveQuorum})` :
                    !isApprovalStage ? 'Complete the technical stage first' : ''
                  }
                >
                  {committing ? 'Committing…' : 'Commit plan to branch'}
                </button>
              )}
              {feature.status === 'committed' && (
                <span className="text-sm text-green-600 font-medium">
                  ✓ Committed to {feature.plan_branch}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="w-72 flex-shrink-0 flex flex-col overflow-hidden">
          <PresenceBar users={remoteUsers} selfName={user?.name ?? 'You'} />
          <div className="flex-1 overflow-hidden">
            <DiscussionPanel
              featureId={feature.id}
              artifactId={activeArtifact?.id}
              currentUserId={user?.id}
              featureCreatorId={feature.creator_id}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
