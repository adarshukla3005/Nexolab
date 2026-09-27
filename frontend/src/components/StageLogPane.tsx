import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api.js'

interface LogEntry {
  step_id: string
  tool_name: string
  status: string
  created_at: string
  completed_at: string | null
}

interface StageLogPaneProps {
  featureId: string
  stageSlug: string | null
  stageStatus?: string | null
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function formatDuration(startIso: string, endIso: string | null, nowMs: number): string {
  const endMs = endIso ? new Date(endIso).getTime() : nowMs
  const ms = endMs - new Date(startIso).getTime()
  if (ms < 0) return '…'
  if (ms < 1000) return `${ms}ms`
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `${mins}m ${rem.toString().padStart(2, '0')}s`
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'succeeded') return <span className="text-green-500">✓</span>
  if (status === 'failed') return <span className="text-red-500">✗</span>
  return <span className="text-amber-400 animate-pulse">⟳</span>
}

export function StageLogPane({ featureId, stageSlug, stageStatus }: StageLogPaneProps) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const isLive = stageStatus === 'running' || stageStatus === 'parked'
  const hasPending = logs.some((l) => l.status === 'pending')
  const nowMs = useNow(isLive || hasPending)

  useEffect(() => {
    if (!stageSlug) { setLogs([]); return }

    const load = () => {
      api.get<LogEntry[]>(`/api/features/${featureId}/stages/${stageSlug}/logs`)
        .then((rows) => setLogs(rows))
        .catch(() => {})
    }

    load()
    if (!isLive) return

    const interval = setInterval(load, 3_000)
    return () => clearInterval(interval)
  }, [featureId, stageSlug, isLive])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  if (!stageSlug) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-xs text-muted-foreground">Select a stage to view logs</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[#1a1a2e] text-[#e0e0e0] font-mono text-xs overflow-hidden">
      <div className="px-3 py-1.5 border-b border-white/10 flex items-center gap-2 flex-shrink-0">
        <span className="text-[#888]">stage:</span>
        <span className="text-[#7eb8f7]">{stageSlug}</span>
        {isLive && <span className="ml-auto text-amber-400 animate-pulse text-xs">● LIVE</span>}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {logs.length === 0 ? (
          <p className="text-[#666] py-2">No tool calls yet</p>
        ) : logs.map((log, i) => (
          <div key={i} className="flex items-center gap-2 py-0.5">
            <StatusIcon status={log.status} />
            <span className={`flex-1 truncate ${log.status === 'failed' ? 'text-red-400' : ''}`}>
              {log.step_id || log.tool_name}
            </span>
            <span className={`flex-shrink-0 text-xs tabular-nums ${log.status === 'pending' ? 'text-amber-400' : 'text-[#666]'}`}>
              {formatDuration(log.created_at, log.completed_at, nowMs)}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
