import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { toast } from 'sonner'

type Tab = 'signin' | 'signup' | 'magic'

export function Login({ refetch }: { refetch: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('signin')
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const next = searchParams.get('next')
  const isInvite = next?.includes('/features/')

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md p-8 border border-border rounded-lg shadow-sm bg-card">
        <div className="flex items-center gap-3 mb-4">
          <svg width="36" height="36" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="8" fill="hsl(var(--primary))"/>
            <circle cx="11" cy="13" r="5" fill="white" fillOpacity="0.9"/>
            <circle cx="21" cy="13" r="5" fill="white" fillOpacity="0.55"/>
            <circle cx="16" cy="21" r="4" fill="white" fillOpacity="0.75"/>
            <circle cx="16" cy="15" r="1.5" fill="hsl(var(--primary))"/>
          </svg>
          <h1 className="text-2xl font-bold">Nexolab</h1>
        </div>

        {isInvite && (
          <div className="mb-5 px-4 py-3 rounded-lg bg-primary/8 border border-primary/20 flex items-start gap-3">
            <span className="text-lg mt-0.5">🔗</span>
            <div>
              <p className="text-sm font-semibold text-primary">You've been invited to a workspace</p>
              <p className="text-xs text-muted-foreground mt-0.5">Sign in and you'll be taken directly to the shared feature plan.</p>
            </div>
          </div>
        )}

        <div className="flex border-b border-border mb-6">
          {(['signin', 'signup', 'magic'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'signin' ? 'Sign in' : t === 'signup' ? 'Sign up' : 'Magic link'}
            </button>
          ))}
        </div>

        {tab === 'signin' && <SignInForm next={next} navigate={navigate} refetch={refetch} />}
        {tab === 'signup' && <SignUpForm next={next} navigate={navigate} refetch={refetch} />}
        {tab === 'magic' && <MagicLinkForm next={next} />}
      </div>
    </div>
  )
}

function SignInForm({ next, navigate, refetch }: { next: string | null; navigate: (path: string) => void; refetch: () => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await api.post('/api/auth/login', { email, password })
      await refetch()
      navigate(next && next.startsWith('/') ? next : '/')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Email address</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Password</label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={loading || !email || !password}
        className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md font-medium text-sm disabled:opacity-50 hover:opacity-90 transition-opacity"
      >
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

function SignUpForm({ next, navigate, refetch }: { next: string | null; navigate: (path: string) => void; refetch: () => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) { toast.error('Passwords do not match'); return }
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return }
    setLoading(true)
    try {
      await api.post('/api/auth/signup', { email, name, password })
      await refetch()
      navigate(next && next.startsWith('/') ? next : '/')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Your name</label>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Priya Kumar"
          className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Email address</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Password</label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Confirm password</label>
        <input
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••"
          className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={loading || !email || !name || !password || !confirm}
        className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md font-medium text-sm disabled:opacity-50 hover:opacity-90 transition-opacity"
      >
        {loading ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  )
}

function MagicLinkForm({ next }: { next: string | null }) {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sentLink, setSentLink] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await api.post<{ ok: boolean; link?: string }>('/api/auth/request', { email, next: next ?? undefined })
      setSentLink(res.link ?? null)
    } catch (err) {
      toast.error(String(err))
    } finally {
      setLoading(false)
    }
  }

  if (sentLink) {
    return (
      <div className="text-center py-2">
        <div className="text-4xl mb-4">📧</div>
        <p className="font-medium">Magic link ready</p>
        <p className="text-muted-foreground text-sm mt-1 mb-4">
          Sent to <strong>{email}</strong>
        </p>
        <div className="border border-border rounded-md p-3 bg-secondary/30 text-left">
          <p className="text-xs text-muted-foreground mb-1 font-medium">Your login link:</p>
          <a
            href={sentLink}
            className="text-xs text-primary break-all hover:underline"
          >
            {sentLink}
          </a>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Also saved to <code className="font-mono text-xs">/data/user-credentials/</code>
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Enter your email and we'll send you a one-click sign-in link.
      </p>
      <div>
        <label className="block text-sm font-medium mb-1">Email address</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <button
        type="submit"
        disabled={loading || !email}
        className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md font-medium text-sm disabled:opacity-50 hover:opacity-90 transition-opacity"
      >
        {loading ? 'Sending…' : 'Send magic link'}
      </button>
    </form>
  )
}
