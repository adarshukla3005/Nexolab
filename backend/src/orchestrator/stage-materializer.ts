import { join } from 'path'
import { query } from '../db.js'
import { renderContractsForStage } from './artifact-contracts.js'
import { runGitOrThrow } from '../git/spawn.js'

const WORKTREES_BASE = process.env.WORKTREES_BASE ?? '/data/worktrees'

interface MaterializeInput {
  featureId: string
  stageSlug: string
  featureTitle: string
  featurePrompt: string
  sourceRef: string
}

// Fetches answered intake questionnaire (kind='intake') so its answers can be
// prepended to every stage's system prompt AND appended to the proposal artifact
// so anyone opening the stage later can see what was asked and what was answered.
export async function loadIntakeAnswers(featureId: string): Promise<string> {
  const row = await query<{ answer: unknown; question_schema: unknown }>(
    `SELECT answer, question_schema FROM human_gates
     WHERE feature_id = $1 AND kind = 'intake' AND status = 'answered'
     ORDER BY answered_at DESC LIMIT 1`,
    [featureId],
  )
  if (!row.rows.length || !row.rows[0].answer) return ''

  const answer = row.rows[0].answer as Record<string, string>
  const schema = row.rows[0].question_schema as { questions?: Array<{ id: string; question: string }> } | null
  const qMap = new Map<string, string>()
  for (const q of schema?.questions ?? []) qMap.set(q.id, q.question)

  const lines: string[] = []
  for (const [id, val] of Object.entries(answer)) {
    const q = qMap.get(id) ?? id
    lines.push(`- **${q}**\n  ${String(val).trim()}`)
  }
  if (!lines.length) return ''
  return `\n## Intake Answers (from the user before planning began)\n${lines.join('\n')}\n`
}

export async function materializeStagePrompt(input: MaterializeInput): Promise<string> {
  const { featureId, stageSlug, featureTitle, featurePrompt, sourceRef } = input

  // Load STAGE block from DB
  const stageRow = await query<{ content: string }>(
    `SELECT content FROM blocks WHERE source_ref = $1 AND block_type = 'STAGE' AND slug = $2`,
    [sourceRef, stageSlug],
  )
  const stageContent = stageRow.rows[0]?.content ?? `# Stage: ${stageSlug}\n(stage content not found)`

  // Prior artifacts (last 4, ~200 chars each — full read via get_artifact tool)
  const priorArtifacts = await query<{ slug: string; artifact_type: string; content_md: string }>(
    `SELECT slug, artifact_type, content_md FROM artifacts WHERE feature_id = $1 ORDER BY created_at`,
    [featureId],
  )

  const artifactContracts = renderContractsForStage(stageSlug)
  const intakeText = await loadIntakeAnswers(featureId)

  const featureRow = await query<{ repo_id: string | null }>('SELECT repo_id FROM features WHERE id = $1', [featureId])
  const hasRepo = !!featureRow.rows[0]?.repo_id

  // Repo file tree — top 40 files only
  let repoTreeText = ''
  if (hasRepo) {
    const worktreeDir = join(WORKTREES_BASE, featureId)
    try {
      const out = await runGitOrThrow(worktreeDir, ['ls-tree', '-r', '--name-only', 'HEAD'])
      const allFiles = out.split('\n').filter(Boolean)
      const capped = allFiles.slice(0, 40)
      const truncNote = allFiles.length > 40 ? `\n(+${allFiles.length - 40} more — use list_repo_tree())` : ''
      repoTreeText = `\nRepo files:\n\`\`\`\n${capped.join('\n')}${truncNote}\n\`\`\``
    } catch {
      repoTreeText = '\nRepo connected — use list_repo_tree() to explore.'
    }
  }

  const recentArtifacts = priorArtifacts.rows.slice(-4)
  const priorArtifactsText = recentArtifacts.length > 0
    ? recentArtifacts.map((a) =>
        `**${a.slug}** (${a.artifact_type}): ${a.content_md.slice(0, 200)}${a.content_md.length > 200 ? '… [use get_artifact(slug) for full]' : ''}`
      ).join('\n\n')
    : '(none yet)'

  return `You are an OpenSpec planning agent running the **${stageSlug}** stage.

**Feature:** ${featureTitle}
${featurePrompt}
${intakeText}
## Tools
- \`create_artifact(artifact_type, slug, title, content)\` — save a planning artifact
- \`update_artifact(slug, content, title?)\` — update an existing artifact
- \`get_artifact(slug)\` — read an artifact
- \`send_output(message)\` — signal stage complete (call exactly once when done)
- \`list_repo_tree(prefix?)\` — list repo files
- \`read_repo_file(path)\` — read a repo file${hasRepo ? '\n\n**Repo connected** — explore with list_repo_tree/read_repo_file so the plan fits the existing codebase.' : ''}

## Stage Instructions
${stageContent}

## Prior Artifacts
${priorArtifactsText}${repoTreeText}

## Artifact Contract
${artifactContracts || 'Produce a well-structured markdown artifact.'}

## Rules
- Produce exactly one artifact via \`create_artifact\` (the type is stated in the Stage Instructions).
- Do NOT ask clarifying questions — the intake questionnaire has already been answered above.
- Call \`send_output\` exactly once when the artifact is saved.
`
}
