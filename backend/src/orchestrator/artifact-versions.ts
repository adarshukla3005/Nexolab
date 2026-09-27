// Helper for artifact version history. Call snapshotArtifact() BEFORE overwriting an
// artifact's content_md; it copies the current row into artifact_versions so users can
// review or restore previous edits.

import { query } from '../db.js'

export type EditSource = 'stage' | 'manual' | 'ai-chat' | 'ai-inline' | 'combine' | 'restore'

/**
 * Snapshot the CURRENT (about-to-be-overwritten) artifact into artifact_versions.
 * Idempotent-ish: if the exact version is already snapshotted, skips silently.
 * Never throws — a failed snapshot must not break the primary save path.
 */
export async function snapshotArtifact(
  artifactId: string,
  editorId: string | null,
  source: EditSource,
): Promise<void> {
  try {
    const cur = await query<{ version: number; content_md: string; title: string | null }>(
      `SELECT version, content_md, title FROM artifacts WHERE id = $1`,
      [artifactId],
    )
    if (!cur.rows.length) return
    const { version, content_md, title } = cur.rows[0]
    await query(
      `INSERT INTO artifact_versions (artifact_id, version, content_md, title, editor_id, edit_source)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (artifact_id, version) DO NOTHING`,
      [artifactId, version, content_md, title, editorId, source],
    )
  } catch (err) {
    console.warn('[artifact-versions] snapshot failed:', err)
  }
}

/**
 * Look up an artifact's id from (feature_id, slug). Used by tools that operate on slugs.
 */
export async function findArtifactIdBySlug(
  featureId: string,
  slug: string,
): Promise<string | null> {
  const r = await query<{ id: string }>(
    `SELECT id FROM artifacts WHERE feature_id = $1 AND slug = $2`,
    [featureId, slug],
  )
  return r.rows[0]?.id ?? null
}
