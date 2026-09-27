import type { FastifyPluginAsync } from 'fastify'
import { query } from '../db.js'
import { authMiddleware } from '../auth/middleware.js'

export const discussionsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/features/:id/discussions
  fastify.get<{ Params: { id: string }; Querystring: { artifact_id?: string } }>(
    '/api/features/:id/discussions',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const { artifact_id } = req.query
      const params: unknown[] = [id, req.user!.id]
      let filter = ''
      if (artifact_id) { filter = `AND d.artifact_id = $3`; params.push(artifact_id) }

      const rows = await query<{ id: string; artifact_id: string | null; title: string | null; resolved: boolean; created_at: Date; created_by: string }>(
        `SELECT d.id, d.artifact_id, d.title, d.resolved, d.created_at, d.created_by
         FROM discussions d
         JOIN feature_members fm ON fm.feature_id = d.feature_id
         WHERE d.feature_id = $1 AND fm.user_id = $2 ${filter}
         ORDER BY d.created_at DESC`,
        params,
      )
      reply.send(rows.rows)
    },
  )

  // PATCH /api/discussions/:id — edit thread title. Only the author can edit.
  fastify.patch<{ Params: { id: string }; Body: { title?: string; resolved?: boolean } }>(
    '/api/discussions/:id',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const { title, resolved } = req.body ?? {}
      if (title === undefined && resolved === undefined) {
        return reply.code(400).send({ error: 'title or resolved required' })
      }

      const row = await query<{ created_by: string; feature_id: string }>(
        `SELECT d.created_by, d.feature_id
         FROM discussions d
         JOIN feature_members fm ON fm.feature_id = d.feature_id
         WHERE d.id = $1 AND fm.user_id = $2`,
        [id, req.user!.id],
      )
      if (!row.rows.length) return reply.code(404).send({ error: 'not found' })
      if (row.rows[0].created_by !== req.user!.id) {
        return reply.code(403).send({ error: 'Only the thread author can edit it.' })
      }

      await query(
        `UPDATE discussions SET
           title = COALESCE($1, title),
           resolved = COALESCE($2, resolved)
         WHERE id = $3`,
        [title ?? null, resolved ?? null, id],
      )
      reply.send({ ok: true })
    },
  )

  // DELETE /api/discussions/:id — hard-delete thread + its messages.
  // Allowed by: the thread author OR the feature creator.
  fastify.delete<{ Params: { id: string } }>(
    '/api/discussions/:id',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params

      const row = await query<{ created_by: string; feature_creator: string }>(
        `SELECT d.created_by, f.creator_id AS feature_creator
         FROM discussions d
         JOIN features f ON f.id = d.feature_id
         JOIN feature_members fm ON fm.feature_id = d.feature_id
         WHERE d.id = $1 AND fm.user_id = $2`,
        [id, req.user!.id],
      )
      if (!row.rows.length) return reply.code(404).send({ error: 'not found' })
      const isAuthor = row.rows[0].created_by === req.user!.id
      const isOwner = row.rows[0].feature_creator === req.user!.id
      if (!isAuthor && !isOwner) {
        return reply.code(403).send({ error: 'Only the thread author or feature owner can delete it.' })
      }

      // Messages cascade-delete via the FK on messages.discussion_id.
      await query(`DELETE FROM discussions WHERE id = $1`, [id])
      reply.send({ ok: true })
    },
  )

  // POST /api/features/:id/discussions - create thread
  fastify.post<{ Params: { id: string }; Body: { title?: string; artifact_id?: string } }>(
    '/api/features/:id/discussions',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const { title, artifact_id } = req.body
      const r = await query<{ id: string }>(
        `INSERT INTO discussions (feature_id, artifact_id, title, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [id, artifact_id ?? null, title ?? null, req.user!.id],
      )
      reply.code(201).send({ id: r.rows[0].id })
    },
  )

  // GET /api/discussions/:id/messages
  fastify.get<{ Params: { id: string } }>(
    '/api/discussions/:id/messages',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const rows = await query<{ id: string; author_id: string; author_name: string; author_email: string; body: string; redacted: boolean; created_at: Date }>(
        `SELECT m.id, m.author_id, u.name AS author_name, u.email AS author_email, m.body, m.redacted, m.created_at
         FROM messages m
         JOIN discussions d ON d.id = m.discussion_id
         JOIN feature_members fm ON fm.feature_id = d.feature_id
         JOIN users u ON u.id = m.author_id
         WHERE m.discussion_id = $1 AND fm.user_id = $2
         ORDER BY m.created_at`,
        [req.params.id, req.user!.id],
      )
      reply.send(rows.rows)
    },
  )

  // POST /api/discussions/:id/messages
  fastify.post<{ Params: { id: string }; Body: { body: string } }>(
    '/api/discussions/:id/messages',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { body } = req.body
      if (!body?.trim()) return reply.code(400).send({ error: 'body required' })
      const r = await query<{ id: string }>(
        `INSERT INTO messages (discussion_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
        [req.params.id, req.user!.id, body],
      )
      reply.code(201).send({ id: r.rows[0].id })
    },
  )
}
