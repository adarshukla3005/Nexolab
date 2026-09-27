import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { toast } from 'sonner'

export function NewFeature() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    title: '',
    prompt: '',
    repo_url: '',
    base_branch: 'main',
    quorum_size: 2,
  })
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const validate = () => {
    const e: Record<string, string> = {}
    if (!form.title.trim()) e.title = 'Title is required'
    if (!form.prompt.trim()) e.prompt = 'Feature description is required'
    if (form.quorum_size < 1) e.quorum_size = 'Must be at least 1'
    return e
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs = validate()
    if (Object.keys(errs).length) { setErrors(errs); return }
    setLoading(true)
    try {
      const result = await api.post<{ id: string }>('/api/features', form)
      toast.success('Feature created — OpenSpec workflow starting…')
      navigate(`/features/${result.id}`)
    } catch (err) {
      toast.error(String(err))
    } finally {
      setLoading(false)
    }
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((p) => ({ ...p, [key]: e.target.value })),
  })

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-3 flex items-center gap-4">
        <Link to="/" className="text-muted-foreground hover:text-foreground text-sm flex items-center gap-1.5">
          <svg width="22" height="22" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="32" height="32" rx="8" fill="hsl(var(--primary))"/>
            <circle cx="11" cy="13" r="5" fill="white" fillOpacity="0.9"/>
            <circle cx="21" cy="13" r="5" fill="white" fillOpacity="0.55"/>
            <circle cx="16" cy="21" r="4" fill="white" fillOpacity="0.75"/>
            <circle cx="16" cy="15" r="1.5" fill="hsl(var(--primary))"/>
          </svg>
          <span className="font-semibold text-foreground">Nexolab</span>
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-sm font-medium">New feature</h1>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8">
        <p className="text-muted-foreground text-sm mb-6">
          Describe your feature intent. Nexolab will walk your team through 9 AI-driven planning stages.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-medium mb-1">Feature title <span className="text-red-500">*</span></label>
            <input
              type="text"
              {...field('title')}
              placeholder="User authentication system"
              className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {errors.title && <p className="text-red-500 text-xs mt-1">{errors.title}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Feature description <span className="text-red-500">*</span></label>
            <textarea
              {...field('prompt')}
              rows={6}
              placeholder="Describe what you want to build, the problem it solves, and who it's for…"
              className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
            {errors.prompt && <p className="text-red-500 text-xs mt-1">{errors.prompt}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Git repo URL (optional)</label>
              <input
                type="url"
                {...field('repo_url')}
                placeholder="https://github.com/org/repo"
                className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {form.repo_url.trim() ? (
                <div className="mt-1.5 flex items-start gap-1.5 text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded px-2 py-1.5">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="flex-shrink-0 mt-0.5"><polyline points="20 6 9 17 4 12"/></svg>
                  <span><strong>Brownfield mode</strong> — AI will clone and analyse your repo before planning, so all artifacts fit your existing architecture.</span>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground mt-1">Add a GitHub/GitLab URL to plan against your existing codebase</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Base branch</label>
              <input
                type="text"
                {...field('base_branch')}
                placeholder="main"
                className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="max-w-xs">
            <label className="block text-sm font-medium mb-1">Approval quorum</label>
            <input
              type="number"
              min={1}
              max={8}
              {...field('quorum_size')}
              className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground mt-1">Number of approvals needed to advance each stage</p>
            {errors.quorum_size && <p className="text-red-500 text-xs mt-1">{errors.quorum_size}</p>}
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="px-6 py-2 bg-primary text-primary-foreground rounded-md font-medium text-sm disabled:opacity-50 hover:opacity-90"
            >
              {loading ? 'Creating…' : 'Start planning'}
            </button>
            <Link to="/" className="px-4 py-2 border border-border rounded-md text-sm hover:bg-accent">
              Cancel
            </Link>
          </div>
        </form>
      </main>
    </div>
  )
}
