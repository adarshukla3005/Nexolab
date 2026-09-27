import type { FastifyPluginAsync } from 'fastify'
import { query, transaction } from '../db.js'
import { authMiddleware } from '../auth/middleware.js'
import { resolveProvider } from '../git/worker.js'
import { createFeatureWorktree } from '../git/worker.js'
import { advanceStage, resumeParked, runStage } from '../orchestrator/runner.js'
import { consolidatePlan } from '../orchestrator/combine-plan.js'
import { FEATURE_WORKFLOW } from '../orchestrator/workflow.js'
import { snapshotArtifact } from '../orchestrator/artifact-versions.js'
import { commitPlan } from '../git/worker.js'
import { chat } from '../llm/client.js'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { mkdirSync } from 'fs'

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
    + '-' + randomUUID().slice(0, 8)
}

// If the chat message mentions an artifact by slug or title, return that slug so the
// AI edits it. e.g. "add criteria to the Spec artifact" → returns "spec". No match → null.
function inferTargetSlug(
  message: string,
  artifacts: Array<{ slug: string; title: string }>,
): string | null {
  const lower = message.toLowerCase()
  // Score-based match: prefer slug hits (unique) over title hits (words like "Design" can be ambiguous).
  let best: { slug: string; score: number } | null = null
  for (const a of artifacts) {
    let score = 0
    if (lower.includes(` ${a.slug} `) || lower.startsWith(`${a.slug} `) || lower.endsWith(` ${a.slug}`)) score += 3
    else if (lower.includes(a.slug)) score += 2
    const titleWords = a.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3)
    for (const w of titleWords) if (lower.includes(w)) score += 1
    if (score > 0 && (!best || score > best.score)) best = { slug: a.slug, score }
  }
  return best?.slug ?? null
}

// Postgres NOTIFY payloads are capped at ~8000 bytes. When the full payload is too big we
// fall back to a lightweight "hint" event with just the id + type, and the client re-fetches.
// Never throws — a failed broadcast should not turn a successful DB write into a 500.
const NOTIFY_BYTE_BUDGET = 6000
async function safeBroadcast(channel: string, full: object, fallback?: object): Promise<void> {
  const payload = JSON.stringify(full)
  const chosen = payload.length < NOTIFY_BYTE_BUDGET
    ? payload
    : JSON.stringify(fallback ?? { type: 'refresh' })
  try {
    await query(`SELECT pg_notify($1, $2)`, [channel, chosen])
  } catch (err) {
    console.warn(`[notify] broadcast failed on ${channel}:`, err)
  }
}

