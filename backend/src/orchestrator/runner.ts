import { randomUUID } from 'crypto'
import { query } from '../db.js'
import { chat } from '../llm/client.js'
import { materializeStagePrompt } from './stage-materializer.js'
import { getToolSchemas, dispatchTool, type ToolContext } from './tool-registry.js'
import { executeWithCheckpoints } from '../durable/index.js'
import { runReviewer } from './reviewer.js'
import { nextStage, isLastStage, FEATURE_WORKFLOW } from './workflow.js'
import { INTAKE_TITLE, OTHER_OPTION } from './intake-questions.js'
import { generateIntakeQuestions } from './intake-generator.js'
import { combinePlanArtifact } from './combine-plan.js'
import type { ChatCompletionMessageParam } from 'openai/resources/index.js'

// Iteration budget per stage. Technical is the heaviest — it synthesizes proposal+spec+design
// into a file-level task list and typically needs the most repo exploration turns.
const STAGE_BASE_BUDGET: Record<string, number> = {
  proposal: 30,
  spec: 30,
  design: 30,
  technical: 50,
}
const DEFAULT_STAGE_BUDGET = 30
// Absolute ceiling — even with dynamic extensions we never exceed this per stage.
const ABSOLUTE_MAX_BUDGET = 50
// Extension applied when the AI is making real progress but running low on budget.
const BUDGET_EXTENSION = 10

// Keep the last `keepTurns` complete assistant+tool-result turn pairs plus system+first-user.
// A "turn" = one assistant message + zero or more immediately following tool messages.
// Pruning mid-turn corrupts the toolResult→toolUse pairing that Bedrock enforces, so we
// only drop whole turns from the oldest end of the middle section.
function pruneTurns(messages: ChatCompletionMessageParam[], keepTurns: number): void {
  if (messages.length <= 2) return // nothing to prune

  // Slice off head (system + first user) then partition the rest into turns.
  const head = messages.slice(0, 2)
  const body = messages.slice(2)

  // Group body into turns: each starts at an 'assistant' message
  const turns: ChatCompletionMessageParam[][] = []
  for (const msg of body) {
    if (msg.role === 'assistant') {
      turns.push([msg])
    } else if (turns.length > 0) {
      turns[turns.length - 1].push(msg) // tool result or user nudge — attach to current turn
    }
    // orphan messages before the first assistant are discarded
  }

  if (turns.length <= keepTurns) return // nothing to drop

  const kept = turns.slice(-keepTurns).flat()
  messages.splice(0, messages.length, ...head, ...kept)
}

// Ensures the OpenSpec intake questionnaire has been answered for this feature.
// Creates the gate on first call; returns 'answered' | 'parked'.
async function ensureIntakeAnswered(
  featureId: string,
  stageRunId: string,
): Promise<'answered' | 'parked'> {
  // Look for any prior intake gate on this feature (kind='question', step_id='intake_batch').
  const existing = await query<{ id: string; status: string }>(
    `SELECT id, status FROM human_gates
     WHERE feature_id = $1 AND step_id = 'intake_batch'
     ORDER BY created_at ASC LIMIT 1`,
    [featureId],
  )

  if (existing.rowCount && existing.rows[0].status === 'answered') {
    return 'answered'
  }

  if (existing.rowCount && existing.rows[0].status === 'pending') {
    return 'parked'
  }

  // No gate yet — ask the AI to generate feature-specific intake questions (falls back
  // to a hardcoded set if the LLM call fails / times out). Result is cached on the gate.
  const generated = await generateIntakeQuestions(featureId)

  // Convert to the batch-gate schema GateCard renders. For single/multi types, append
  // "Other (specify)" as the last option so users can supply free-text answers.
  const questions = generated.map((q) => ({
    id: q.id,
    text: q.hint ? `${q.text}\n\n_${q.hint}_` : q.text,
    type: q.type,
    options: q.type === 'text' ? undefined
      : [...(q.options ?? []), OTHER_OPTION].map((label) => ({ label })),
  }))
  const gateSchema = { text: INTAKE_TITLE, type: 'batch' as const, questions }

  await query(
    `INSERT INTO human_gates (feature_id, stage_run_id, kind, status, question_text, question_schema, step_id)
     VALUES ($1, $2, 'intake', 'pending', $3, $4, $5)`,
    [featureId, stageRunId, INTAKE_TITLE, JSON.stringify(gateSchema), 'intake_batch'],
  )
  return 'parked'
}

