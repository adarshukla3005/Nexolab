import { query } from '../../db.js'
import type { ToolHandler } from '../tool-registry.js'
import { snapshotArtifact, findArtifactIdBySlug } from '../artifact-versions.js'

export const schema = {
  type: 'function' as const,
  function: {
    name: 'update_artifact',
    description: 'Update the content of an existing artifact by slug.',
    parameters: {
      type: 'object',
      required: ['slug', 'content'],
      properties: {
        slug: { type: 'string' },
        content: { type: 'string', description: 'New markdown content' },
        title: { type: 'string' },
      },
    },
  },
}

export const handler: ToolHandler = async (args, ctx) => {
  const { slug, content, title } = args as { slug?: string; content?: string; title?: string }
  if (!slug) return { error: 'slug is required.' }
  if (!content) return { error: 'content is required. Provide the full updated markdown content.' }
  const artId = await findArtifactIdBySlug(ctx.featureId, slug)
  if (!artId) throw new Error(`Artifact not found: ${slug}`)
  await snapshotArtifact(artId, null, 'stage')

  const fields: string[] = ['content_md = $3', 'version = version + 1', 'updated_at = now()']
  const params: unknown[] = [ctx.featureId, slug, content]
  if (title) { fields.push(`title = $${params.length + 1}`); params.push(title) }
  const res = await query<{ id: string }>(
    `UPDATE artifacts SET ${fields.join(', ')} WHERE feature_id = $1 AND slug = $2 RETURNING id`,
    params,
  )
  if (res.rowCount === 0) throw new Error(`Artifact not found: ${slug}`)
  return { ok: true, artifact_id: res.rows[0].id }
}
