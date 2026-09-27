import { query } from '../../db.js'
import type { ToolHandler } from '../tool-registry.js'

interface QuestionItem {
  id: string // stable idempotency key e.g. "q_perf_1"
  text: string
  type: 'single' | 'multi' | 'text'
  options?: Array<{ label: string; description?: string }>
}

export const schema = {
  type: 'function' as const,
  function: {
    name: 'ask_questions_batch',
    description: 'Ask the human team ALL questions for this stage in one call. Creates a single gate with all questions — the user answers them all at once. MUCH preferred over calling ask_question multiple times. Call this ONCE with all your questions, then STOP.',
    parameters: {
      type: 'object',
      required: ['title', 'questions'],
      properties: {
        title: { type: 'string', description: 'Short title shown above the question form, e.g. "NFR Requirements Questions"' },
        questions: {
          type: 'array',
          description: 'All questions to ask in one batch',
          items: {
            type: 'object',
            required: ['id', 'text', 'type'],
            properties: {
              id: { type: 'string', description: 'Stable idempotency key, e.g. "q_perf_1"' },
              text: { type: 'string', description: 'The question text' },
              type: { type: 'string', enum: ['single', 'multi', 'text'], description: 'single-select, multi-select, or free-text' },
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
            },
          },
        },
        batch_step_id: { type: 'string', description: 'Idempotency key for this entire batch gate' },
      },
    },
  },
}

export const handler: ToolHandler = async (args, ctx) => {
  const { title, questions, batch_step_id } = args as {
    title: string
    questions: QuestionItem[]
    batch_step_id?: string
  }

  const sid = batch_step_id ?? `batch_${ctx.stageRunId}`

  // Check if this batch gate already exists
  const existing = await query<{ id: string; answer: unknown; status: string }>(
    `SELECT id, answer, status FROM human_gates
     WHERE stage_run_id = $1 AND step_id = $2`,
    [ctx.stageRunId, sid],
  )

  if (existing.rowCount && existing.rowCount > 0) {
    const gate = existing.rows[0]
    if (gate.status === 'answered') {
      return { answered: true, answers: gate.answer, gate_id: gate.id }
    }
    return {
      parked: true,
      humanTaskId: gate.id,
      message: 'Batch questions parked. STOP NOW — do not generate further. Await the human answers.',
    }
  }

  // Build the gate schema: embed all questions as the options array with metadata
  const gateSchema = {
    text: title,
    type: 'batch' as const,
    questions,
  }

  const insert = await query<{ id: string }>(
    `INSERT INTO human_gates (feature_id, stage_run_id, kind, status, question_text, question_schema, step_id)
     VALUES ($1, $2, 'question', 'pending', $3, $4, $5)
     RETURNING id`,
    [ctx.featureId, ctx.stageRunId, title, JSON.stringify(gateSchema), sid],
  )

  const gateId = insert.rows[0].id
  return {
    parked: true,
    humanTaskId: gateId,
    message: 'Batch questions parked. STOP NOW — do not generate further. Await the human answers.',
  }
}
