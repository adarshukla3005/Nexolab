import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import { authRoutes } from './auth/routes.js'
import { featuresRoutes } from './routes/features.js'
import { gatesRoutes } from './routes/gates.js'
import { discussionsRoutes } from './routes/discussions.js'
import { repoRoutes } from './routes/repo.js'
import { notifyRoutes } from './notify.js'
import { handleYjsConnection } from './yjs/server.js'
import { authMiddleware } from './auth/middleware.js'
import { pool } from './db.js'
import { runMigrations } from './migrate.js'
import { seedIfNeeded } from './methodology/seeder.js'

const fastify = Fastify({
  logger: { level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' },
})

// Plugins
await fastify.register(fastifyCookie, { secret: process.env.SESSION_SECRET ?? 'dev' })
await fastify.register(fastifyCors, {
  origin: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
  credentials: true,
})
await fastify.register(fastifyWebsocket)

// Health
fastify.get('/health', () => ({ ok: true }))

// Yjs WebSocket
fastify.register(async (app) => {
  app.get<{ Params: { featureId: string } }>('/yjs/:featureId', {
    websocket: true,
    preHandler: authMiddleware,
  }, (socket, req) => {
    const { featureId } = req.params as { featureId: string }
    handleYjsConnection(featureId, socket.socket).catch((e) =>
      console.error('[yjs] handler error:', e),
    )
  })
})

// REST routes
await fastify.register(authRoutes)
await fastify.register(featuresRoutes)
await fastify.register(gatesRoutes)
await fastify.register(discussionsRoutes)
await fastify.register(repoRoutes)
await fastify.register(notifyRoutes)

// 404 fallback
fastify.setNotFoundHandler((_req, reply) => {
  reply.code(404).send({ error: 'not found' })
})

try {
  await runMigrations()
  await seedIfNeeded()
  await fastify.listen({ port: 4000, host: '0.0.0.0' })
  console.log('[app] listening on :4000')

  // On restart: reset any 'running' stages to 'pending', then resume them all.
  // The await chain ensures the reset commits before we query for pending rows.
  ;(async () => {
    try {
      const { query: q } = await import('./db.js')
      const reset = await q(`UPDATE stage_runs SET status = 'pending' WHERE status = 'running'`)
      if (reset.rowCount && reset.rowCount > 0) {
        console.log(`[app] reset ${reset.rowCount} running->pending on restart`)
      }
      const rows = await q<{ id: string; feature_id: string }>(
        `SELECT id, feature_id FROM stage_runs WHERE status = 'pending' ORDER BY created_at ASC`,
      )
      if (rows.rows.length) {
        console.log(`[app] resuming ${rows.rows.length} pending stage run(s)`)
        const { runStage } = await import('./orchestrator/runner.js')
        for (const r of rows.rows) {
          runStage(r.feature_id, r.id).catch((e) =>
            console.error(`[app] auto-resume failed for ${r.id}:`, e),
          )
        }
      }
    } catch (e) {
      console.warn('[app] auto-resume scan failed:', e)
    }
  })()
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
