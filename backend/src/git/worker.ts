import { existsSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join, resolve, relative } from 'path'
import { createHash } from 'crypto'
import { runGitOrThrow, runGit, type GitIdentity } from './spawn.js'
import { detectGitHub, resolveCloneUrl as githubCloneUrl } from './providers/github.js'
import { detectGitLab, resolveCloneUrl as gitlabCloneUrl } from './providers/gitlab.js'

const REPOS_BASE = process.env.REPOS_BASE ?? '/data/repos'
const WORKTREES_BASE = process.env.WORKTREES_BASE ?? '/data/worktrees'

function repoHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16)
}

export function resolveProvider(url: string): { cloneUrl: string; provider: string } {
  if (detectGitHub(url)) {
    return { cloneUrl: githubCloneUrl(url), provider: 'github' }
  }
  if (detectGitLab(url)) {
    return { cloneUrl: gitlabCloneUrl(url), provider: 'gitlab' }
  }
  throw new Error(`Unsupported git provider for URL: ${url}. Only GitHub and GitLab are supported in v1.`)
}

export async function ensureBareClone(repoUrl: string): Promise<string> {
  const { cloneUrl } = resolveProvider(repoUrl)
  const bareDir = join(REPOS_BASE, repoHash(repoUrl))
  await mkdir(bareDir, { recursive: true })

  if (!existsSync(join(bareDir, 'HEAD'))) {
    await runGitOrThrow(REPOS_BASE, ['clone', '--bare', cloneUrl, bareDir])
  } else {
    // Update the bare clone
    await runGit(bareDir, ['fetch', '--all', '--prune'])
  }
  return bareDir
}

