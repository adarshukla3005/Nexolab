import { query } from '../../db.js'
import type { ToolHandler } from '../tool-registry.js'

export const schema = {
  type: 'function' as const,
  function: {
    name: 'get_artifact',
    description: 'Read the content of an artifact by slug.',
    parameters: {
      type: 'object',
      required: ['slug'],
      properties: {
        slug: { type: 'string' },
      },
    },
  },
}

const MAX_ARTIFACT_CHARS = 4_000

export const handler: ToolHandler = async (args, ctx) => {
  const { slug } = args as { slug: string }
  const res = await query<{ id: string; title: string; content_md: string; artifact_type: string }>(
    `SELECT id, title, content_md, artifact_type FROM artifacts WHERE feature_id = $1 AND slug = $2`,
    [ctx.featureId, slug],
  )
  if (res.rowCount === 0) return { found: false }
  const a = res.rows[0]
  if (a.content_md && a.content_md.length > MAX_ARTIFACT_CHARS) {
    a.content_md = a.content_md.slice(0, MAX_ARTIFACT_CHARS) + '\n... [truncated]'
  }
  return { found: true, artifact: a }
}
