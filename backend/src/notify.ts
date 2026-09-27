import type { FastifyPluginAsync } from 'fastify'
import { pool, query } from './db.js'
import { authMiddleware } from './auth/middleware.js'

// SSE bridge for Postgres LISTEN/NOTIFY.
// Two channels:
//   - features:list        — global feature list changes (used by FeatureList page)
//   - chat:<featureId>     — chat messages + artifact updates within a single feature
export const notifyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/notify/features', {
    preHandler: authMiddleware,
  }, async (req, reply) => {
    const userId = req.user!.id
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    reply.raw.write('data: {"type":"connected"}\n\n')

    const client = await pool.connect()
    await client.query('LISTEN "features:list"')

    // features:list is broadcast to ALL listeners by Postgres NOTIFY. Before forwarding an
    // event to this user, verify they are a member of the referenced feature — otherwise
    // one user creating a feature would leak into another user's list.
    const onNotification = async (msg: { payload?: string }) => {
      try {
        const data = JSON.parse(msg.payload ?? '{}')
        if (data && typeof data.id === 'string') {
          const mem = await query<{ n: number }>(
            `SELECT 1 AS n FROM feature_members WHERE feature_id = $1 AND user_id = $2 LIMIT 1`,
            [data.id, userId],
          )
          if (!mem.rowCount) return // not a member — drop the event silently
        }
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      } catch { /* ignore malformed payloads */ }
    }
    client.on('notification', onNotification)

    const ping = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': ping\n\n')
    }, 30_000)

    req.raw.on('close', () => {
      clearInterval(ping)
      client.off('notification', onNotification)
      client.query('UNLISTEN "features:list"').finally(() => client.release())
    })

    await new Promise<void>((resolve) => req.raw.on('close', resolve))
  })

  // GET /api/features/:id/chat/stream — per-feature chat + artifact-update broadcast.
  fastify.get<{ Params: { id: string } }>(
    '/api/features/:id/chat/stream',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params

      // Verify user is a member of this feature before opening the stream.
      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      reply.raw.write('data: {"type":"connected"}\n\n')

      const channel = `chat:${id}`
      const client = await pool.connect()
      await client.query(`LISTEN "${channel}"`)

      const onNotification = (msg: { channel?: string; payload?: string }) => {
        if (msg.channel !== channel) return
        try {
          const data = JSON.parse(msg.payload ?? '{}')
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
        } catch { /* ignore */ }
      }
      client.on('notification', onNotification)

      const ping = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': ping\n\n')
      }, 30_000)

      req.raw.on('close', () => {
        clearInterval(ping)
        client.off('notification', onNotification)
        client.query(`UNLISTEN "${channel}"`).finally(() => client.release())
      })

      await new Promise<void>((resolve) => req.raw.on('close', resolve))
    },
  )
}