// Returns a branch that actually exists in the bare clone, or null if the repo is empty.
// Priority: requested branch → main → master → remote HEAD → first local ref.
async function resolveBaseBranch(bareDir: string, requested: string): Promise<string | null> {
  const exists = async (b: string) =>
    (await runGit(bareDir, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`])).code === 0
  if (await exists(requested)) return requested
  if (requested !== 'main' && await exists('main')) return 'main'
  if (requested !== 'master' && await exists('master')) return 'master'
  // Ask origin for its default branch (usually "refs/remotes/origin/HEAD -> origin/<branch>").
  const headRef = await runGit(bareDir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  if (headRef.code === 0 && headRef.stdout) {
    const match = headRef.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/)
    const b = match?.[1]
    if (b && await exists(b)) return b
  }
  // Last-ditch: any branch at all.
  const anyRef = await runGit(bareDir, ['for-each-ref', '--count=1', '--format=%(refname:short)', 'refs/heads/'])
  if (anyRef.code === 0 && anyRef.stdout.trim()) return anyRef.stdout.trim()
  return null
}

export async function createFeatureWorktree(
  featureId: string,
  repoUrl: string,
  baseBranch: string,
  planBranch: string,
): Promise<string> {
  const bareDir = await ensureBareClone(repoUrl)
  const worktreeDir = join(WORKTREES_BASE, featureId)
  await mkdir(WORKTREES_BASE, { recursive: true })

  if (existsSync(worktreeDir)) {
    return worktreeDir
  }

  // Resolve the base branch: try the requested one first, then main, then master, then the
  // remote HEAD, then any local ref. Only if the bare clone has NO branches at all do we
  // bootstrap an orphan commit. This handles repos where `master` is the default (not `main`).
  const resolvedBase = await resolveBaseBranch(bareDir, baseBranch)

  if (!resolvedBase) {
    // Truly empty repo — bootstrap with orphan commit
    await mkdir(worktreeDir, { recursive: true })
    await runGitOrThrow(worktreeDir, ['init'])
    await runGitOrThrow(worktreeDir, ['checkout', '--orphan', baseBranch])
    await writeFile(join(worktreeDir, '.gitkeep'), '')
    await runGitOrThrow(worktreeDir, ['add', '.gitkeep'])
    await runGitOrThrow(worktreeDir, ['commit', '-m', 'init: empty root commit'], {
      email: 'collab-dlc@localhost',
      name: 'Nexolab OpenSpec',
    })
    await runGitOrThrow(worktreeDir, ['checkout', '-b', planBranch])
  } else {
    // In a bare clone, branches are refs/heads/<branch> — use bare branch name directly
    await runGitOrThrow(bareDir, [
      'worktree', 'add',
      '-B', planBranch,
      worktreeDir,
      resolvedBase,
    ])
    // If we fell back to a different branch than requested, persist it so commit path
    // pushes back to the branch that actually exists on the remote.
    if (resolvedBase !== baseBranch) {
      console.log(`[worker] feature ${featureId} — base branch "${baseBranch}" not found, using "${resolvedBase}" instead`)
      const { query } = await import('../db.js')
      await query(
        `UPDATE features SET base_branch = $1 WHERE id = $2`,
        [resolvedBase, featureId],
      )
    }
  }

  return worktreeDir
}

export async function commitPlan(params: {
  featureId: string
  planBranch: string
  files: Array<{ path: string; content: string }>
  commitMessage: string
  identity: GitIdentity
}): Promise<string> {
  const { featureId, planBranch, files, commitMessage, identity } = params
  const worktreeDir = join(WORKTREES_BASE, featureId)

  if (!existsSync(worktreeDir)) {
    throw new Error(`Worktree not found for feature ${featureId}`)
  }

  // Check if branch has diverged from remote (skip if branch doesn't exist on remote yet)
  const fetchResult = await runGit(worktreeDir, ['fetch', 'origin', planBranch])
  if (fetchResult.code === 0) {
    // Branch exists on remote — check for divergence
    const diverge = await runGit(worktreeDir, ['rev-list', '--count', `HEAD..origin/${planBranch}`])
    if (diverge.code === 0 && diverge.stdout && parseInt(diverge.stdout.trim(), 10) > 0) {
      throw new Error(`Branch has diverged from remote — cannot commit. Please reconcile first.`)
    }
  }

  // Write files
  for (const f of files) {
    const abs = resolve(worktreeDir, f.path)
    // Path safety: ensure resolved path is under worktree
    if (!abs.startsWith(worktreeDir + '/') && abs !== worktreeDir) {
      throw new Error(`Path traversal rejected: ${f.path}`)
    }
    const dir = abs.substring(0, abs.lastIndexOf('/'))
    await mkdir(dir, { recursive: true })
    await writeFile(abs, f.content, 'utf8')
  }

  // Stage and commit — skip commit if nothing changed (idempotent re-commit)
  await runGitOrThrow(worktreeDir, ['add', '.'])
  const statusOut = await runGit(worktreeDir, ['status', '--porcelain'])
  if (statusOut.stdout.trim()) {
    await runGitOrThrow(worktreeDir, ['commit', '-m', commitMessage], identity)
  }

  // Push with retry — push directly to the authenticated URL (token in argv of child process,
  // never in a shell string). Using x-access-token:<PAT> is standard for GitHub/GitLab CI pushes.
  const token = process.env.GIT_TOKEN
  const remoteUrl = (await runGit(worktreeDir, ['remote', 'get-url', 'origin'])).stdout.trim()
  const authedUrl = token
    ? remoteUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`)
    : remoteUrl

  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Push directly to the authed URL (bypasses remote name resolution so token is used)
    const result = await runGit(worktreeDir, ['push', authedUrl, `HEAD:refs/heads/${planBranch}`])
    if (result.code === 0) {
      lastErr = null
      break
    }
    // Redact token from error before throwing
    const redacted = result.stderr.replace(token ?? '__none__', '[REDACTED]')
    lastErr = new Error(redacted)
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt))
  }
  if (lastErr) throw lastErr

  // Verify push
  const sha = await runGitOrThrow(worktreeDir, ['rev-parse', 'HEAD'])
  return sha
}
