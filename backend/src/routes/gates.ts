import type { FastifyPluginAsync } from 'fastify'
import { query } from '../db.js'
import { authMiddleware } from '../auth/middleware.js'
import { resumeParked } from '../orchestrator/runner.js'

export const gatesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/features/:id/gates - list pending gates, each with approvals + quorum info.
  fastify.get<{ Params: { id: string } }>(
    '/api/features/:id/gates',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const rows = await query<{
        id: string; kind: string; status: string; question_text: string
        question_schema: unknown; answer: unknown; step_id: string; created_at: Date
      }>(
        `SELECT hg.id, hg.kind, hg.status, hg.question_text, hg.question_schema, hg.answer, hg.step_id, hg.created_at
         FROM human_gates hg
         JOIN feature_members fm ON fm.feature_id = hg.feature_id
         WHERE hg.feature_id = $1 AND fm.user_id = $2
         ORDER BY hg.created_at DESC`,
        [id, req.user!.id],
      )
      if (!rows.rows.length) { reply.send([]); return }

      // Fetch quorum config + member count for this feature.
      const meta = await query<{ quorum_size: number; member_count: string }>(
        `SELECT f.quorum_size, COUNT(fm.user_id) AS member_count
         FROM features f JOIN feature_members fm ON fm.feature_id = f.id
         WHERE f.id = $1 GROUP BY f.quorum_size`,
        [id],
      )
      const memberCount = parseInt(meta.rows[0]?.member_count ?? '1', 10)
      const configuredQuorum = meta.rows[0]?.quorum_size ?? 1
      const effectiveQuorum = Math.min(configuredQuorum, memberCount)

      // Fetch approvals for validation gates in this feature.
      const gateIds = rows.rows.filter((g) => g.kind === 'validation').map((g) => g.id)
      const approvalMap = new Map<string, Array<{ user_id: string; name: string; verdict: string }>>()
      if (gateIds.length) {
        const apprRows = await query<{ gate_id: string; user_id: string; name: string; verdict: string }>(
          `SELECT a.gate_id, a.user_id, u.name, a.verdict
           FROM approvals a JOIN users u ON u.id = a.user_id
           WHERE a.gate_id = ANY($1::uuid[])`,
          [gateIds],
        )
        for (const a of apprRows.rows) {
          const list = approvalMap.get(a.gate_id) ?? []
          list.push({ user_id: a.user_id, name: a.name, verdict: a.verdict })
          approvalMap.set(a.gate_id, list)
        }
      }

      const enriched = rows.rows.map((g) => ({
        ...g,
        approvals: approvalMap.get(g.id) ?? [],
        quorum: effectiveQuorum,
        member_count: memberCount,
      }))
      reply.send(enriched)
    },
  )

  // POST /api/gates/:gateId/answer - submit answer / approve
  fastify.post<{ Params: { gateId: string }; Body: { answer: unknown; verdict?: string } }>(
    '/api/gates/:gateId/answer',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { gateId } = req.params
      const { answer, verdict } = req.body

      const gateRow = await query<{
        id: string; kind: string; feature_id: string; status: string
      }>(
        `SELECT hg.id, hg.kind, hg.feature_id, hg.status
         FROM human_gates hg
         JOIN feature_members fm ON fm.feature_id = hg.feature_id
         WHERE hg.id = $1 AND fm.user_id = $2`,
        [gateId, req.user!.id],
      )
      if (!gateRow.rows.length) return reply.code(404).send({ error: 'gate not found' })
      const gate = gateRow.rows[0]

      if (gate.kind === 'validation') {
        // Record approval
        await query(
          `INSERT INTO approvals (gate_id, user_id, verdict, comment)
           VALUES ($1, $2, $3, $4) ON CONFLICT (gate_id, user_id) DO UPDATE SET verdict = EXCLUDED.verdict`,
          [gateId, req.user!.id, verdict ?? 'approved', null],
        )

        // Check quorum — also count actual members so a solo user never gets stuck
        const featureRow = await query<{ quorum_size: number; member_count: string }>(
          `SELECT f.quorum_size, COUNT(fm.user_id) AS member_count
           FROM features f
           JOIN feature_members fm ON fm.feature_id = f.id
           WHERE f.id = $1
           GROUP BY f.quorum_size`,
          [gate.feature_id],
        )
        const approvals = await query<{ count: string }>(
          `SELECT COUNT(*) FROM approvals WHERE gate_id = $1 AND verdict = 'approved'`, [gateId],
        )
        const configuredQuorum = featureRow.rows[0]?.quorum_size ?? 1
        const memberCount = parseInt(featureRow.rows[0]?.member_count ?? '1', 10)
        // Effective quorum: min of configured quorum and actual member count (solo users never blocked)
        const quorum = Math.min(configuredQuorum, memberCount)
        const count = parseInt(approvals.rows[0].count, 10)

        if (count >= quorum) {
          await resumeParked(gateId, { verdict: 'approved' })
        }

        reply.send({ ok: true, approvals: count, quorum })
        return
      }

      // Question gate
      await resumeParked(gateId, answer)
      reply.send({ ok: true })
    },
  )

  // GET /api/features/:id/stage-runs - list stage runs
  fastify.get<{ Params: { id: string } }>(
    '/api/features/:id/stage-runs',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const { id } = req.params
      const rows = await query<{
        id: string; stage_slug: string; status: string; reviewer_findings: string | null
        started_at: Date | null; completed_at: Date | null; created_at: Date
      }>(
        `SELECT sr.id, sr.stage_slug, sr.status, sr.reviewer_findings,
                sr.started_at, sr.completed_at, sr.created_at
         FROM stage_runs sr
         JOIN feature_members fm ON fm.feature_id = sr.feature_id
         WHERE sr.feature_id = $1 AND fm.user_id = $2
         ORDER BY sr.created_at DESC`,
        [id, req.user!.id],
      )
      reply.send(rows.rows)
    },
  )
}
