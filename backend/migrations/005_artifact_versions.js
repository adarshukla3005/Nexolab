export const up = (pgm) => {
  pgm.createTable('artifact_versions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    artifact_id: { type: 'uuid', notNull: true, references: 'artifacts(id)', onDelete: 'CASCADE' },
    version: { type: 'integer', notNull: true },
    content_md: { type: 'text', notNull: true },
    title: { type: 'text' },
    // Who saved this version. NULL when the AI produced it (e.g. combine-plan or LLM tool call).
    editor_id: { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    // 'stage'      — LLM stage-runner tool call (create_artifact/update_artifact)
    // 'manual'     — human clicked Save in the editor
    // 'ai-chat'    — AI edit via workspace chat
    // 'ai-inline'  — AI edit via inline selection popover
    // 'combine'    — combine-plan rebuild
    // 'restore'    — user restored an older version
    edit_source: { type: 'text', notNull: true, default: 'manual' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('artifact_versions', ['artifact_id', 'created_at'])
  pgm.addConstraint('artifact_versions', 'artifact_versions_artifact_version_unique', 'UNIQUE (artifact_id, version)')
}

export const down = (pgm) => {
  pgm.dropTable('artifact_versions')
}
