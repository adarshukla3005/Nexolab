import type { FastifyRequest, FastifyReply } from 'fastify'
import { query } from '../db.js'
import { hashToken } from './tokens.js'

export interface AuthUser {
  id: string
  email: string
  name: string
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
  }
}

async function resolveUser(tokenOrCookie: string): Promise<AuthUser | null> {
  const hash = hashToken(tokenOrCookie)
  const rows = await query<{ user_id: string; email: string; name: string; expires_at: Date }>(
    `SELECT s.user_id, u.email, u.name, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.kind = 'session'`,
    [hash],
  )
  if (rows.rowCount === 0) return null
  const row = rows.rows[0]
  if (new Date(row.expires_at) < new Date()) return null
  return { id: row.user_id, email: row.email, name: row.name }
}

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Cookie takes precedence
  const cookie = (req as { cookies?: Record<string, string> }).cookies?.session
  const queryToken = (req.query as Record<string, string>)?.token

  const token = cookie ?? queryToken
  if (!token) {
    reply.code(401).send({ error: 'Unauthorized' })
    return
  }
  const user = await resolveUser(token)
  if (!user) {
    reply.code(401).send({ error: 'Unauthorized' })
    return
  }
  req.user = user
}

export async function optionalAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const cookie = (req as { cookies?: Record<string, string> }).cookies?.session
  const queryToken = (req.query as Record<string, string>)?.token
  const token = cookie ?? queryToken
  if (token) {
    req.user = (await resolveUser(token)) ?? undefined
  }
}
