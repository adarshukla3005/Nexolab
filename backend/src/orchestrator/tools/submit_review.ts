import { query } from '../../db.js'
import type { ToolHandler } from '../tool-registry.js'

export const schema = {
  type: 'function' as const,
  function: {
    name: 'submit_review',
    description: 'Reviewer agent submits review verdict for the current stage.',
    parameters: {
      type: 'object',
      required: ['verdict'],
      properties: {
        verdict: { type: 'string', enum: ['READY', 'NOT-READY'] },
        findings: { type: 'string', description: 'Reviewer findings or approval notes' },
      },
    },
  },
}

export const handler: ToolHandler = async (args, ctx) => {
  const { verdict, findings = '' } = args as { verdict: string; findings?: string }
  await query(
    `UPDATE stage_runs SET reviewer_findings = $1 WHERE id = $2`,
    [findings, ctx.stageRunId],
  )
  return { ok: true, verdict, findings }
}
