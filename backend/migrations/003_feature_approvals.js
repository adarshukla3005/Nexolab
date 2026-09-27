export const up = (pgm) => {
  // Per-feature final approval: each member can approve the plan before commit
  pgm.createTable('feature_approvals', {
    feature_id: { type: 'uuid', notNull: true, references: 'features(id)', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    verdict: { type: 'text', notNull: true, default: 'approved' }, // approved | changes_requested
    comment: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('feature_approvals', 'feature_approvals_pkey', 'PRIMARY KEY (feature_id, user_id)')
  pgm.createIndex('feature_approvals', 'feature_id')

  // Store repo_url and created_at on features so we can display them in the UI
  pgm.addColumn('features', {
    repo_url: { type: 'text' },
  })
}

export const down = (pgm) => {
  pgm.dropColumn('features', 'repo_url', { ifExists: true })
  pgm.dropTable('feature_approvals', { ifExists: true, cascade: true })
}
