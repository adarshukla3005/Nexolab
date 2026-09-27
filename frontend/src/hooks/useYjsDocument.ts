import { useEffect, useRef, useState, useCallback } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

export interface RemoteUser {
  id: string
  name: string
  color: string
  cursor?: unknown
}

interface YjsDocState {
  doc: Y.Doc | null
  provider: WebsocketProvider | null
  synced: boolean
  remoteUsers: RemoteUser[]
  awareness: WebsocketProvider['awareness'] | null
}

// Stable color per user
const USER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22']
function userColor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff
  return USER_COLORS[Math.abs(h) % USER_COLORS.length]
}

export function useYjsDocument(featureId: string | null, user: { id: string; name: string } | null): YjsDocState {
  const docRef = useRef<Y.Doc | null>(null)
  const providerRef = useRef<WebsocketProvider | null>(null)
  const [synced, setSynced] = useState(false)
  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([])

  useEffect(() => {
    if (!featureId || !user) return

    const doc = new Y.Doc()
    docRef.current = doc

    // y-websocket appends the room name as a URL segment: baseUrl/room
    // Backend listens at /yjs/:featureId, so pass featureId in the base URL
    // and use empty string as room to avoid double-appending the id.
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/yjs`
    const provider = new WebsocketProvider(wsUrl, featureId, doc, {
      params: { token: document.cookie.match(/session=([^;]+)/)?.[1] ?? '' },
    })
    providerRef.current = provider

    provider.on('sync', (isSynced: boolean) => setSynced(isSynced))

    provider.awareness.setLocalStateField('user', {
      id: user.id,
      name: user.name,
      color: userColor(user.id),
    })

    provider.awareness.on('change', () => {
      const states = Array.from(provider.awareness.getStates().entries())
      const seen = new Set<string>()
      const remote: RemoteUser[] = []
      for (const [clientId, state] of states) {
        if (clientId === provider.awareness.clientID) continue
        if (!state.user) continue
        const u = state.user as RemoteUser
        // Deduplicate by user.id — same person with multiple tabs should appear once
        if (seen.has(u.id)) continue
        seen.add(u.id)
        remote.push(u)
      }
      setRemoteUsers(remote)
    })

    return () => {
      provider.destroy()
      doc.destroy()
      docRef.current = null
      providerRef.current = null
      setSynced(false)
      setRemoteUsers([])
    }
  }, [featureId, user?.id])

  return {
    doc: docRef.current,
    provider: providerRef.current,
    synced,
    remoteUsers,
    awareness: providerRef.current?.awareness ?? null,
  }
}
