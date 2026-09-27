import { join, resolve } from 'path'
import { query } from '../../db.js'
import { runGitOrThrow } from '../../git/spawn.js'
import type { ToolHandler } from '../tool-registry.js'

const WORKTREES_BASE = process.env.WORKTREES_BASE ?? '/data/worktrees'
const MAX_BYTES = 3_000 // ~3KB per file — keeps context manageable across multiple reads

export const schema = {
  type: 'function' as const,
  function: {
    name: 'read_repo_file',
    description: 'Read the content of a specific file from the connected repository. Use list_repo_tree first to find valid paths. Useful for understanding existing code patterns, architecture, and conventions.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to repo root (e.g. "src/index.ts", "package.json")',
        },
      },
    },
  },
}

export const handler: ToolHandler = async (args, ctx) => {
  const { path: userPath } = args as { path: string }
  if (!userPath) return { error: 'path required' }

  const featureRow = await query<{ repo_id: string | null }>(
    'SELECT repo_id FROM features WHERE id = $1',
    [ctx.featureId],
  )
  if (!featureRow.rows.length || !featureRow.rows[0].repo_id) {
    return { error: 'No repository connected to this feature. Cannot read repo files.' }
  }

  // Sanitize path — reject traversals
  const worktreeDir = join(WORKTREES_BASE, ctx.featureId)
  const cleaned = userPath.replace(/\.\./g, '').replace(/^\//, '')
  const abs = resolve(join(worktreeDir, cleaned))
  if (!abs.startsWith(worktreeDir + '/') && abs !== worktreeDir) {
    return { error: 'Invalid path: path traversal rejected' }
  }

  try {
    const content = await runGitOrThrow(worktreeDir, ['show', `HEAD:${cleaned}`])
    const truncated = content.length > MAX_BYTES
    return {
      path: cleaned,
      content: truncated ? content.slice(0, MAX_BYTES) + '\n... [truncated — file too large]' : content,
      lines: content.split('\n').length,
      truncated,
    }
  } catch {
    return { error: `File not found: ${cleaned}` }
  }
}
