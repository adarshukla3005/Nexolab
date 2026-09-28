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

  // Guard: refuse to close the stage if no artifact was ever produced.
  // Some models (esp. Sonnet under tool-use) call create_artifact with content missing,
  // ignore the validation error, and then call send_output — which used to close the
  // stage with zero saved work. Now we refuse and demand a proper create_artifact call.
  const hasArtifact = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM artifacts WHERE stage_run_id = $1`,
    [ctx.stageRunId],
  )
  if (Number(hasArtifact.rows[0]?.n ?? '0') === 0) {
    return {
      error:
        'Cannot send_output: no artifact was produced for this stage. You MUST call create_artifact with ALL required fields (artifact_type, slug, title, and — most importantly — content containing the full markdown body). Do not call send_output again until create_artifact succeeds (returns { ok: true, artifact_id }).',
    }
  }

  await query(
    `UPDATE stage_runs SET status = 'done', completed_at = now() WHERE id = $1`,
    [ctx.stageRunId],
  )
  return { ok: true, message, artifacts_produced }
}
