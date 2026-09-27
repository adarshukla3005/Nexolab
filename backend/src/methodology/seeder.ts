// OpenSpec methodology seeder — hardcodes 4 STAGE blocks into the `blocks` table.
// Replaces the AI-DLC upstream repo fetch: no tarball, no external deps, no SHA pinning.
// Called on backend startup (see index.ts).

import { pool, query } from '../db.js'
import { runMigrations } from '../migrate.js'

export const SOURCE_REF = 'openspec-v1'

// Six OpenSpec stage slugs — canonical order used across the platform.
// proposal, spec, design, technical run LLM planning; review, approval are gates the runner
// short-circuits (no LLM call).
export const REQUIRED_STAGE_SLUGS = ['proposal', 'spec', 'design', 'technical', 'review', 'approval'] as const
export type StageSlug = typeof REQUIRED_STAGE_SLUGS[number]

interface StageDef {
  slug: StageSlug
  title: string
  phase: string
  content: string
}

// Stage prompts — intentionally concise (~1 KB each). The LLM already has:
//   - the feature title/prompt
//   - the intake questionnaire answers (injected at runner boot)
//   - prior artifacts, capped
//   - the repo tree, capped
// so the stage instruction only needs to say WHAT to produce and WHICH SECTIONS.
const STAGES: StageDef[] = [
  {
    slug: 'proposal',
    title: 'Proposal',
    phase: 'planning',
    content: `# Stage: Proposal

Produce a single artifact via \`create_artifact\` with:
- \`artifact_type\`: \`openspec-proposal\`
- \`slug\`: \`proposal\`
- \`title\`: \`Proposal — <feature title>\`

The artifact's markdown must include these sections in order:

1. **Title** — one-line summary of the feature.
2. **Motivation** — the problem or opportunity, in 2–4 sentences. Reference the intake answers.
3. **Proposed Change** — high-level description of what will be added, modified, or removed.
4. **Success Criteria** — 3–6 measurable outcomes the feature must achieve to be considered done.
5. **Out of Scope** — 2–5 items intentionally deferred.

After creating the artifact, call \`send_output\` with a one-sentence status. Do not ask questions — the intake questionnaire has already been answered.`,
  },
  {
    slug: 'spec',
    title: 'Spec',
    phase: 'planning',
    content: `# Stage: Spec

Read the \`proposal\` artifact with \`get_artifact\`, then produce a single artifact:
- \`artifact_type\`: \`openspec-spec\`
- \`slug\`: \`spec\`
- \`title\`: \`Spec — <feature title>\`

The markdown must include:

1. **Behaviors** — bulleted list of user-visible or system behaviors this feature adds or changes. Each behavior should be described in one sentence.
2. **APIs / Data Changes** — new or modified endpoints, schemas, database tables, or interfaces. Include names, methods, and shapes.
3. **Acceptance Criteria** — Given / When / Then style, one block per major behavior. Concrete, testable.
4. **Non-Functional Requirements** — performance, security, accessibility, or compliance constraints if any.

Do not include implementation details (module choices, file structure) — that belongs in the Design stage. After creating the artifact, call \`send_output\`.`,
  },
  {
    slug: 'design',
    title: 'Design',
    phase: 'planning',
    content: `# Stage: Design

Read \`proposal\` and \`spec\` artifacts first. Use \`list_repo_tree\` and \`read_repo_file\` to understand the existing codebase — the design must fit what's actually there.

Produce a single artifact:
- \`artifact_type\`: \`openspec-design\`
- \`slug\`: \`design\`
- \`title\`: \`Design — <feature title>\`

The markdown must include:

1. **Architecture Overview** — 2–4 sentences describing where this feature lives in the existing system.
2. **Key Decisions** — 3–6 decisions with a one-line rationale each (e.g. "Use SQLite for local storage because …").
3. **Module Boundaries** — which existing modules/files are touched, and any new modules to add.
4. **External Dependencies** — libraries, services, or APIs the design relies on. Note versions if pinned.
5. **Trade-offs & Risks** — 2–4 sentences on what could go wrong and what alternatives were considered.

After creating the artifact, call \`send_output\`.`,
  },
  {
    slug: 'technical',
    title: 'Technical',
    phase: 'planning',
    content: `# Stage: Technical

Read all prior artifacts (\`proposal\`, \`spec\`, \`design\`). Produce a single artifact:
- \`artifact_type\`: \`openspec-technical\`
- \`slug\`: \`technical\`
- \`title\`: \`Technical Tasks — <feature title>\`

The markdown must be an ordered, file-level task list an engineer can execute directly. Include:

1. **Implementation Tasks** — numbered list. Each task names the file(s) to touch and the change in one sentence (e.g. "1. Add \`POST /api/foo\` handler in \`backend/src/routes/foo.ts\` that validates payload and calls \`fooService.create\`.").
2. **Tests to Add** — unit / integration / e2e tests keyed to the acceptance criteria in the Spec.
3. **Deployment Notes** — env vars, migrations, feature flags, or config changes.
4. **Rollback Plan** — one paragraph on how to revert if the change misbehaves in production.

After creating the artifact, call \`send_output\` — the pipeline continues to the Review stage next.`,
  },
  {
    slug: 'review',
    title: 'Review',
    phase: 'review',
    // The runner short-circuits this stage: it builds the combined PLAN.md artifact and
    // opens a validation gate. This content field is a placeholder so the DB join succeeds.
    content: `# Stage: Review

This stage is handled by the runner directly — no LLM prompt is executed.
The runner assembles the combined \`plan\` artifact from proposal + spec + design + technical, then opens a validation gate for team review.`,
  },
  {
    slug: 'approval',
    title: 'Approval',
    phase: 'approval',
    // The runner short-circuits this stage too: it opens the final-approval gate directly.
    content: `# Stage: Approval

This stage is handled by the runner directly — no LLM prompt is executed.
The runner opens a final approval gate; once quorum is met the feature is marked \`planned\` and ready for commit.`,
  },
]

async function upsertStage(stage: StageDef): Promise<void> {
  await query(
    `INSERT INTO blocks (source_ref, block_type, slug, phase, title, content, metadata)
     VALUES ($1, 'STAGE', $2, $3, $4, $5, $6)
     ON CONFLICT (source_ref, slug) DO UPDATE SET
       block_type = EXCLUDED.block_type,
       phase = EXCLUDED.phase,
       title = EXCLUDED.title,
       content = EXCLUDED.content,
       metadata = EXCLUDED.metadata`,
    [SOURCE_REF, stage.slug, stage.phase, stage.title, stage.content, JSON.stringify({ methodology: 'openspec' })],
  )
}

export async function seedIfNeeded(): Promise<void> {
  for (const stage of STAGES) {
    await upsertStage(stage)
  }
  console.log(`[seeder] seeded ${STAGES.length} OpenSpec stage blocks (source_ref=${SOURCE_REF})`)
}

// Run as entrypoint (retained for the `npm run seed` script)
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => seedIfNeeded())
    .then(() => { console.log('[seeder] done'); process.exit(0) })
    .catch((err) => { console.error('[seeder] fatal:', err); process.exit(1) })
    .finally(() => pool.end())
}
