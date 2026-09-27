import { useState, useEffect } from 'react'

export interface User {
  id: string
  email: string
  name: string
}

interface SessionState {
  user: User | null
  loading: boolean
  refetch: () => Promise<void>
}

export function useSession(): SessionState {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  // initialLoad distinguishes the first fetch (show full-screen spinner) from
  // subsequent refetches triggered after login (don't flash the spinner).
  const initialLoad = loading && user === null

  const refetch = (): Promise<void> => {
    return fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => setUser(data))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    setLoading(true)
    refetch()
  }, [])

  return { user, loading: initialLoad, refetch }
}
