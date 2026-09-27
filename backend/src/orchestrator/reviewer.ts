// Reviewer stub with real-mode plumbing intact (uow-reviewer-stub)
// REVIEWER_MODE=stub (default): returns READY immediately
// REVIEWER_MODE=real: invokes the LLM with reviewer tools

import { chat } from '../llm/client.js'
import { getToolSchemas, dispatchTool, type ToolContext } from './tool-registry.js'
import type { ChatCompletionMessageParam } from 'openai/resources/index.js'

export interface ReviewResult {
  verdict: 'READY' | 'NOT-READY'
  findings: string
}

export function buildReviewerPrompt(
  stageSlug: string,
  artifacts: Array<{ slug: string; content_md: string }>,
): string {
  const artifactSection = artifacts
    .map((a) => `### ${a.slug}\n${a.content_md.slice(0, 3000)}`)
    .join('\n\n---\n\n')

  return `You are an OpenSpec reviewer for the **${stageSlug}** stage.

Your job: review the produced artifact and decide if it meets OpenSpec's quality bar for that stage.

## Artifact to Review
${artifactSection}

## Review Criteria
1. Are all required sections present (per the stage's artifact contract)?
2. Is the content concrete and specific — no vague verbs like "handle" or "manage" without detail?
3. For **proposal**: motivation, proposed change, success criteria, out-of-scope all present?
4. For **spec**: are acceptance criteria written Given / When / Then and testable?
5. For **design**: do decisions cite the existing codebase and list trade-offs?
6. For **technical**: does every implementation task name concrete files and produce testable diffs?

Call \`submit_review\` with:
- \`verdict: "READY"\` if the stage passes
- \`verdict: "NOT-READY"\` with findings if it fails
`
}

export async function runReviewer(params: {
  stageSlug: string
  artifacts: Array<{ slug: string; content_md: string }>
  ctx: ToolContext
}): Promise<ReviewResult> {
  const mode = process.env.REVIEWER_MODE ?? 'stub'

  if (mode !== 'real') {
    // Stub: log the reviewer prompt, return READY
    const prompt = buildReviewerPrompt(params.stageSlug, params.artifacts)
    console.log(`[reviewer] stub mode — would have sent:\n${prompt.slice(0, 500)}...`)
    return { verdict: 'READY', findings: '(stub)' }
  }

  // Real mode
  const systemPrompt = buildReviewerPrompt(params.stageSlug, params.artifacts)
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Please review the artifacts and submit your verdict.' },
  ]
  const tools = getToolSchemas('reviewer')

  const MAX_ITERATIONS = 3
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const result = await chat(messages, {
      tools,
      featureId: params.ctx.featureId,
      stageRunId: params.ctx.stageRunId,
    })
    messages.push(result.message)

    if (!result.message.tool_calls?.length) break

    for (const tc of result.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments)
      const output = await dispatchTool(tc.function.name, args, params.ctx)

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(output),
      })

      if (tc.function.name === 'submit_review') {
        return output as ReviewResult
      }
    }
  }

  return { verdict: 'READY', findings: '(reviewer did not call submit_review)' }
}
