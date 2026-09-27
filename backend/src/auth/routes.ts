import type { FastifyPluginAsync } from 'fastify'
import { query, transaction } from '../db.js'
import { generateToken, hashToken } from './tokens.js'
import { sendMagicLink } from './mail.js'
import bcrypt from 'bcryptjs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const USER_CREDS_DIR = '/data/user-credentials'

async function appendMagicLinkToFile(userId: string, email: string, name: string, token: string, verifyUrl: string) {
  try {
    await mkdir(USER_CREDS_DIR, { recursive: true })
    const filePath = join(USER_CREDS_DIR, `${userId}.json`)
    let data: { email: string; name: string; createdAt: string; magicLinks: Array<{ token: string; url: string; createdAt: string }> }
    try {
      data = JSON.parse(await readFile(filePath, 'utf8'))
    } catch {
      data = { email, name, createdAt: new Date().toISOString(), magicLinks: [] }
    }
    data.magicLinks.push({ token, url: verifyUrl, createdAt: new Date().toISOString() })
    await writeFile(filePath, JSON.stringify(data, null, 2))
  } catch (e) {
    console.warn('[auth] failed to write user-credentials file:', e)
  }
}

async function createSessionCookie(reply: { setCookie: (name: string, value: string, opts: Record<string, unknown>) => void }, userId: string) {
  const sessionToken = generateToken()
  const sessionHash = hashToken(sessionToken)
  const sessionExpires = new Date(Date.now() + SESSION_TTL_MS)
  await query(
    `INSERT INTO sessions (user_id, token_hash, kind, expires_at) VALUES ($1, $2, 'session', $3)`,
    [userId, sessionHash, sessionExpires],
  )
  reply.setCookie('session', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS / 1000,
    path: '/',
  })
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/auth/signup - create account with email + password
  fastify.post<{ Body: { email: string; name: string; password: string } }>('/api/auth/signup', async (req, reply) => {
    const { email, name, password } = req.body
    if (!email || !name || !password) return reply.code(400).send({ error: 'email, name and password required' })
    if (password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' })

    const passwordHash = await bcrypt.hash(password, 12)
    const result = await query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email, name, passwordHash],
    )
    if (!result.rows.length) return reply.code(409).send({ error: 'Email already in use' })
    const userId = result.rows[0].id

    await createSessionCookie(reply, userId)
    reply.send({ ok: true })
  })

  // POST /api/auth/login - login with email + password
  fastify.post<{ Body: { email: string; password: string } }>('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body
    if (!email || !password) return reply.code(400).send({ error: 'email and password required' })

    const userRow = await query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [email],
    )
    if (!userRow.rows.length) return reply.code(401).send({ error: 'Invalid credentials' })
    const user = userRow.rows[0]
    if (!user.password_hash) return reply.code(401).send({ error: 'This account uses magic link sign-in only' })

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) return reply.code(401).send({ error: 'Invalid credentials' })

    await createSessionCookie(reply, user.id)
    reply.send({ ok: true })
  })

  // POST /api/auth/request - send magic link
  fastify.post<{ Body: { email: string; name?: string; next?: string } }>('/api/auth/request', {
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          next: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { email, name = email.split('@')[0], next } = req.body

    // Upsert user
    await query(
      `INSERT INTO users (email, name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name`,
      [email, name],
    )
    const userRow = await query<{ id: string; name: string }>('SELECT id, name FROM users WHERE email = $1', [email])
    const userId = userRow.rows[0].id
    const userName = userRow.rows[0].name

    const token = generateToken()
    const tokenHash = hashToken(token)
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS)

    await query(
      `INSERT INTO sessions (user_id, token_hash, kind, expires_at) VALUES ($1, $2, 'magic_link', $3)`,
      [userId, tokenHash, expiresAt],
    )

    const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'
    const nextParam = next && next.startsWith('/') ? `&next=${encodeURIComponent(next)}` : ''
    const verifyUrl = `${base}/api/auth/verify?token=${token}${nextParam}`

    // Save magic link to per-user JSON file for easy dev access
    await appendMagicLinkToFile(userId, email, userName, token, verifyUrl)
    console.log(`[auth] magic link for ${email}: ${verifyUrl}`)

    try {
      await sendMagicLink(email, verifyUrl)
    } catch (err) {
      if (process.env.NODE_ENV === 'production') throw err
    }

    reply.send({ ok: true, message: 'Check your email for a sign-in link.', link: verifyUrl })
  })

  // GET /api/auth/verify - swap magic token for session cookie
  fastify.get<{ Querystring: { token: string; next?: string } }>('/api/auth/verify', async (req, reply) => {
    const { token, next } = req.query
    if (!token) return reply.code(400).send({ error: 'token required' })

    const hash = hashToken(token)
    const rows = await query<{ id: string; user_id: string; expires_at: Date }>(
      `SELECT id, user_id, expires_at FROM sessions WHERE token_hash = $1 AND kind = 'magic_link'`,
      [hash],
    )
    if (rows.rowCount === 0) return reply.code(401).send({ error: 'Invalid or expired link' })
    const ml = rows.rows[0]
    if (new Date(ml.expires_at) < new Date()) {
      return reply.code(401).send({ error: 'Link expired' })
    }

    await transaction(async (client) => {
      await client.query('DELETE FROM sessions WHERE id = $1', [ml.id])
    })

    await createSessionCookie(reply, ml.user_id)

    // If a ?next= param was passed through the magic link, redirect there after login
    const redirectTo = next && next.startsWith('/') ? next : '/'
    reply.redirect(redirectTo)
  })

  // GET /api/auth/me
  fastify.get('/api/auth/me', async (req, reply) => {
    const cookie = (req as { cookies?: Record<string, string> }).cookies?.session
    if (!cookie) return reply.code(401).send({ error: 'not authenticated' })
    const hash = hashToken(cookie)
    const rows = await query<{ user_id: string; email: string; name: string }>(
      `SELECT s.user_id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.kind = 'session' AND s.expires_at > now()`,
      [hash],
    )
    if (rows.rowCount === 0) return reply.code(401).send({ error: 'session expired' })
    const { user_id, email, name } = rows.rows[0]
    reply.send({ id: user_id, email, name })
  })

  // PATCH /api/auth/me — update name and/or email
  fastify.patch<{ Body: { name?: string; email?: string } }>('/api/auth/me', async (req, reply) => {
    const cookie = (req as { cookies?: Record<string, string> }).cookies?.session
    if (!cookie) return reply.code(401).send({ error: 'not authenticated' })
    const hash = hashToken(cookie)
    const sessionRow = await query<{ user_id: string }>(
      `SELECT s.user_id FROM sessions s WHERE s.token_hash = $1 AND s.kind = 'session' AND s.expires_at > now()`,
      [hash],
    )
    if (!sessionRow.rows.length) return reply.code(401).send({ error: 'session expired' })
    const userId = sessionRow.rows[0].user_id

    const { name, email } = req.body
    if (!name && !email) return reply.code(400).send({ error: 'name or email required' })

    if (name) await query(`UPDATE users SET name = $1 WHERE id = $2`, [name.trim(), userId])
    if (email) {
      const conflict = await query(`SELECT id FROM users WHERE email = $1 AND id != $2`, [email.trim(), userId])
      if (conflict.rows.length) return reply.code(409).send({ error: 'Email already in use' })
      await query(`UPDATE users SET email = $1 WHERE id = $2`, [email.trim(), userId])
    }

    const updated = await query<{ email: string; name: string }>(`SELECT email, name FROM users WHERE id = $1`, [userId])
    reply.send({ id: userId, ...updated.rows[0] })
  })

  // POST /api/auth/logout
  fastify.post('/api/auth/logout', async (req, reply) => {
    const cookie = (req as { cookies?: Record<string, string> }).cookies?.session
    if (cookie) {
      const hash = hashToken(cookie)
      await query('DELETE FROM sessions WHERE token_hash = $1', [hash])
      reply.clearCookie('session', { path: '/' })
    }
    reply.send({ ok: true })
  })
}
