// Combines the four OpenSpec artifacts (proposal, spec, design, technical) into a
// single `openspec-plan` artifact whose content_md is the concatenated PLAN.md.
// Called by advanceStage when the final `technical` stage has been committed.
// Also exports `consolidatePlan` — the git-writable form used by the /commit route.

import { query } from '../db.js'
import { snapshotArtifact, findArtifactIdBySlug } from './artifact-versions.js'

const HEADERS: Record<string, string> = {
  proposal: '# Proposal',
  spec: '# Spec',
  design: '# Design',
  technical: '# Technical',
}
const ORDER = ['proposal', 'spec', 'design', 'technical'] as const

export async function combinePlanArtifact(featureId: string): Promise<string | null> {
  const rows = await query<{ slug: string; title: string; content_md: string }>(
    `SELECT slug, title, content_md FROM artifacts
     WHERE feature_id = $1 AND slug IN ('proposal', 'spec', 'design', 'technical')`,
    [featureId],
  )
  const bySlug = new Map(rows.rows.map((r) => [r.slug, r]))

  const sections: string[] = []
  for (const slug of ORDER) {
    const row = bySlug.get(slug)
    if (!row) {
      sections.push(`${HEADERS[slug]}\n\n_(missing — this stage produced no artifact)_`)
      continue
    }
    sections.push(`${HEADERS[slug]}\n\n${row.content_md.trim()}`)
  }

  const featureRow = await query<{ title: string }>(
    'SELECT title FROM features WHERE id = $1', [featureId],
  )
  const featureTitle = featureRow.rows[0]?.title ?? 'Feature'
  const body = [`# ${featureTitle} — OpenSpec Plan\n`, ...sections].join('\n\n---\n\n')

  // Snapshot existing 'plan' artifact before combine overwrites it.
  const existingPlanId = await findArtifactIdBySlug(featureId, 'plan')
  if (existingPlanId) await snapshotArtifact(existingPlanId, null, 'combine')

  const result = await query<{ id: string }>(
    `INSERT INTO artifacts (feature_id, stage_run_id, artifact_type, slug, title, content_md)
     VALUES ($1, NULL, 'openspec-plan', 'plan', $2, $3)
     ON CONFLICT (feature_id, slug) DO UPDATE SET
       content_md = EXCLUDED.content_md,
       title = EXCLUDED.title,
       artifact_type = EXCLUDED.artifact_type,
       version = artifacts.version + 1,
       updated_at = now()
     RETURNING id`,
    [featureId, `PLAN — ${featureTitle}`, body],
  )
  return result.rows[0]?.id ?? null
}

// consolidatePlan — returns the plan in a shape the git commit worker can write
// straight to disk. Same content as combinePlanArtifact but returned as { planMd, files }
// where `files` names PLAN.md plus one file per stage artifact.
export async function consolidatePlan(
  featureId: string,
): Promise<{ planMd: string; files: Array<{ path: string; content: string }> }> {
  const rows = await query<{ slug: string; title: string; content_md: string }>(
    `SELECT slug, title, content_md FROM artifacts
     WHERE feature_id = $1 AND slug IN ('proposal', 'spec', 'design', 'technical')`,
    [featureId],
  )
  const bySlug = new Map(rows.rows.map((r) => [r.slug, r]))

  const featureRow = await query<{ title: string }>(
    'SELECT title FROM features WHERE id = $1', [featureId],
  )
  const featureTitle = featureRow.rows[0]?.title ?? 'Feature'

  const sections: string[] = []
  const files: Array<{ path: string; content: string }> = []

  for (const slug of ORDER) {
    const row = bySlug.get(slug)
    if (!row) {
      sections.push(`${HEADERS[slug]}\n\n_(missing — this stage produced no artifact)_`)
      continue
    }
    sections.push(`${HEADERS[slug]}\n\n${row.content_md.trim()}`)
    files.push({ path: `plan/${slug}.md`, content: row.content_md.trim() + '\n' })
  }

  const planMd = [`# ${featureTitle} — OpenSpec Plan\n`, ...sections].join('\n\n---\n\n')
  files.unshift({ path: 'PLAN.md', content: planMd + '\n' })

  return { planMd, files }
}
