// AI-generated intake questionnaire.
// Given the feature title + prompt + repo context, ask an LLM to produce 4–8 questions
// tailored to that feature. Falls back to the hardcoded set if generation fails or
// returns malformed JSON — the intake gate must never block on a flaky LLM.

import { chat } from '../llm/client.js'
import { query } from '../db.js'
import { runGitOrThrow } from '../git/spawn.js'
import { join } from 'path'
import { INTAKE_QUESTIONS, OTHER_OPTION, type IntakeQuestion } from './intake-questions.js'

const WORKTREES_BASE = process.env.WORKTREES_BASE ?? '/data/worktrees'

// The AI must return this shape. Each option list gets "Other (specify)" appended by us
// so the model doesn't need to know the sentinel string.
export interface GeneratedQuestion {
  id: string                             // stable slug like "target_users"
  text: string                           // the question text
  hint?: string                          // one-line clarifier
  type: 'single' | 'multi' | 'text'      // form control kind
  options?: string[]                     // required when type is single or multi
}

const SYSTEM_PROMPT = `You generate short intake questionnaires for a software-feature planning tool.

You will be given the feature's title, one-paragraph prompt, and (if the repo is connected)
a listing of files. You must return between 4 and 8 questions whose answers will help an AI
planner produce a proposal, spec, design and technical task list for THIS specific feature.

Return ONLY a JSON object with this exact shape — no prose, no markdown fences:
{
  "questions": [
    {
      "id": "kebab_snake_case_slug",
      "text": "Question text ending in a question mark?",
      "hint": "One-line clarifier of what to think about (optional).",
      "type": "single" | "multi" | "text",
      "options": ["Option A", "Option B", "Option C", "Option D"]   // required if type is single or multi; 3–6 items
    }
  ]
}

Rules:
- 4 to 8 questions total.
- Mix the types where it helps: use "single" when the answers are mutually exclusive
  (e.g. deployment target), "multi" when several can apply (e.g. supported platforms),
  and "text" ONLY when the answer is genuinely open-ended and short options can't
  capture it (e.g. success metric with a specific number).
- Every question must be about THIS feature — do not ask generic questions like
  "what is your team size?" unless the feature clearly hinges on it.
- Every option must be concrete and non-overlapping.
- Do NOT include an "Other" option — the platform appends one automatically.
- Keep the id stable (lowercase, snake_case, ASCII).
- Do NOT wrap the JSON in code fences. Return raw JSON.`

async function fetchRepoTree(featureId: string): Promise<string> {
  const worktreeDir = join(WORKTREES_BASE, featureId)
  try {
    const out = await runGitOrThrow(worktreeDir, ['ls-tree', '-r', '--name-only', 'HEAD'])
    const files = out.split('\n').filter(Boolean).slice(0, 60)
    return files.join('\n')
  } catch {
    return '(no repo connected or worktree not yet populated)'
  }
}

function convertHardcoded(): GeneratedQuestion[] {
  // Strip the trailing OTHER_OPTION from each hardcoded question's options — the
  // platform re-adds "Other (specify)" during rendering, so we don't want doubles.
  return INTAKE_QUESTIONS.map((q) => ({
    id: q.id,
    text: q.question,
    hint: q.hint,
    type: 'single' as const,
    options: q.options.filter((o) => o !== OTHER_OPTION),
  }))
}

function tryExtractJson(raw: string): unknown | null {
  if (!raw) return null
  // Strip ```json ... ``` fences if the model added them despite instructions.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : raw).trim()
  // Find the outermost {...} — models sometimes prefix a "Here you go:" line.
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace < firstBrace) return null
  const jsonSlice = candidate.slice(firstBrace, lastBrace + 1)
  try { return JSON.parse(jsonSlice) } catch { return null }
}

function validateQuestions(parsed: unknown): GeneratedQuestion[] | null {
  if (!parsed || typeof parsed !== 'object') return null
  const raw = (parsed as { questions?: unknown }).questions
  if (!Array.isArray(raw) || raw.length < 4 || raw.length > 8) return null

  const seen = new Set<string>()
  const cleaned: GeneratedQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const q = item as Partial<GeneratedQuestion>
    if (typeof q.id !== 'string' || !q.id.trim()) return null
    if (typeof q.text !== 'string' || !q.text.trim()) return null
    if (q.type !== 'single' && q.type !== 'multi' && q.type !== 'text') return null
    if (seen.has(q.id)) return null
    seen.add(q.id)

    if (q.type !== 'text') {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8) return null
      if (q.options.some((o) => typeof o !== 'string' || !o.trim())) return null
    }

    cleaned.push({
      id: q.id.trim(),
      text: q.text.trim(),
      hint: typeof q.hint === 'string' ? q.hint.trim() : undefined,
      type: q.type,
      options: q.type === 'text' ? undefined : q.options as string[],
    })
  }
  return cleaned
}

/**
 * Generate intake questions for a specific feature. Called ONCE per feature (result is
 * cached on the human_gates row by the runner). Never throws — always returns a valid
 * set of questions, falling back to the hardcoded set on any failure.
 */
export async function generateIntakeQuestions(featureId: string): Promise<GeneratedQuestion[]> {
  const featRow = await query<{ title: string; prompt: string; repo_id: string | null }>(
    'SELECT title, prompt, repo_id FROM features WHERE id = $1', [featureId],
  )
  const feat = featRow.rows[0]
  if (!feat) return convertHardcoded()

  const repoTree = feat.repo_id ? await fetchRepoTree(featureId) : ''
  const userPrompt = `Feature title: ${feat.title}

Feature prompt / description:
${feat.prompt}
${repoTree ? `\nRepo file listing (top 60):\n${repoTree}\n` : ''}
Generate 4–8 intake questions tailored to this feature. Return raw JSON only.`

  try {
    const result = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { featureId, timeoutMs: 45_000, maxTokens: 2500 },
    )
    const parsed = tryExtractJson(String(result.message.content ?? ''))
    const validated = validateQuestions(parsed)
    if (validated && validated.length >= 4) {
      console.log(`[intake-gen] generated ${validated.length} questions for feature=${featureId}`)
      return validated
    }
    console.warn(`[intake-gen] validation failed for feature=${featureId}, falling back to hardcoded`)
    return convertHardcoded()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[intake-gen] generation failed for feature=${featureId} (${msg.slice(0, 120)}), falling back to hardcoded`)
    return convertHardcoded()
  }
}
