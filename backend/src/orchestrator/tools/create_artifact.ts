import { query } from '../../db.js'
import type { ToolHandler } from '../tool-registry.js'
import { snapshotArtifact, findArtifactIdBySlug } from '../artifact-versions.js'

export const schema = {
  type: 'function' as const,
  function: {
    name: 'create_artifact',
    description: 'Create a new planning artifact in the current feature. Must be used for ALL artifact creation.',
    parameters: {
      type: 'object',
      required: ['artifact_type', 'slug', 'title', 'content'],
      properties: {
        artifact_type: { type: 'string', description: 'The artifact type (e.g. intent-statement, requirements, stories)' },
        slug: { type: 'string', description: 'URL-safe identifier, unique within feature' },
        title: { type: 'string', description: 'Human-readable title' },
        content: { type: 'string', description: 'Markdown content of the artifact' },
      },
    },
  },
}

export const handler: ToolHandler = async (args, ctx) => {
  const { artifact_type, slug, title, content } = args as {
    artifact_type: string; slug?: string; title?: string; content: string | null | undefined
  }

  if (!slug) return { error: 'slug is required. Provide a URL-safe identifier like "app-design-overview".' }
  if (!title) return { error: 'title is required. Provide a human-readable title.' }
  if (!artifact_type) return { error: 'artifact_type is required.' }
  // Content is the whole point of the tool — refuse empty/missing content loudly so the AI
  // fixes its call rather than silently producing a zero-byte artifact.
  const trimmed = typeof content === 'string' ? content.trim() : ''
  if (!trimmed) {
    return {
      error:
        'content is required and must be a non-empty markdown string containing the full artifact body. You passed an empty or missing `content` field. Retry create_artifact with the complete markdown in the `content` parameter — inline the entire document, do not truncate or reference it elsewhere.',
    }
  }

  // If an artifact already exists at this slug (create_artifact upserts), snapshot the
  // current version first so we don't silently lose it.
  const existingId = await findArtifactIdBySlug(ctx.featureId, slug)
  if (existingId) await snapshotArtifact(existingId, null, 'stage')

  const result = await query<{ id: string }>(
    `INSERT INTO artifacts (feature_id, stage_run_id, artifact_type, slug, title, content_md)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (feature_id, slug) DO UPDATE SET
       content_md = EXCLUDED.content_md,
       title = EXCLUDED.title,
       version = artifacts.version + 1,
       updated_at = now()
     RETURNING id`,
    [ctx.featureId, ctx.stageRunId ?? null, artifact_type, slug, title, content ?? ''],
  )

  const artifactId = result.rows[0].id
  return { ok: true, artifact_id: artifactId, slug }
}
