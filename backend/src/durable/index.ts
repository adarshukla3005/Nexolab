// Home-grown durable execution atop Postgres (adr-durable-exec-homegrown)
// Every checkpoint: look up existing tool_calls row; if succeeded, return cached output.
// Otherwise insert pending, run, update to succeeded/failed.

import { query, transaction } from '../db.js'

export interface CheckpointFn {
  <T>(stepId: string, toolName: string, args: unknown, run: () => Promise<T>): Promise<T>
}

export async function executeWithCheckpoints<T>(
  executionId: string,
  fn: (checkpoint: CheckpointFn) => Promise<T>,
): Promise<T> {
  const checkpoint: CheckpointFn = async <R>(
    stepId: string,
    toolName: string,
    args: unknown,
    run: () => Promise<R>,
  ): Promise<R> => {
    // Check for existing succeeded call
    const existing = await query<{ output: unknown; status: string }>(
      `SELECT output, status FROM tool_calls WHERE execution_id = $1 AND step_id = $2`,
      [executionId, stepId],
    )

    if (existing.rowCount && existing.rowCount > 0) {
      const row = existing.rows[0]
      if (row.status === 'succeeded') {
        return row.output as R
      }
      if (row.status === 'pending') {
        // Crashed mid-flight — re-run
        console.log(`[durable] re-running crashed step ${stepId}`)
      }
    } else {
      // Insert pending row
      await query(
        `INSERT INTO tool_calls (execution_id, step_id, tool_name, args, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (execution_id, step_id) DO NOTHING`,
        [executionId, stepId, toolName, JSON.stringify(args)],
      )
    }

    try {
      const output = await run()
      await query(
        `UPDATE tool_calls SET status = 'succeeded', output = $1, completed_at = now()
         WHERE execution_id = $2 AND step_id = $3`,
        [JSON.stringify(output), executionId, stepId],
      )
      return output
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await query(
        `UPDATE tool_calls SET status = 'failed', error = $1, completed_at = now()
         WHERE execution_id = $2 AND step_id = $3`,
        [errorMsg, executionId, stepId],
      )
      throw err
    }
  }

  return fn(checkpoint)
}

export async function resumeExecution(executionId: string): Promise<{
  lastStepId: string | null
  completedSteps: string[]
}> {
  const rows = await query<{ step_id: string; status: string }>(
    `SELECT step_id, status FROM tool_calls WHERE execution_id = $1 ORDER BY created_at`,
    [executionId],
  )
  const completed = rows.rows.filter((r) => r.status === 'succeeded').map((r) => r.step_id)
  const last = rows.rows[rows.rows.length - 1]?.step_id ?? null
  return { lastStepId: last, completedSteps: completed }
}
