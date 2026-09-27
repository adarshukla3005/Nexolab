import { query } from '../../db.js'
import type { ToolHandler } from '../tool-registry.js'

export const PARKED_SENTINEL = '__PARKED__'

export const schema = {
  type: 'function' as const,
  function: {
    name: 'ask_question',
    description: 'Ask the human team a clarifying question. This parks the current stage turn — the LLM MUST stop generating after calling this tool.',
    parameters: {
      type: 'object',
      required: ['text', 'type', 'options'],
      properties: {
        text: { type: 'string', description: 'The question text' },
        type: { type: 'string', enum: ['single', 'multi'], description: 'single or multi-select' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            required: ['label'],
            properties: {
              label: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
        step_id: { type: 'string', description: 'Idempotency key for this gate' },
      },
    },
  },
}

export const handler: ToolHandler = async (args, ctx) => {
  const { text, type, options, step_id } = args as {
    text: string; type: string; options: unknown[]; step_id?: string
  }

  const sid = step_id ?? `q_${Date.now()}`

  // Check if this gate already has an answer (resume path)
  const existing = await query<{ id: string; answer: unknown; status: string }>(
    `SELECT id, answer, status FROM human_gates
     WHERE stage_run_id = $1 AND step_id = $2`,
    [ctx.stageRunId, sid],
  )

  if (existing.rowCount && existing.rowCount > 0) {
    const gate = existing.rows[0]
    if (gate.status === 'answered') {
      return { answered: true, answer: gate.answer, gate_id: gate.id }
    }
    // Already pending — return parked again
    return {
      parked: true,
      humanTaskId: gate.id,
      message: 'Question parked. STOP NOW — do not generate further. Await the human answer.',
    }
  }

  // Insert a new pending gate
  const insert = await query<{ id: string }>(
    `INSERT INTO human_gates (feature_id, stage_run_id, kind, status, question_text, question_schema, step_id)
     VALUES ($1, $2, 'question', 'pending', $3, $4, $5)
     RETURNING id`,
    [ctx.featureId, ctx.stageRunId, text, JSON.stringify({ text, type, options }), sid],
  )

  const gateId = insert.rows[0].id
  return {
    parked: true,
    humanTaskId: gateId,
    message: 'Question parked. STOP NOW — do not generate further. Await the human answer.',
  }
}
