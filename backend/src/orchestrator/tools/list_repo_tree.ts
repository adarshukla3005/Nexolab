import { join } from 'path'
import { query } from '../../db.js'
import { runGitOrThrow } from '../../git/spawn.js'
import type { ToolHandler } from '../tool-registry.js'

const WORKTREES_BASE = process.env.WORKTREES_BASE ?? '/data/worktrees'

export const schema = {
  type: 'function' as const,
  function: {
    name: 'list_repo_tree',
    description: 'List all files in the connected repository. Returns a flat list of file paths. Use this to understand the existing codebase structure before generating plans.',
    parameters: {
      type: 'object',
      properties: {
        prefix: {
          type: 'string',
          description: 'Optional path prefix to filter results (e.g. "src/" to only list source files)',
        },
      },
    },
  },
}

export const handler: ToolHandler = async (args, ctx) => {
  const { prefix } = args as { prefix?: string }

  const featureRow = await query<{ repo_id: string | null }>(
    'SELECT repo_id FROM features WHERE id = $1',
    [ctx.featureId],
  )
  if (!featureRow.rows.length || !featureRow.rows[0].repo_id) {
    return { error: 'No repository connected to this feature. Cannot read repo files.' }
  }

  const worktreeDir = join(WORKTREES_BASE, ctx.featureId)
  try {
    const out = await runGitOrThrow(worktreeDir, ['ls-tree', '-r', '--name-only', 'HEAD'])
    const paths = out.split('\n').filter(Boolean)
    const filtered = prefix ? paths.filter((p) => p.startsWith(prefix)) : paths
    const capped = filtered.slice(0, 60)
    return { files: capped, total: filtered.length, shown: capped.length }
  } catch (e) {
    return { error: `Repository not ready: ${String(e)}` }
  }
}
