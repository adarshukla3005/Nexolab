import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Toaster } from 'sonner'
import type { User } from './hooks/useSession.js'
import { useSession } from './hooks/useSession.js'
import { FeatureList } from './pages/FeatureList.js'
import { NewFeature } from './pages/NewFeature.js'
import { Workspace } from './pages/Workspace.js'
import { Login } from './pages/Login.js'

// Receives user from parent so there is only one session fetch for the whole app
function RequireAuth({ user, children }: { user: User | null; children: React.ReactNode }) {
  const location = useLocation()

  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }

  return <>{children}</>
}

export function App() {
  const { user, loading, refetch } = useSession()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground animate-pulse">Loading…</div>
      </div>
    )
  }

  return (
    <>
      <Toaster richColors position="top-right" />
      <Routes>
        <Route path="/login" element={!user ? <Login refetch={refetch} /> : <Navigate to="/" replace />} />
        <Route path="/" element={<RequireAuth user={user}><FeatureList /></RequireAuth>} />
        <Route path="/features/new" element={<RequireAuth user={user}><NewFeature /></RequireAuth>} />
        <Route path="/features/:id" element={<RequireAuth user={user}><Workspace /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