export async function runStage(featureId: string, stageRunId: string): Promise<void> {
  const runRow = await query<{
    stage_slug: string; execution_id: string; status: string
    feature_prompt: string; feature_title: string; source_ref: string
    repo_id: string | null
  }>(
    `SELECT sr.stage_slug, sr.execution_id, sr.status,
            f.prompt AS feature_prompt, f.title AS feature_title,
            b.source_ref,
            f.repo_id
     FROM stage_runs sr
     JOIN features f ON f.id = sr.feature_id
     JOIN blocks b ON b.block_type = 'STAGE' AND b.slug = sr.stage_slug
     WHERE sr.id = $1
     LIMIT 1`,
    [stageRunId],
  )

  if (!runRow.rows.length) throw new Error(`Stage run not found: ${stageRunId}`)
  const run = runRow.rows[0]

  if (run.status === 'done') return // already complete

  await query(`UPDATE stage_runs SET status = 'running', started_at = now() WHERE id = $1`, [stageRunId])
  await query(`UPDATE features SET current_stage_id = $1, updated_at = now() WHERE id = $2`,
    [run.stage_slug, featureId])

  // review stage — no LLM work. Just build the combined PLAN.md artifact, mark stage done,
  // then open a validation gate so the team can read the plan and click Approve.
  if (run.stage_slug === 'review') {
    try {
      await combinePlanArtifact(featureId)
    } catch (err) {
      console.error(`[runner] review stage combine-plan failed for feature=${featureId}:`, err)
    }
    await query(`UPDATE stage_runs SET status = 'done', completed_at = now() WHERE id = $1`, [stageRunId])
    await runReviewerAndGate(featureId, stageRunId, run.stage_slug, { featureId, stageRunId, role: 'reviewer' })
    return
  }

  // approval stage — no LLM, no artifact, and NO generic validation gate.
  // The approval flow uses feature_approvals (per-user records) surfaced by the frontend
  // as the big "Approve plan" bottom bar. Once quorum is met, POST /approve flips
  // feature.status to 'planned' and Commit-to-repo enables.
  if (run.stage_slug === 'approval') {
    await query(`UPDATE stage_runs SET status = 'done', completed_at = now() WHERE id = $1`, [stageRunId])
    return
  }

  // OpenSpec: park the very first stage on the intake questionnaire until the user answers it.
  // Subsequent stages read the answers from the gate via the stage-materializer.
  if (run.stage_slug === FEATURE_WORKFLOW[0]) {
    const state = await ensureIntakeAnswered(featureId, stageRunId)
    if (state === 'parked') {
      await query(`UPDATE stage_runs SET status = 'parked' WHERE id = $1`, [stageRunId])
      console.log(`[runner] parked ${run.stage_slug} on intake questionnaire (feature=${featureId})`)
      return
    }
  }

  const ctx: ToolContext = { featureId, stageRunId, role: 'author' }

  try {
    await executeWithCheckpoints(run.execution_id, async (checkpoint) => {
      const systemPrompt = await checkpoint(
        'materialize-prompt',
        'materialize_stage_prompt',
        { featureId, stageSlug: run.stage_slug },
        () => materializeStagePrompt({
          featureId,
          stageSlug: run.stage_slug,
          featureTitle: run.feature_title,
          featurePrompt: run.feature_prompt,
          sourceRef: run.source_ref,
        }),
      )

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Please run the ${run.stage_slug} stage now.` },
      ]

      let consecutiveTextOnlyTurns = 0
      let consecutiveReadOnlyTurns = 0 // turns with only get_artifact/read_repo_file/list_repo_tree calls
      let hasCreatedArtifact = false // flips true once the AI calls create_artifact / update_artifact
      // Track create_artifact calls per slug so we can nudge the AI to stop refining and finalize.
      const createCountBySlug = new Map<string, number>()
      // Dynamic budget: starts at STAGE_BASE_BUDGET, extended up to ABSOLUTE_MAX_BUDGET when
      // the AI keeps making real progress near the current limit.
      let budget = Math.min(STAGE_BASE_BUDGET[run.stage_slug] ?? DEFAULT_STAGE_BUDGET, ABSOLUTE_MAX_BUDGET)
      // Track if the previous turn produced real progress (artifact create/update or repo read).
      // Used to decide whether extending the budget is worthwhile.
      let lastTurnMadeProgress = false

      for (let i = 0; i < budget; i++) {
        // Check if the stage was stopped externally — exit cleanly without marking failed
        const statusCheck = await query<{ status: string }>(
          `SELECT status FROM stage_runs WHERE id = $1`, [stageRunId],
        )
        if (statusCheck.rows[0]?.status === 'stopped') return

        const result = await checkpoint(
          `llm-turn-${i}`,
          'llm_chat',
          { turn: i },
          () => chat(messages, {
            tools: getToolSchemas('author'),
            featureId,
            stageRunId,
            // Stage turns can be big prompts producing long artifacts; 45s isn't always enough.
            timeoutMs: 120_000,
          }),
        )

        messages.push(result.message)

        if (!result.message.tool_calls?.length) {
          consecutiveTextOnlyTurns++
          // After 1 text-only turn inject a nudge; after 3 in a row, treat as done
          if (consecutiveTextOnlyTurns <= 2 && i < budget - 2) {
            messages.push({
              role: 'user',
              content: 'You wrote your response as plain text instead of calling a tool. IMPORTANT: You MUST call a tool now. Use `ask_question` to collect user input, `create_artifact` to save an artifact, or `send_output` when the stage is complete. Do not write any more plain text — call a tool immediately.',
            })
            continue
          }
          break // accepted as stage completion after repeated nudges
        }

        consecutiveTextOnlyTurns = 0

        // Track read-only loops — nudge will be injected AFTER tool results (never between assistant and tool results)
        const readOnlyTools = new Set(['get_artifact', 'read_repo_file', 'list_repo_tree'])
        const allReadsThisTurn = result.message.tool_calls?.every(tc => readOnlyTools.has(tc.function.name))
        if (allReadsThisTurn) {
          consecutiveReadOnlyTurns++
        } else {
          consecutiveReadOnlyTurns = 0
        }

        let parked = false
        let stageDone = false

        // Execute all tool calls for this turn, then push ALL results as one message.
        // Bedrock requires all toolResult blocks for a turn in a single user message.
        const toolResults: { tool_call_id: string; content: string }[] = []

        for (const tc of result.message.tool_calls) {
          let args: unknown
          try { args = JSON.parse(tc.function.arguments) } catch { args = {} }

          const output = await checkpoint(
            `tool-${tc.id}`,
            tc.function.name,
            args,
            () => dispatchTool(tc.function.name, args, ctx),
          )

          toolResults.push({
            tool_call_id: tc.id,
            content: JSON.stringify(output),
          })

          // Check for park signal
          if (
            (tc.function.name === 'ask_question' || tc.function.name === 'ask_questions_batch') &&
            (output as { parked?: boolean }).parked
          ) {
            await query(`UPDATE stage_runs SET status = 'parked' WHERE id = $1`, [stageRunId])
            parked = true
          }

          // If ask_question came back answered with an APPROVE decision, treat it as stage done.
          if (
            (tc.function.name === 'ask_question' || tc.function.name === 'ask_questions_batch') &&
            (output as { answered?: boolean }).answered
          ) {
            const ans = String((output as { answer?: unknown }).answer ?? '')
            if (/APPROVE|approve/i.test(ans)) {
              await query(`UPDATE stage_runs SET status = 'done', completed_at = now() WHERE id = $1`, [stageRunId])
              stageDone = true
            }
          }

          if (tc.function.name === 'send_output') {
            stageDone = true
          }

          // Track whether the AI has actually produced this stage's artifact yet, and count
          // how many times it has re-created each slug (used for the "stop refining" nudge).
          if (tc.function.name === 'create_artifact' || tc.function.name === 'update_artifact') {
            hasCreatedArtifact = true
            const slug = (args as { slug?: string })?.slug
            if (slug) createCountBySlug.set(slug, (createCountBySlug.get(slug) ?? 0) + 1)
          }
        }

        // Real progress this turn = tool calls that either produced an artifact OR read repo/prior artifacts.
        // Used to decide whether it's worth extending the budget near the ceiling.
        const progressTools = new Set(['create_artifact', 'update_artifact', 'read_repo_file', 'list_repo_tree', 'get_artifact'])
        lastTurnMadeProgress = !!result.message.tool_calls?.some((tc) => progressTools.has(tc.function.name))

        // Push tool results — one message per result (standard OpenAI format).
        // LiteLLM translates these into Bedrock's batched toolResult format.
        for (const tr of toolResults) {
          messages.push({ role: 'tool' as const, tool_call_id: tr.tool_call_id, content: tr.content })
        }

        // Inject read-only nudge AFTER tool results so we never break assistant→tool sequence
        if (consecutiveReadOnlyTurns >= 3) {
          messages.push({
            role: 'user',
            content: 'You have been reading artifacts/files for several turns without creating anything. STOP reading — you have enough context. Call `create_artifact` NOW to save your work, or call `send_output` if the stage is already complete.',
          })
          consecutiveReadOnlyTurns = 0
        }

        // Redundancy nudge: after 3 create_artifact calls on the SAME slug, tell the AI to stop
        // refining and finalize. This prevents the "polish forever without send_output" pattern.
        const overRefined = [...createCountBySlug.entries()].find(([, n]) => n >= 3)
        if (overRefined && !stageDone) {
          messages.push({
            role: 'user',
            content: `You have re-created "${overRefined[0]}" ${overRefined[1]} times. It's good enough. Call \`send_output\` NOW to complete the stage. Do NOT create or update it again.`,
          })
          // Reset so we don't spam this nudge every turn.
          createCountBySlug.set(overRefined[0], 0)
        }

        // Escalating nudges when the AI keeps exploring without ever producing the artifact.
        if (!hasCreatedArtifact && i === 8) {
          messages.push({
            role: 'user',
            content: `You are on turn ${i + 1} of ${budget} and have NOT yet called \`create_artifact\`. You have enough context. Produce the artifact for the ${run.stage_slug} stage on the NEXT turn — do not read any more files.`,
          })
        }
        if (hasCreatedArtifact && !stageDone && i === budget - 3) {
          messages.push({
            role: 'user',
            content: 'You have already created the artifact. Call `send_output` on the next turn to complete the stage.',
          })
        }

        // Prune after a complete turn (assistant + all its tool results are now in messages).
        pruneTurns(messages, 6)

        if (parked || stageDone) break

        // Dynamic budget extension: if we're within 2 turns of the current budget AND real progress
        // is being made AND we haven't hit the absolute ceiling, extend by BUDGET_EXTENSION turns.
        // This gives complex stages more room without letting runaway loops burn forever.
        if (i === budget - 2 && lastTurnMadeProgress && budget < ABSOLUTE_MAX_BUDGET) {
          const newBudget = Math.min(budget + BUDGET_EXTENSION, ABSOLUTE_MAX_BUDGET)
          console.log(`[runner] stage ${run.stage_slug} budget extended ${budget} → ${newBudget} (progress on turn ${i})`)
          budget = newBudget
        }
      }

      // Auto-finalize: loop exited without send_output. Never fail — save what we have.
      // Case A: an artifact for this stage was created → treat as done.
      // Case B: NO artifact yet → do one final "write it now, plain markdown" turn, save the
      // response as the stage's artifact, then mark done.
      const finalStatus = await query<{ status: string }>(`SELECT status FROM stage_runs WHERE id = $1`, [stageRunId])
      const stageStatus = finalStatus.rows[0]?.status
      if (stageStatus !== 'done' && stageStatus !== 'parked' && stageStatus !== 'stopped') {
        console.log(`[runner] stage ${run.stage_slug} loop exited without send_output — auto-finalizing`)
        const anyArt = await query<{ id: string }>(
          `SELECT id FROM artifacts WHERE feature_id = $1 AND stage_run_id = $2 LIMIT 1`,
          [featureId, stageRunId],
        )
        if (anyArt.rowCount === 0) {
          // Case B: no artifact — do one last plain-markdown turn.
          try {
            const finalizeResult = await chat(
              [...messages, {
                role: 'user',
                content: `You are out of tool-call turns. Reply RIGHT NOW with ONLY the final markdown for the ${run.stage_slug} artifact — no commentary, no tool calls, no code fences. Just the artifact body.`,
              }],
              { featureId, stageRunId, timeoutMs: 120_000, maxTokens: 4000 },
            )
            const md = String(finalizeResult.message.content ?? '').trim()
            if (md) {
              await query(
                `INSERT INTO artifacts (feature_id, stage_run_id, artifact_type, slug, title, content_md)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (feature_id, slug) DO UPDATE SET
                   content_md = EXCLUDED.content_md,
                   version = artifacts.version + 1,
                   updated_at = now()
                 RETURNING id`,
                [featureId, stageRunId, `openspec-${run.stage_slug}`, run.stage_slug,
                 `${run.stage_slug} — ${run.feature_title}`, md],
              )
              console.log(`[runner] stage ${run.stage_slug} — auto-saved final artifact (${md.length} chars)`)
            }
          } catch (err) {
            console.error(`[runner] auto-finalize final-turn failed for ${run.stage_slug}:`, err)
          }
        }
        // Mark done either way — a stage that produced work should never block the pipeline.
        await query(`UPDATE stage_runs SET status = 'done', completed_at = now() WHERE id = $1`, [stageRunId])
      }
    })

    // Auto-finalize inside the loop always marks the stage 'done' unless it was parked/stopped.
    // We only need to open the reviewer gate for the done case.
    const statusRow = await query<{ status: string }>(
      `SELECT status FROM stage_runs WHERE id = $1`, [stageRunId],
    )
    if (statusRow.rows[0]?.status === 'done') {
      await runReviewerAndGate(featureId, stageRunId, run.stage_slug, ctx)
    }
  } catch (err) {
    await query(
      `UPDATE stage_runs SET status = 'failed' WHERE id = $1`,
      [stageRunId],
    )
    throw err
  }
}

