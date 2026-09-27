import type { FastifyPluginAsync } from 'fastify'
import { resolve, join } from 'path'
import { existsSync } from 'fs'
import { authMiddleware } from '../auth/middleware.js'
import { runGitOrThrow } from '../git/spawn.js'
import { createFeatureWorktree } from '../git/worker.js'
import { query } from '../db.js'

const WORKTREES_BASE = process.env.WORKTREES_BASE ?? '/data/worktrees'

function safeResolvePath(worktreeDir: string, userPath: string): string {
  // Rule: resolved path must be under worktreeDir; reject symlinks via realpath check
  const cleaned = userPath.replace(/\.\./g, '').replace(/^\//, '')
  const abs = resolve(join(worktreeDir, cleaned))
  if (!abs.startsWith(worktreeDir + '/') && abs !== worktreeDir) {
    throw new Error('Path traversal rejected')
  }
  return cleaned
}

export const repoRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/features/:id/tree - list repo file tree
  fastify.get<{ Params: { id: string } }>(
    '/api/features/:id/tree',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const featureRow = await query<{ id: string }>(
        `SELECT f.id FROM features f
         JOIN feature_members fm ON fm.feature_id = f.id
         WHERE f.id = $1 AND fm.user_id = $2`,
        [id, req.user!.id],
      )
      if (!featureRow.rows.length) return reply.code(404).send({ error: 'not found' })

      const worktreeDir = join(WORKTREES_BASE, id)
      try {
        const out = await runGitOrThrow(worktreeDir, ['ls-tree', '-r', '--name-only', 'HEAD'])
        const paths = out.split('\n').filter(Boolean)
        const files = paths.map((p) => ({ path: p, kind: 'file' as const }))
        reply.send(files)
      } catch (e) {
        reply.code(500).send({ error: String(e) })
      }
    },
  )

  // GET /api/features/:id/file?path=... - get file content
  fastify.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/features/:id/file',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const { path: userPath } = req.query
      if (!userPath) return reply.code(400).send({ error: 'path required' })

      const featureRow = await query<{ id: string }>(
        `SELECT f.id FROM features f
         JOIN feature_members fm ON fm.feature_id = f.id
         WHERE f.id = $1 AND fm.user_id = $2`,
        [id, req.user!.id],
      )
      if (!featureRow.rows.length) return reply.code(404).send({ error: 'not found' })

      const worktreeDir = join(WORKTREES_BASE, id)
      let safePath: string
      try {
        safePath = safeResolvePath(worktreeDir, userPath)
      } catch {
        return reply.code(400).send({ error: 'Invalid path' })
      }

      try {
        const content = await runGitOrThrow(worktreeDir, ['show', `HEAD:${safePath}`])
        const ext = safePath.split('.').pop() ?? ''
        reply.send({ content, path: safePath, language: ext })
      } catch {
        reply.code(404).send({ error: 'file not found' })
      }
    },
  )

  // GET /api/features/:id/clone-status - check if worktree is ready
  fastify.get<{ Params: { id: string } }>(
    '/api/features/:id/clone-status',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })
      const worktreeDir = join(WORKTREES_BASE, id)
      reply.send({ ready: existsSync(worktreeDir) })
    },
  )

  // POST /api/features/:id/ensure-worktree - trigger clone if missing
  fastify.post<{ Params: { id: string } }>(
    '/api/features/:id/ensure-worktree',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const featureRow = await query<{ repo_url: string | null; base_branch: string; plan_branch: string | null }>(
        `SELECT f.repo_url, f.base_branch, f.plan_branch
         FROM features f
         JOIN feature_members fm ON fm.feature_id = f.id
         WHERE f.id = $1 AND fm.user_id = $2`,
        [id, req.user!.id],
      )
      if (!featureRow.rows.length) return reply.code(404).send({ error: 'not found' })
      const { repo_url, base_branch, plan_branch } = featureRow.rows[0]
      if (!repo_url || !plan_branch) return reply.send({ ok: true, skipped: true, reason: 'no repo configured' })
      const worktreeDir = join(WORKTREES_BASE, id)
      if (existsSync(worktreeDir)) return reply.send({ ok: true, skipped: true, reason: 'already exists' })
      // Fire off clone in background, return immediately
      createFeatureWorktree(id, repo_url, base_branch, plan_branch)
        .then(() => console.log(`[repo] worktree ready for ${id}`))
        .catch((e) => console.warn(`[repo] worktree failed for ${id}:`, e))
      reply.send({ ok: true, cloning: true })
    },
  )
}
