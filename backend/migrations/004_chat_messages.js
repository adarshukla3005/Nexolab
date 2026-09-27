export const up = (pgm) => {
  pgm.createTable('chat_messages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    feature_id: { type: 'uuid', notNull: true, references: 'features(id)', onDelete: 'CASCADE' },
    // user_id is null for AI-assistant messages
    user_id: { type: 'uuid', references: 'users(id)', onDelete: 'SET NULL' },
    role: { type: 'text', notNull: true }, // 'user' | 'assistant' | 'system'
    text: { type: 'text', notNull: true },
    // If the AI updated an artifact, its slug is recorded here so the UI can show a badge.
    artifact_slug_updated: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('chat_messages', ['feature_id', 'created_at'])
}

export const down = (pgm) => {
  pgm.dropTable('chat_messages')
}