async function runReviewerAndGate(
  featureId: string,
  stageRunId: string,
  stageSlug: string,
  ctx: ToolContext,
): Promise<void> {
  const artifacts = await query<{ slug: string; content_md: string }>(
    `SELECT slug, content_md FROM artifacts WHERE feature_id = $1 AND stage_run_id = $2`,
    [featureId, stageRunId],
  )

  const review = await runReviewer({
    stageSlug,
    artifacts: artifacts.rows,
    ctx: { ...ctx, role: 'reviewer' },
  })

  await query(
    `UPDATE stage_runs SET reviewer_findings = $1 WHERE id = $2`,
    [review.findings, stageRunId],
  )

  // Open validation gate
  await query(
    `INSERT INTO human_gates (feature_id, stage_run_id, kind, status, question_text, step_id)
     VALUES ($1, $2, 'validation', 'pending', $3, 'validation-gate')`,
    [featureId, stageRunId,
      `Stage "${stageSlug}" is ready for review. Reviewer: ${review.verdict}. ${review.findings}`],
  )
}

export async function advanceStage(featureId: string): Promise<string | null> {
  const featureRow = await query<{
    current_stage_id: string | null; source_ref: string; title: string; prompt: string
  }>(
    `SELECT f.current_stage_id, b.source_ref, f.title, f.prompt
     FROM features f
     JOIN blocks b ON b.block_type = 'STAGE'
     WHERE f.id = $1 LIMIT 1`,
    [featureId],
  )
  if (!featureRow.rows.length) throw new Error(`Feature not found: ${featureId}`)

  const current = featureRow.rows[0].current_stage_id
  const next = current ? nextStage(current) : FEATURE_WORKFLOW[0]

  if (!next) {
    // Final planning stage done — mark feature 'planned' (ready for commit).
    // The 'committed' status is reserved for after a real git push in /api/features/:id/commit.
    await query(`UPDATE features SET status = 'planned', updated_at = now() WHERE id = $1`, [featureId])
    return null
  }

  const executionId = randomUUID()
  const newRun = await query<{ id: string }>(
    `INSERT INTO stage_runs (feature_id, stage_slug, execution_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [featureId, next, executionId],
  )
  const newRunId = newRun.rows[0].id

  // Kick off in background (don't await)
  runStage(featureId, newRunId).catch((err) =>
    console.error(`[runner] runStage failed for ${newRunId}:`, err),
  )

  return newRunId
}

export async function resumeParked(gateId: string, answer: unknown): Promise<void> {
  const gateRow = await query<{ stage_run_id: string; feature_id: string; step_id: string; kind: string }>(
    `SELECT stage_run_id, feature_id, step_id, kind FROM human_gates WHERE id = $1`,
    [gateId],
  )
  if (!gateRow.rows.length) throw new Error(`Gate not found: ${gateId}`)
  const gate = gateRow.rows[0]

  if (gate.kind === 'validation') {
    // Validation gate approved → advance
    await query(`UPDATE human_gates SET status = 'approved', answered_at = now() WHERE id = $1`, [gateId])
    await advanceStage(gate.feature_id)
    return
  }

  // Question gate — save answer and resume execution
  await query(
    `UPDATE human_gates SET status = 'answered', answer = $1, answered_at = now() WHERE id = $2`,
    [JSON.stringify(answer), gateId],
  )

  const runRow = await query<{ execution_id: string; status: string; id: string }>(
    `SELECT id, execution_id, status FROM stage_runs WHERE id = $1`,
    [gate.stage_run_id],
  )
  if (!runRow.rows.length) return

  // Delete cached ask_question / ask_questions_batch checkpoints so they re-execute on resume
  // (executeWithCheckpoints caches {parked:true} — on resume the tool must re-run to return the answer)
  await query(
    `DELETE FROM tool_calls WHERE execution_id = $1 AND tool_name IN ('ask_question', 'ask_questions_batch')`,
    [runRow.rows[0].execution_id],
  )

  await query(`UPDATE stage_runs SET status = 'running' WHERE id = $1`, [gate.stage_run_id])
  // Re-kick the stage run — it will replay checkpoints and pick up from park point
  runStage(gate.feature_id, gate.stage_run_id).catch((err) =>
    console.error(`[runner] resume failed:`, err),
  )
}