export const featuresRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/features - create a new feature
  fastify.post<{
    Body: { title: string; prompt: string; repo_url?: string; base_branch?: string; quorum_size?: number }
  }>('/api/features', { preHandler: authMiddleware }, async (req, reply) => {
    const { title, prompt, repo_url, base_branch = 'main', quorum_size = 1 } = req.body
    if (!title || !prompt) return reply.code(400).send({ error: 'title and prompt required' })

    const slug = slugify(title)
    const planBranch = `plan/${slug}`

    let repoId: string | null = null
    if (repo_url) {
      const { provider, cloneUrl } = resolveProvider(repo_url)
      const r = await query<{ id: string }>(
        `INSERT INTO repos (url, provider, clone_url) VALUES ($1, $2, $3)
         ON CONFLICT (url) DO UPDATE SET provider = EXCLUDED.provider RETURNING id`,
        [repo_url, provider, cloneUrl],
      )
      repoId = r.rows[0].id
    }

    const featureResult = await query<{ id: string }>(
      `INSERT INTO features (slug, title, prompt, repo_id, repo_url, base_branch, plan_branch, creator_id, quorum_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [slug, title, prompt, repoId, repo_url ?? null, base_branch, planBranch, req.user!.id, quorum_size],
    )
    const featureId = featureResult.rows[0].id

    // Add creator as member
    await query(
      `INSERT INTO feature_members (feature_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [featureId, req.user!.id],
    )

    // Create worktree in background if repo supplied
    if (repoId && repo_url) {
      createFeatureWorktree(featureId, repo_url, base_branch, planBranch)
        .catch((e) => console.warn('[features] worktree create failed:', e))
    }

    // Start the first stage
    advanceStage(featureId).catch((e) => console.error('[features] advance stage failed:', e))

    // Auto-backup DB after feature creation (fire-and-forget, best-effort only)
    try {
      mkdirSync('/data/backups', { recursive: true })
      const backupFile = `/data/backups/auto-${featureId.slice(0, 8)}-${Date.now()}.sql`
      const backupProc = spawn('pg_dump', ['-U', 'dlc', '-d', 'dlc', '-f', backupFile], {
        env: { ...process.env, PGHOST: 'postgres' },
        detached: true,
        stdio: 'ignore',
      })
      backupProc.on('error', () => { /* pg_dump not available — ignore silently */ })
      backupProc.unref()
    } catch { /* ignore */ }

    reply.code(201).send({ id: featureId, slug, plan_branch: planBranch })
  })

  // GET /api/features - list user's features
  fastify.get('/api/features', { preHandler: authMiddleware }, async (req, reply) => {
    const rows = await query<{
      id: string; slug: string; title: string; status: string
      current_stage_id: string | null; created_at: Date; creator_id: string
    }>(
      `SELECT f.id, f.slug, f.title, f.status, f.current_stage_id, f.created_at, f.creator_id
       FROM features f
       JOIN feature_members fm ON fm.feature_id = f.id
       WHERE fm.user_id = $1
       ORDER BY f.created_at DESC`,
      [req.user!.id],
    )
    reply.send(rows.rows)
  })

  // GET /api/features/:id - get feature details (auto-joins if invited via link)
  fastify.get<{ Params: { id: string }; Querystring: { join?: string } }>(
    '/api/features/:id',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const { join } = req.query

      // If ?join=1, add this user as a member (invite link flow)
      if (join === '1') {
        await query(
          `INSERT INTO feature_members (feature_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, req.user!.id],
        )
      }

      const rows = await query<{
        id: string; slug: string; title: string; prompt: string; status: string
        current_stage_id: string | null; plan_branch: string | null
        base_branch: string; quorum_size: number; committed_sha: string | null
        creator_id: string; repo_url: string | null; created_at: string
      }>(
        `SELECT f.id, f.slug, f.title, f.prompt, f.status, f.current_stage_id,
                f.plan_branch, f.base_branch, f.quorum_size, f.committed_sha, f.creator_id,
                f.repo_url, f.created_at
         FROM features f
         JOIN feature_members fm ON fm.feature_id = f.id
         WHERE f.id = $1 AND fm.user_id = $2`,
        [id, req.user!.id],
      )
      if (!rows.rows.length) return reply.code(404).send({ error: 'not found' })
      reply.send(rows.rows[0])
    },
  )

  // GET /api/features/:id/members - list members
  fastify.get<{ Params: { id: string } }>(
    '/api/features/:id/members',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const check = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!check.rows.length) return reply.code(404).send({ error: 'not found' })
      const rows = await query<{ id: string; email: string; name: string; role: string; joined_at: Date }>(
        `SELECT u.id, u.email, u.name, fm.role, fm.joined_at FROM users u
         JOIN feature_members fm ON fm.user_id = u.id
         WHERE fm.feature_id = $1 ORDER BY fm.joined_at`,
        [id],
      )
      reply.send(rows.rows)
    },
  )

  // DELETE /api/features/:id/members/:userId - remove a member
  fastify.delete<{ Params: { id: string; userId: string } }>(
    '/api/features/:id/members/:userId',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id, userId } = req.params
      // Only members can remove others; cannot remove the last owner
      const check = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!check.rows.length) return reply.code(404).send({ error: 'not found' })
      // Prevent removing yourself if you'd leave the feature ownerless
      const ownerCount = await query<{ count: string }>(
        `SELECT COUNT(*) FROM feature_members WHERE feature_id = $1`,
        [id],
      )
      if (parseInt(ownerCount.rows[0].count, 10) <= 1) {
        return reply.code(400).send({ error: 'Cannot remove the last member' })
      }
      await query(
        `DELETE FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, userId],
      )
      reply.send({ ok: true })
    },
  )

  // GET /api/features/:id/artifacts - list artifacts
  fastify.get<{ Params: { id: string } }>('/api/features/:id/artifacts', { preHandler: authMiddleware }, async (req, reply) => {
    const { id } = req.params
    const rows = await query<{ id: string; slug: string; artifact_type: string; title: string; updated_at: Date; stage_run_id: string | null }>(
      `SELECT a.id, a.slug, a.artifact_type, a.title, a.updated_at, a.stage_run_id
       FROM artifacts a
       JOIN feature_members fm ON fm.feature_id = a.feature_id
       WHERE a.feature_id = $1 AND fm.user_id = $2
       ORDER BY a.created_at`,
      [id, req.user!.id],
    )
    reply.send(rows.rows)
  })

  // GET /api/features/:id/artifacts/by-slug/:slug — fetch artifact by slug (used by SSE
  // change-notifications for artifacts too big to inline in a Postgres NOTIFY payload).
  fastify.get<{ Params: { id: string; slug: string } }>(
    '/api/features/:id/artifacts/by-slug/:slug',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id, slug } = req.params
      const rows = await query<{ id: string; slug: string; artifact_type: string; title: string; content_md: string; version: number }>(
        `SELECT a.id, a.slug, a.artifact_type, a.title, a.content_md, a.version
         FROM artifacts a
         JOIN feature_members fm ON fm.feature_id = a.feature_id
         WHERE a.feature_id = $1 AND a.slug = $2 AND fm.user_id = $3`,
        [id, slug, req.user!.id],
      )
      if (!rows.rows.length) return reply.code(404).send({ error: 'not found' })
      reply.send(rows.rows[0])
    },
  )

  // GET /api/features/:id/artifacts/:artifactId - get artifact content
  fastify.get<{ Params: { id: string; artifactId: string } }>(
    '/api/features/:id/artifacts/:artifactId',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id, artifactId } = req.params
      const rows = await query<{ id: string; slug: string; artifact_type: string; title: string; content_md: string; version: number }>(
        `SELECT a.id, a.slug, a.artifact_type, a.title, a.content_md, a.version
         FROM artifacts a
         JOIN feature_members fm ON fm.feature_id = a.feature_id
         WHERE a.feature_id = $1 AND a.id = $2 AND fm.user_id = $3`,
        [id, artifactId, req.user!.id],
      )
      if (!rows.rows.length) return reply.code(404).send({ error: 'not found' })
      reply.send(rows.rows[0])
    },
  )

  // POST /api/features/:id/artifacts/:artifactId — save manual edits to an artifact.
  // Bumps `version`, updates `updated_at`, and broadcasts `artifact_updated` on the chat channel
  // so every open editor on that artifact syncs live for other collaborators.
  fastify.post<{
    Params: { id: string; artifactId: string }
    Body: { content_md?: string; title?: string }
  }>(
    '/api/features/:id/artifacts/:artifactId',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id, artifactId } = req.params
      const { content_md, title } = req.body ?? {}
      if (content_md === undefined && title === undefined) {
        return reply.code(400).send({ error: 'content_md or title required' })
      }

      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      const existing = await query<{ id: string; slug: string }>(
        `SELECT id, slug FROM artifacts WHERE id = $1 AND feature_id = $2`,
        [artifactId, id],
      )
      if (!existing.rows.length) return reply.code(404).send({ error: 'artifact not found' })
      const slug = existing.rows[0].slug

      // Snapshot old version before overwriting so users can restore later.
      await snapshotArtifact(artifactId, req.user!.id, 'manual')

      const updated = await query<{ version: number; content_md: string; title: string }>(
        `UPDATE artifacts SET
           content_md = COALESCE($1, content_md),
           title      = COALESCE($2, title),
           version    = version + 1,
           updated_at = now()
         WHERE id = $3
         RETURNING version, content_md, title`,
        [content_md ?? null, title ?? null, artifactId],
      )
      const row = updated.rows[0]

      // Broadcast so open editors sync live. Reuse the chat channel — the frontend already listens.
      await safeBroadcast(
        `chat:${id}`,
        {
          type: 'artifact_updated',
          slug,
          content_md: row.content_md,
          version: row.version,
          by_user_id: req.user!.id,
        },
        // Fallback for large artifacts: lightweight event, client re-fetches by slug.
        { type: 'artifact_changed', slug, version: row.version, by_user_id: req.user!.id },
      )

      reply.send({ ok: true, version: row.version })
    },
  )

  // GET /api/features/:id/artifacts/:artifactId/versions — list past versions (newest first).
  fastify.get<{ Params: { id: string; artifactId: string } }>(
    '/api/features/:id/artifacts/:artifactId/versions',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id, artifactId } = req.params
      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      const rows = await query<{
        version: number; title: string | null; edit_source: string
        created_at: Date; editor_id: string | null; editor_name: string | null
        content_preview: string; content_len: number
      }>(
        `SELECT av.version, av.title, av.edit_source, av.created_at, av.editor_id,
                u.name AS editor_name,
                LEFT(av.content_md, 240) AS content_preview,
                LENGTH(av.content_md) AS content_len
         FROM artifact_versions av
         JOIN artifacts a ON a.id = av.artifact_id
         LEFT JOIN users u ON u.id = av.editor_id
         WHERE av.artifact_id = $1 AND a.feature_id = $2
         ORDER BY av.version DESC`,
        [artifactId, id],
      )
      reply.send({ versions: rows.rows })
    },
  )

  // GET /api/features/:id/artifacts/:artifactId/versions/:version — full content of one version.
  fastify.get<{ Params: { id: string; artifactId: string; version: string } }>(
    '/api/features/:id/artifacts/:artifactId/versions/:version',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id, artifactId, version } = req.params
      const versionNum = parseInt(version, 10)
      if (!Number.isFinite(versionNum)) return reply.code(400).send({ error: 'bad version' })

      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      const row = await query<{ version: number; title: string | null; content_md: string; edit_source: string; created_at: Date }>(
        `SELECT av.version, av.title, av.content_md, av.edit_source, av.created_at
         FROM artifact_versions av JOIN artifacts a ON a.id = av.artifact_id
         WHERE av.artifact_id = $1 AND a.feature_id = $2 AND av.version = $3`,
        [artifactId, id, versionNum],
      )
      if (!row.rows.length) return reply.code(404).send({ error: 'version not found' })
      reply.send(row.rows[0])
    },
  )

  // POST /api/features/:id/artifacts/:artifactId/restore/:version — restore an older version.
  // Snapshots the current (about-to-be-replaced) version, then overwrites content with the older one.
  fastify.post<{ Params: { id: string; artifactId: string; version: string } }>(
    '/api/features/:id/artifacts/:artifactId/restore/:version',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id, artifactId, version } = req.params
      const versionNum = parseInt(version, 10)
      if (!Number.isFinite(versionNum)) return reply.code(400).send({ error: 'bad version' })

      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      const target = await query<{ content_md: string; title: string | null }>(
        `SELECT content_md, title FROM artifact_versions
         WHERE artifact_id = $1 AND version = $2`,
        [artifactId, versionNum],
      )
      if (!target.rows.length) return reply.code(404).send({ error: 'version not found' })

      const artRow = await query<{ slug: string }>(
        `SELECT slug FROM artifacts WHERE id = $1 AND feature_id = $2`,
        [artifactId, id],
      )
      if (!artRow.rows.length) return reply.code(404).send({ error: 'artifact not found' })

      // Snapshot current content so the restore itself is undoable.
      await snapshotArtifact(artifactId, req.user!.id, 'restore')

      const updated = await query<{ version: number; content_md: string }>(
        `UPDATE artifacts SET
           content_md = $1,
           title      = COALESCE($2, title),
           version    = version + 1,
           updated_at = now()
         WHERE id = $3
         RETURNING version, content_md`,
        [target.rows[0].content_md, target.rows[0].title ?? null, artifactId],
      )
      const row = updated.rows[0]

      await safeBroadcast(
        `chat:${id}`,
        { type: 'artifact_updated', slug: artRow.rows[0].slug, content_md: row.content_md, version: row.version, by_user_id: req.user!.id },
        { type: 'artifact_changed', slug: artRow.rows[0].slug, version: row.version, by_user_id: req.user!.id },
      )

      reply.send({ ok: true, version: row.version, restored_from: versionNum })
    },
  )

  // POST /api/features/:id/members - add member
  fastify.post<{ Params: { id: string }; Body: { email: string } }>(
    '/api/features/:id/members',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const { email } = req.body
      const userRow = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])
      if (!userRow.rows.length) return reply.code(404).send({ error: 'user not found' })
      await query(
        `INSERT INTO feature_members (feature_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, userRow.rows[0].id],
      )
      reply.send({ ok: true })
    },
  )

  // DELETE /api/features/:id
  // - Creator: permanently deletes the feature for everyone
  // - Non-creator member: removes only themselves from the workspace (leave)
  fastify.delete<{ Params: { id: string } }>(
    '/api/features/:id',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const check = await query<{ creator_id: string }>(
        `SELECT f.creator_id FROM features f
         JOIN feature_members fm ON fm.feature_id = f.id
         WHERE f.id = $1 AND fm.user_id = $2`,
        [id, req.user!.id],
      )
      if (!check.rows.length) return reply.code(404).send({ error: 'not found' })

      const isCreator = check.rows[0].creator_id === req.user!.id
      if (isCreator) {
        // Hard delete — cascades to all related rows
        await query('DELETE FROM features WHERE id = $1', [id])
        reply.send({ ok: true, deleted: true })
      } else {
        // Non-creator: just remove them from the workspace
        await query('DELETE FROM feature_members WHERE feature_id = $1 AND user_id = $2', [id, req.user!.id])
        reply.send({ ok: true, deleted: false })
      }
    },
  )

  // POST /api/features/:id/answer-questions - submit answers from question artifact
  fastify.post<{
    Params: { id: string }
    Body: { artifactId: string; answers: Array<{ question: string; answer: string }> }
  }>(
    '/api/features/:id/answer-questions',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const { artifactId, answers } = req.body

      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      // Update the artifact content with answers filled in
      const art = await query<{ content_md: string; version: number }>(
        `SELECT content_md, version FROM artifacts WHERE id = $1 AND feature_id = $2`,
        [artifactId, id],
      )
      if (!art.rows.length) return reply.code(404).send({ error: 'artifact not found' })

      // Replace [Answer]: placeholders with actual answers in order
      let updated = art.rows[0].content_md
      let answerIdx = 0
      updated = updated.replace(/\[Answer\]:[^\n]*/g, () => {
        const a = answers[answerIdx]
        answerIdx++
        return `[Answer]: ${a?.answer ?? ''}`
      })

      await snapshotArtifact(artifactId, req.user!.id, 'manual')
      await query(
        `UPDATE artifacts SET content_md = $1, version = version + 1, updated_at = now() WHERE id = $2`,
        [updated, artifactId],
      )

      // Store answers as a human gate record for the record, then advance the stage
      const stageRun = await query<{ id: string; stage_slug: string }>(
        `SELECT id, stage_slug FROM stage_runs
         WHERE feature_id = $1 AND status IN ('running','parked','pending')
         ORDER BY created_at DESC LIMIT 1`,
        [id],
      )

      const answerSummary = answers.map((a, i) => `Q${i + 1}: ${a.question}\nAnswer: ${a.answer}`).join('\n\n')

      if (stageRun.rows.length) {
        const runId = stageRun.rows[0].id

        // Check for a pending OR already-answered gate (park/resume path, handles re-submit)
        const pendingGate = await query<{ id: string; status: string }>(
          `SELECT id, status FROM human_gates
           WHERE stage_run_id = $1 AND kind = 'question' AND status IN ('pending','answered')
           ORDER BY created_at DESC LIMIT 1`,
          [runId],
        )

        if (pendingGate.rows.length) {
          // Stage is properly parked — resume via checkpoint replay
          import('../orchestrator/runner.js').then(({ resumeParked }) =>
            resumeParked(pendingGate.rows[0].id, { answers, summary: answerSummary })
              .catch((e) => console.error('[answer-questions] resumeParked error:', e))
          )
        } else {
          // LLM completed without parking (wrote questions as artifact text only)
          // Record the answers then advance to the next stage
          await query(
            `INSERT INTO human_gates (feature_id, stage_run_id, kind, status, question_text, answer, step_id)
             VALUES ($1, $2, 'question', 'answered', 'Intent capture answers', $3, 'question-form-answers')
             ON CONFLICT DO NOTHING`,
            [id, runId, JSON.stringify({ answers, summary: answerSummary })],
          )
          await query(`UPDATE stage_runs SET status = 'done', completed_at = now() WHERE id = $1`, [runId])
          import('../orchestrator/runner.js').then(({ advanceStage }) =>
            advanceStage(id).catch((e) => console.error('[answer-questions] advanceStage error:', e))
          )
        }
      }

      reply.send({ ok: true })
    },
  )

  // POST /api/features/:id/advance - manually advance to next stage (when current is done but not progressed)
  fastify.post<{ Params: { id: string } }>(
    '/api/features/:id/advance',
    { preHandler: authMiddleware, schema: { body: { type: 'object' } } },
    async (req, reply) => {
      const { id } = req.params
      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })
      // Fire-and-forget — don't await so we can reply immediately
      advanceStage(id).catch((e) => console.error('[advance] error:', e))
      reply.send({ ok: true })
    },
  )

  // POST /api/features/:id/stop - stop (pause) the currently running/parked stage
  fastify.post<{ Params: { id: string } }>(
    '/api/features/:id/stop',
    { preHandler: authMiddleware, schema: { body: { type: 'object' } } },
    async (req, reply) => {
      const { id } = req.params
      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      // Mark the active stage run as stopped — the runner loop checks this and exits
      const stageRun = await query<{ id: string; stage_slug: string }>(
        `SELECT id, stage_slug FROM stage_runs
         WHERE feature_id = $1 AND status IN ('running','parked','pending')
         ORDER BY created_at DESC LIMIT 1`,
        [id],
      )
      if (!stageRun.rows.length) return reply.code(400).send({ error: 'No active stage to stop' })

      await query(
        `UPDATE stage_runs SET status = 'stopped' WHERE id = $1`,
        [stageRun.rows[0].id],
      )

      reply.send({ ok: true, stageSlug: stageRun.rows[0].stage_slug })
    },
  )

  // POST /api/features/:id/retry - retry the current failed/pending/stopped stage
  fastify.post<{ Params: { id: string } }>(
    '/api/features/:id/retry',
    { preHandler: authMiddleware, schema: { body: { type: 'object' } } },
    async (req, reply) => {
      const { id } = req.params
      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      const stageRun = await query<{ id: string; stage_slug: string; execution_id: string }>(
        `SELECT id, stage_slug, execution_id FROM stage_runs
         WHERE feature_id = $1 AND status IN ('failed','pending','stopped')
         ORDER BY created_at DESC LIMIT 1`,
        [id],
      )
      if (!stageRun.rows.length) return reply.code(400).send({ error: 'No stopped/failed stage to retry' })

      const run = stageRun.rows[0]
      // Keep existing execution_id so succeeded checkpoints are replayed — only reset status.
      // This resumes from the last successful step rather than restarting from scratch.
      await query(
        `UPDATE stage_runs SET status = 'pending', started_at = NULL WHERE id = $1`,
        [run.id],
      )

      runStage(id, run.id).catch((e) => console.error('[retry] runStage failed:', e))

      reply.send({ ok: true, stageRunId: run.id, stageSlug: run.stage_slug })
    },
  )

  // POST /api/features/:id/stages/:stageSlug/restart
  // Wipes the given stage AND every stage after it, then re-runs from the given stage.
  // Preserves chat history and approvals. Used by the "Restart stage" button.
  fastify.post<{ Params: { id: string; stageSlug: string } }>(
    '/api/features/:id/stages/:stageSlug/restart',
    { preHandler: authMiddleware, schema: { body: { type: 'object' } } },
    async (req, reply) => {
      const { id, stageSlug } = req.params

      const memberCheck = await query<{ status: string; committed_sha: string | null }>(
        `SELECT f.status, f.committed_sha FROM features f
         JOIN feature_members fm ON fm.feature_id = f.id
         WHERE f.id = $1 AND fm.user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      // Block restart once the plan has been actually pushed to git — nothing to redo at that point.
      // (feature.status='committed' + a real committed_sha means git push succeeded.)
      const featRow = memberCheck.rows[0]
      if (featRow.status === 'committed' && featRow.committed_sha) {
        return reply.code(400).send({
          error: 'This plan has already been committed to the repo. Restart is disabled after commit.',
        })
      }

      const idx = FEATURE_WORKFLOW.indexOf(stageSlug as typeof FEATURE_WORKFLOW[number])
      if (idx === -1) return reply.code(400).send({ error: `Unknown stage: ${stageSlug}` })
      // Convert readonly tuple → plain string[] so pg serializes it correctly.
      const slugsToWipe: string[] = Array.from(FEATURE_WORKFLOW.slice(idx))

      // Find all stage_runs at-or-after the restart point.
      // Use unnest() to avoid the readonly-array serialization edge case.
      const wipedRuns = await query<{ id: string; execution_id: string }>(
        `SELECT id, execution_id FROM stage_runs
         WHERE feature_id = $1::uuid
           AND stage_slug IN (SELECT unnest($2::text[]))`,
        [id, slugsToWipe],
      )
      const runIds: string[] = wipedRuns.rows.map((r) => r.id)
      const execIds: string[] = wipedRuns.rows.map((r) => r.execution_id).filter(Boolean)

      // Cascade delete: tool_calls → human_gates (approvals via FK) → artifacts → stage_runs.
      // NB: tool_calls.execution_id is TEXT (not uuid) — cast accordingly.
      if (execIds.length) {
        await query(
          `DELETE FROM tool_calls WHERE execution_id IN (SELECT unnest($1::text[]))`,
          [execIds],
        )
      }
      if (runIds.length) {
        await query(
          `DELETE FROM human_gates WHERE stage_run_id IN (SELECT unnest($1::uuid[]))`,
          [runIds],
        )
        await query(
          `DELETE FROM artifacts WHERE stage_run_id IN (SELECT unnest($1::uuid[]))`,
          [runIds],
        )
        await query(
          `DELETE FROM stage_runs WHERE id IN (SELECT unnest($1::uuid[]))`,
          [runIds],
        )
      }
      // Also drop the aggregated plan artifact (stage_run_id NULL) so the review stage rebuilds it.
      await query(`DELETE FROM artifacts WHERE feature_id = $1::uuid AND slug = 'plan'`, [id])
      // Restarting invalidates final approvals — the plan is changing, so re-approval is required.
      await query(`DELETE FROM feature_approvals WHERE feature_id = $1::uuid`, [id])
      // Reset feature status to 'active' (revert 'planned' if it had been reached) and
      // set current stage to the previous slug (or null if restarting the very first stage).
      const prevIdx = idx - 1
      const prevSlug = prevIdx >= 0 ? FEATURE_WORKFLOW[prevIdx] : null
      await query(
        `UPDATE features SET status = 'active', current_stage_id = $1, updated_at = now() WHERE id = $2::uuid`,
        [prevSlug, id],
      )

      // Kick the pipeline: advanceStage will create a fresh stage_run for stageSlug.
      advanceStage(id).catch((e) => console.error('[restart] advanceStage failed:', e))

      reply.send({ ok: true, restartedAt: stageSlug, wipedStages: slugsToWipe })
    },
  )

  // POST /api/features/:id/chat - workspace AI assistant (per-feature, persisted, broadcast).
  fastify.post<{
    Params: { id: string }
    Body: {
      message: string
      // Optional slug of artifact user wants the AI to edit. NOT a UUID — a slug like "proposal".
      targetSlug?: string
      // Optional: highlighted text the user wants the AI to focus on. The AI is instructed
      // to preserve everything else and only rewrite this span.
      selectionContext?: {
        slug: string           // artifact slug the selection is from (usually same as targetSlug)
        selection: string      // exact selected text
      }
    }
  }>(
    '/api/features/:id/chat',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const { message, targetSlug, selectionContext } = req.body
      if (!message) return reply.code(400).send({ error: 'message required' })

      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      // Persist the user's message and broadcast immediately so other collaborators see it.
      const userMsgInsert = await query<{ id: string; created_at: Date }>(
        `INSERT INTO chat_messages (feature_id, user_id, role, text)
         VALUES ($1, $2, 'user', $3) RETURNING id, created_at`,
        [id, req.user!.id, message],
      )
      const userMsg = userMsgInsert.rows[0]
      await safeBroadcast(
        `chat:${id}`,
        {
          type: 'message',
          id: userMsg.id,
          role: 'user',
          text: message,
          user_id: req.user!.id,
          user_name: req.user!.name,
          created_at: userMsg.created_at,
        },
        // Fallback: tell clients to re-fetch history for this message.
        { type: 'message_ref', id: userMsg.id },
      )

      // Gather workspace context: feature, stage runs, all artifacts (titles only).
      const featureRow = await query<{ title: string; prompt: string; status: string; current_stage_id: string | null }>(
        `SELECT title, prompt, status, current_stage_id FROM features WHERE id = $1`, [id],
      )
      const feat = featureRow.rows[0]

      const stageRunRows = await query<{
        id: string; stage_slug: string; status: string
        started_at: Date | null; completed_at: Date | null; execution_id: string | null
      }>(
        `SELECT id, stage_slug, status, started_at, completed_at, execution_id
         FROM stage_runs WHERE feature_id = $1 ORDER BY created_at`, [id],
      )

      const artifactRows = await query<{ id: string; slug: string; artifact_type: string; title: string; content_md: string }>(
        `SELECT id, slug, artifact_type, title, content_md FROM artifacts WHERE feature_id = $1 ORDER BY created_at`, [id],
      )

      // If the user specified a targetSlug (or a message like "in the Spec artifact ..." mentions one),
      // pick that artifact as the edit target. Otherwise infer from the message text.
      // For selection-based edits, the slug from selectionContext ALWAYS wins.
      let activeArtifact: { id: string; slug: string; artifact_type: string; title: string; content_md: string; version: number } | null = null
      const targetLookup = selectionContext?.slug ?? targetSlug ?? inferTargetSlug(message, artifactRows.rows)
      if (targetLookup) {
        const artRow = await query<{ id: string; slug: string; artifact_type: string; title: string; content_md: string; version: number }>(
          `SELECT id, slug, artifact_type, title, content_md, version FROM artifacts WHERE slug = $1 AND feature_id = $2`,
          [targetLookup, id],
        )
        activeArtifact = artRow.rows[0] ?? null
      }

      // Load the last 12 chat messages (trimmed) to give the AI context.
      // Cap each to 800 chars so a huge past message doesn't blow up the prompt.
      const historyRows = await query<{ role: string; text: string }>(
        `SELECT role, text FROM chat_messages
         WHERE feature_id = $1 AND id != $2
         ORDER BY created_at DESC LIMIT 12`,
        [id, userMsg.id],
      )
      const history = historyRows.rows.reverse().map((r) => ({
        role: r.role,
        text: r.text.length > 800 ? r.text.slice(0, 800) + '…' : r.text,
      }))

      // Pull recent tool-call logs for each stage run (capped at 6 per stage to stay concise)
      const stageLogMap: Record<string, string> = {}
      for (const sr of stageRunRows.rows) {
        if (!sr.execution_id) continue
        const logRows = await query<{
          tool_name: string; status: string; created_at: Date; completed_at: Date | null
        }>(
          `SELECT tool_name, status, created_at, completed_at
           FROM tool_calls WHERE execution_id = $1 ORDER BY created_at LIMIT 12`,
          [sr.execution_id],
        )
        if (!logRows.rows.length) continue
        const lines = logRows.rows.map((l) => {
          const dur = l.completed_at && l.created_at
            ? `${((new Date(l.completed_at).getTime() - new Date(l.created_at).getTime()) / 1000).toFixed(1)}s`
            : 'running'
          const icon = l.status === 'succeeded' ? '✓' : l.status === 'failed' ? '✗' : '⟳'
          return `    ${icon} ${l.tool_name} (${dur})`
        })
        stageLogMap[sr.stage_slug] = lines.join('\n')
      }

      const stagesContext = stageRunRows.rows.map((s) => {
        const dur = s.completed_at && s.started_at
          ? ` — ${Math.round((new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()) / 1000)}s`
          : s.started_at ? ' — in progress' : ''
        const logs = stageLogMap[s.stage_slug] ? `\n${stageLogMap[s.stage_slug]}` : ''
        return `  - ${s.stage_slug}: ${s.status}${dur}${logs}`
      }).join('\n')

      const artifactsContext = artifactRows.rows.map((a) => `  - ${a.title || a.slug} [${a.artifact_type}]`).join('\n')

      // Cap the active artifact so the prompt stays under ~30KB total even for the big
      // combined PLAN.md. If the AI needs more, the user can quote a section into their message.
      const MAX_ACTIVE_ARTIFACT = 12_000
      const activeArtifactContext = activeArtifact
        ? `\n\n## Active Artifact (open in editor)\nTitle: ${activeArtifact.title || activeArtifact.slug}\nType: ${activeArtifact.artifact_type}\nVersion: ${activeArtifact.version}\n\n${activeArtifact.content_md.length > MAX_ACTIVE_ARTIFACT ? activeArtifact.content_md.slice(0, MAX_ACTIVE_ARTIFACT) + '\n\n… [truncated for context — ~' + Math.round(activeArtifact.content_md.length / 1000) + 'KB total]' : activeArtifact.content_md}`
        : ''

      // When the user made a text selection in the artifact, add a strict rewrite-only-this
      // instruction so the AI doesn't rewrite the whole file.
      const selectionInstruction = selectionContext && activeArtifact
        ? `\n\n## Selection to Edit
The user highlighted this exact text inside the artifact and wants YOU to change ONLY this span.
Everything else in the artifact must be preserved verbatim.

--- SELECTED TEXT (do not include these fences in your reply) ---
${selectionContext.selection}
--- END SELECTED TEXT ---

Rules for the reply:
1. Reply with a ONE-LINE explanation of what you changed and why.
2. Then the exact separator line: ---UPDATED_ARTIFACT---
3. Then the FULL updated artifact with ONLY the selection replaced by your revision.
4. If the selection appears multiple times in the artifact, replace ALL occurrences.
5. Do NOT rewrite other sections, do NOT reformat unaffected paragraphs.`
        : ''

      const systemPrompt = `You are an expert AI assistant embedded in Nexolab, a collaborative AI-driven software planning platform.

## Workspace
Feature: "${feat?.title}"
Status: ${feat?.status} | Current stage: ${feat?.current_stage_id ?? 'not started'}

## Pipeline stages & logs
${stagesContext || '  (none yet)'}

## Artifacts
${artifactsContext || '  (none yet)'}${activeArtifactContext}${selectionInstruction}

## Response guidelines
**Match depth to the question:**
- Simple status/factual questions → 1–3 sentences, direct answer.
- "What does X stage do?" or "explain Y" → a paragraph with key points.
- "Summarise the plan", "give me the full plan", "detail all stages/artifacts", "what was built" → write a thorough, well-structured response. Use headings, bullet lists, and cover every stage and artifact meaningfully. Do NOT truncate. This is the user's primary view into their project.
- Artifact edits → brief explanation of changes, then the full updated content after the exact separator line: ---UPDATED_ARTIFACT---

**Formatting:**
- Use markdown: **bold**, bullet lists, headings (##), inline code.
- Group related items. Make it scannable.
- Never fabricate data not present in the context above.`

      const historyMessages = history.slice(-12).map((h) => ({
        role: (h.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: h.text,
      }))

      // Workspace chat needs a longer window than a stage turn — it summarizes the whole plan
      // with 5+ artifacts + prior chat. Pass featureId so log lines are traceable.
      const result = await chat(
        [
          { role: 'system', content: systemPrompt },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        { featureId: id, timeoutMs: 120_000, maxTokens: 3000 },
      )

      const responseText = (result.message.content as string) ?? ''
      const separatorIdx = responseText.indexOf('---UPDATED_ARTIFACT---')

      let explanation = responseText
      let newContent: string | null = null
      let newVersion: number | null = null
      let updatedSlug: string | null = null

      if (separatorIdx !== -1 && activeArtifact) {
        explanation = responseText.slice(0, separatorIdx).trim()
        newContent = responseText.slice(separatorIdx + '---UPDATED_ARTIFACT---'.length).trim()
        // Snapshot the previous version so history is preserved even for AI edits.
        // Source depends on whether this was triggered by an inline selection edit.
        await snapshotArtifact(
          activeArtifact.id,
          req.user!.id,
          selectionContext ? 'ai-inline' : 'ai-chat',
        )
        const updateResult = await query<{ version: number }>(
          `UPDATE artifacts SET content_md = $1, version = version + 1, updated_at = now() WHERE id = $2 RETURNING version`,
          [newContent, activeArtifact.id],
        )
        newVersion = updateResult.rows[0]?.version ?? null
        updatedSlug = activeArtifact.slug
      }

      // Persist the assistant reply and broadcast it to all connected collaborators.
      const asstInsert = await query<{ id: string; created_at: Date }>(
        `INSERT INTO chat_messages (feature_id, user_id, role, text, artifact_slug_updated)
         VALUES ($1, NULL, 'assistant', $2, $3) RETURNING id, created_at`,
        [id, explanation, updatedSlug],
      )
      const asstMsg = asstInsert.rows[0]
      await safeBroadcast(
        `chat:${id}`,
        {
          type: 'message',
          id: asstMsg.id,
          role: 'assistant',
          text: explanation,
          artifact_slug_updated: updatedSlug,
          created_at: asstMsg.created_at,
        },
        // Fallback for a big reply — tell clients to re-fetch history to pick up this message.
        { type: 'message_ref', id: asstMsg.id },
      )

      // If an artifact was rewritten, broadcast a separate event so the editor pane refreshes.
      if (updatedSlug && newContent !== null) {
        await safeBroadcast(
          `chat:${id}`,
          {
            type: 'artifact_updated',
            slug: updatedSlug,
            content_md: newContent,
            version: newVersion,
          },
          // Fallback: lightweight change event; clients re-fetch by slug.
          { type: 'artifact_changed', slug: updatedSlug, version: newVersion },
        )
      }

      reply.send({
        ok: true,
        reply: explanation,
        didUpdate: newContent !== null,
        content_md: newContent ?? activeArtifact?.content_md ?? null,
        version: newVersion,
      })
    },
  )

  // GET /api/features/:id/chat/history - full persisted chat history for the feature.
  fastify.get<{ Params: { id: string } }>(
    '/api/features/:id/chat/history',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      const rows = await query<{
        id: string; user_id: string | null; role: string; text: string
        artifact_slug_updated: string | null; created_at: Date; user_name: string | null
      }>(
        `SELECT cm.id, cm.user_id, cm.role, cm.text, cm.artifact_slug_updated, cm.created_at, u.name AS user_name
         FROM chat_messages cm
         LEFT JOIN users u ON u.id = cm.user_id
         WHERE cm.feature_id = $1
         ORDER BY cm.created_at ASC`,
        [id],
      )
      reply.send({ messages: rows.rows })
    },
  )

  // DELETE /api/features/:id/chat/history - clear the persisted chat (owner only).
  // Broadcasts a 'cleared' event so all connected collaborators empty their view.
  fastify.delete<{ Params: { id: string } }>(
    '/api/features/:id/chat/history',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const ownerCheck = await query<{ creator_id: string }>(
        `SELECT creator_id FROM features WHERE id = $1`, [id],
      )
      if (!ownerCheck.rows.length) return reply.code(404).send({ error: 'not found' })
      if (ownerCheck.rows[0].creator_id !== req.user!.id) {
        return reply.code(403).send({ error: 'Only the feature owner can clear chat history.' })
      }
      await query(`DELETE FROM chat_messages WHERE feature_id = $1`, [id])
      await query(`SELECT pg_notify($1, $2)`, [`chat:${id}`, JSON.stringify({ type: 'cleared' })])
      reply.send({ ok: true })
    },
  )

  // GET /api/features/:id/stages/:stageSlug/logs - get tool call logs for a stage
  fastify.get<{ Params: { id: string; stageSlug: string } }>(
    '/api/features/:id/stages/:stageSlug/logs',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id, stageSlug } = req.params

      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      const stageRun = await query<{ id: string; execution_id: string; status: string; started_at: Date | null; completed_at: Date | null }>(
        `SELECT id, execution_id, status, started_at, completed_at FROM stage_runs
         WHERE feature_id = $1 AND stage_slug = $2
         ORDER BY created_at DESC LIMIT 1`,
        [id, stageSlug],
      )
      if (!stageRun.rows.length) return reply.send([])

      const logs = await query<{ step_id: string; tool_name: string; status: string; created_at: Date; completed_at: Date | null }>(
        `SELECT step_id, tool_name, status, created_at, completed_at
         FROM tool_calls
         WHERE execution_id = $1
         ORDER BY created_at`,
        [stageRun.rows[0].execution_id],
      )

      reply.send(logs.rows)
    },
  )

  // GET /api/features/:id/approvals - list members and their final approval status
  fastify.get<{ Params: { id: string } }>(
    '/api/features/:id/approvals',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const check = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!check.rows.length) return reply.code(404).send({ error: 'not found' })

      const rows = await query<{
        user_id: string; name: string; email: string
        verdict: string | null; approved_at: string | null
      }>(
        `SELECT u.id AS user_id, u.name, u.email,
                fa.verdict, fa.created_at AS approved_at
         FROM feature_members fm
         JOIN users u ON u.id = fm.user_id
         LEFT JOIN feature_approvals fa ON fa.feature_id = fm.feature_id AND fa.user_id = fm.user_id
         WHERE fm.feature_id = $1
         ORDER BY fm.joined_at`,
        [id],
      )
      reply.send(rows.rows)
    },
  )

  // POST /api/features/:id/approve — record this member's final approval.
  // When quorum_size (bounded by member_count) is reached, flip feature.status to 'planned'
  // so the Commit-to-repo button lights up. Broadcasts an event so all clients update live.
  fastify.post<{ Params: { id: string }; Body: { verdict?: string; comment?: string } }>(
    '/api/features/:id/approve',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const { verdict = 'approved', comment } = req.body ?? {}
      const check = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!check.rows.length) return reply.code(404).send({ error: 'not found' })

      await query(
        `INSERT INTO feature_approvals (feature_id, user_id, verdict, comment)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (feature_id, user_id) DO UPDATE SET verdict = EXCLUDED.verdict, comment = EXCLUDED.comment, created_at = now()`,
        [id, req.user!.id, verdict, comment ?? null],
      )

      // Check quorum. Effective quorum = min(configured, member_count) so solo users never block.
      const status = await query<{
        quorum_size: number; member_count: string; approved_count: string; feature_status: string
      }>(
        `SELECT f.quorum_size, f.status AS feature_status,
                COUNT(fm.user_id)::text AS member_count,
                COUNT(fa.user_id) FILTER (WHERE fa.verdict = 'approved')::text AS approved_count
         FROM features f
         JOIN feature_members fm ON fm.feature_id = f.id
         LEFT JOIN feature_approvals fa ON fa.feature_id = fm.feature_id AND fa.user_id = fm.user_id
         WHERE f.id = $1
         GROUP BY f.quorum_size, f.status`,
        [id],
      )
      const row = status.rows[0]
      const memberCount = parseInt(row?.member_count ?? '1', 10)
      const approved = parseInt(row?.approved_count ?? '0', 10)
      const configuredQuorum = row?.quorum_size ?? 1
      const effectiveQuorum = Math.min(configuredQuorum, memberCount)

      // Flip feature status to 'planned' the first time quorum is reached — but only if the
      // pipeline actually reached the approval stage (i.e. current_stage_id='approval').
      // Never regress an already-committed feature.
      if (approved >= effectiveQuorum && row?.feature_status !== 'committed' && row?.feature_status !== 'planned') {
        await query(
          `UPDATE features SET status = 'planned', updated_at = now() WHERE id = $1`,
          [id],
        )
      }

      // Broadcast so other members' UIs update live (button greys out when quorum reached).
      await safeBroadcast(`chat:${id}`, {
        type: 'approvals_changed',
        approved_count: approved,
        quorum: effectiveQuorum,
        member_count: memberCount,
      })

      reply.send({ ok: true, verdict, approved, quorum: effectiveQuorum, memberCount })
    },
  )

  // GET /api/features/:id/plan - get consolidated plan preview as markdown
  fastify.get<{ Params: { id: string } }>(
    '/api/features/:id/plan',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const memberCheck = await query(
        `SELECT 1 FROM feature_members WHERE feature_id = $1 AND user_id = $2`,
        [id, req.user!.id],
      )
      if (!memberCheck.rows.length) return reply.code(404).send({ error: 'not found' })

      const { consolidatePlan } = await import('../orchestrator/combine-plan.js')
      const { planMd, files } = await consolidatePlan(id)
      reply.send({ planMd, fileCount: files.length })
    },
  )

  // POST /api/features/:id/commit - commit plan to branch
  fastify.post<{ Params: { id: string } }>(
    '/api/features/:id/commit',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const featureRow = await query<{
        plan_branch: string; base_branch: string; title: string
        repo_id: string | null; slug: string; status: string
      }>(
        `SELECT f.plan_branch, f.base_branch, f.title, f.repo_id, f.slug, f.status
         FROM features f
         JOIN feature_members fm ON fm.feature_id = f.id
         WHERE f.id = $1 AND fm.user_id = $2`,
        [id, req.user!.id],
      )
      if (!featureRow.rows.length) return reply.code(404).send({ error: 'not found' })
      const feature = featureRow.rows[0]

      if (!feature.repo_id) return reply.code(400).send({ error: 'No repo connected' })

      // Require QUORUM_SIZE approvals (bounded by member count so solo users can commit).
      const approvalStatus = await query<{ total: string; approved: string; quorum: number }>(
        `SELECT COUNT(fm.user_id) AS total,
                COUNT(fa.user_id) FILTER (WHERE fa.verdict = 'approved') AS approved,
                f.quorum_size AS quorum
         FROM feature_members fm
         JOIN features f ON f.id = fm.feature_id
         LEFT JOIN feature_approvals fa ON fa.feature_id = fm.feature_id AND fa.user_id = fm.user_id
         WHERE fm.feature_id = $1
         GROUP BY f.quorum_size`,
        [id],
      )
      const total = parseInt(approvalStatus.rows[0]?.total ?? '1', 10)
      const approved = parseInt(approvalStatus.rows[0]?.approved ?? '0', 10)
      const configuredQuorum = approvalStatus.rows[0]?.quorum ?? 1
      const effectiveQuorum = Math.min(configuredQuorum, total)
      if (approved < effectiveQuorum) {
        return reply.code(400).send({
          error: `Waiting for approval: ${approved}/${effectiveQuorum} approvals recorded (quorum ${configuredQuorum}). Need at least ${effectiveQuorum} member${effectiveQuorum === 1 ? '' : 's'} to approve.`,
        })
      }

      const { planMd, files } = await consolidatePlan(id)
      const repoRow = await query<{ url: string }>('SELECT url FROM repos WHERE id = $1', [feature.repo_id])

      let sha: string
      try {
        sha = await commitPlan({
          featureId: id,
          planBranch: feature.plan_branch!,
          files,
          commitMessage: `plan: ${feature.title}`,
          identity: { email: req.user!.email, name: req.user!.name },
        })
      } catch (err) {
        // The push actually failed — do NOT flip status to 'committed'. Surface the real error.
        const msg = err instanceof Error ? err.message : String(err)
        req.log.error({ err }, `[commit] push failed for feature ${id}`)
        return reply.code(500).send({ error: `Commit failed: ${msg.slice(0, 500)}` })
      }

      // Only mark committed AFTER a verified push + SHA return.
      await query(
        `UPDATE features SET status = 'committed', committed_sha = $1, updated_at = now() WHERE id = $2`,
        [sha, id],
      )

      reply.send({ ok: true, sha, branch: feature.plan_branch, repo_url: repoRow.rows[0]?.url })
    },
  )
}
