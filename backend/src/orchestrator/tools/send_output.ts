import { query } from '../../db.js'
import type { ToolHandler } from '../tool-registry.js'

export const schema = {
  type: 'function' as const,
  function: {
    name: 'send_output',
    description: 'Send a summary output when the stage is complete. Call once at the end of the stage.',
    parameters: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'Stage completion summary' },
        artifacts_produced: { type: 'array', items: { type: 'string' }, description: 'List of artifact slugs produced' },
      },
    },
  },
}

export const handler: ToolHandler = async (args, ctx) => {
  const { message, artifacts_produced = [] } = args as { message: string; artifacts_produced?: string[] }
  await query(
    `UPDATE stage_runs SET status = 'done', completed_at = now() WHERE id = $1`,
    [ctx.stageRunId],
  )
  return { ok: true, message, artifacts_produced }
}
