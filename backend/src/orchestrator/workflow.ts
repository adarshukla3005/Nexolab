// Hardcoded 6-stage OpenSpec workflow.
// Order matters — the runner advances features through these stages one at a time.
// proposal, spec, design, technical — LLM-generated artifacts.
// review                          — auto-builds the combined PLAN.md artifact so the team can read it.
// approval                        — pure quorum gate, no AI work. Once approved by quorum, commit-to-repo enables.

export const FEATURE_WORKFLOW = [
  'proposal',
  'spec',
  'design',
  'technical',
  'review',
  'approval',
] as const

export type FeatureStageSlug = typeof FEATURE_WORKFLOW[number]

export function nextStage(current: string): FeatureStageSlug | null {
  const idx = FEATURE_WORKFLOW.indexOf(current as FeatureStageSlug)
  if (idx === -1 || idx === FEATURE_WORKFLOW.length - 1) return null
  return FEATURE_WORKFLOW[idx + 1]
}

export function isLastStage(slug: string): boolean {
  return slug === FEATURE_WORKFLOW[FEATURE_WORKFLOW.length - 1]
}
