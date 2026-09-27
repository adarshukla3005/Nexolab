// Registry of artifact structure contracts for OpenSpec.
// Each OpenSpec artifact is prose markdown (not YAML); the contract lists the required sections
// so the LLM produces consistent output the frontend can render and the reviewer can validate.

export interface ArtifactContract {
  type: string
  description: string
  sections: string[]
}

const contracts: ArtifactContract[] = [
  {
    type: 'openspec-proposal',
    description: 'High-level feature proposal — the "what" and "why" a reviewer skims first.',
    sections: [
      'Title — one-line summary',
      'Motivation — problem or opportunity in 2–4 sentences',
      'Proposed Change — what will be added/modified/removed',
      'Success Criteria — 3–6 measurable outcomes',
      'Out of Scope — 2–5 deferred items',
    ],
  },
  {
    type: 'openspec-spec',
    description: 'Behavioral spec — behaviors, APIs, data changes, acceptance criteria.',
    sections: [
      'Behaviors — bulleted user-visible or system behaviors',
      'APIs / Data Changes — endpoints, schemas, tables, or interfaces',
      'Acceptance Criteria — Given / When / Then blocks per major behavior',
      'Non-Functional Requirements — performance, security, accessibility if applicable',
    ],
  },
  {
    type: 'openspec-design',
    description: 'Architectural design — how the feature fits the existing codebase.',
    sections: [
      'Architecture Overview — 2–4 sentences on placement in the system',
      'Key Decisions — 3–6 decisions each with a one-line rationale',
      'Module Boundaries — existing modules touched + new modules added',
      'External Dependencies — libraries, services, APIs (with versions if pinned)',
      'Trade-offs & Risks — 2–4 sentences on failure modes and alternatives',
    ],
  },
  {
    type: 'openspec-technical',
    description: 'Executable task list — ordered file-level tasks an engineer can implement.',
    sections: [
      'Implementation Tasks — numbered, each names files + one-sentence change',
      'Tests to Add — unit/integration/e2e keyed to acceptance criteria',
      'Deployment Notes — env vars, migrations, feature flags, config',
      'Rollback Plan — how to revert if the change misbehaves',
    ],
  },
  {
    type: 'openspec-plan',
    description: 'Combined PLAN.md concatenating proposal + spec + design + technical.',
    sections: [
      '# Proposal (from openspec-proposal)',
      '# Spec (from openspec-spec)',
      '# Design (from openspec-design)',
      '# Technical (from openspec-technical)',
    ],
  },
]

const contractMap = new Map(contracts.map((c) => [c.type, c]))

export function getContract(artifactType: string): ArtifactContract | null {
  return contractMap.get(artifactType) ?? null
}

export function getAllContracts(): ArtifactContract[] {
  return contracts
}

// Maps each stage slug to the artifact type that stage must produce.
// Used by the stage-materializer to inject the section contract into the LLM system prompt.
const stageArtifactMap: Record<string, string[]> = {
  proposal: ['openspec-proposal'],
  spec: ['openspec-spec'],
  design: ['openspec-design'],
  technical: ['openspec-technical'],
}

export function renderContractsForStage(stageSlug: string): string {
  const types = stageArtifactMap[stageSlug] ?? []
  return types.map((t) => {
    const c = contractMap.get(t)
    if (!c) return ''
    const sectionList = c.sections.map((s) => `- ${s}`).join('\n')
    return `### ${c.type}\n${c.description}\n\n**Required sections:**\n${sectionList}`
  }).filter(Boolean).join('\n\n')
}
