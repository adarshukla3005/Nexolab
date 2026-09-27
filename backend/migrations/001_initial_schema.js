export const up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true })

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable('sessions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true, unique: true },
    kind: { type: 'text', notNull: true }, // 'magic_link' | 'session'
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('sessions', 'user_id')

  pgm.createTable('repos', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    url: { type: 'text', notNull: true, unique: true },
    provider: { type: 'text', notNull: true }, // 'github' | 'gitlab'
    clone_url: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable('features', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    slug: { type: 'text', notNull: true, unique: true },
    title: { type: 'text', notNull: true },
    prompt: { type: 'text', notNull: true },
    repo_id: { type: 'uuid', references: 'repos(id)' },
    base_branch: { type: 'text', notNull: true, default: 'main' },
    plan_branch: { type: 'text' },
    creator_id: { type: 'uuid', notNull: true, references: 'users(id)' },
    status: { type: 'text', notNull: true, default: 'active' }, // active | committed | archived
    current_stage_id: { type: 'text' },
    quorum_size: { type: 'integer', notNull: true, default: 2 },
    committed_sha: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('features', 'status')
  pgm.createIndex('features', 'slug')
  pgm.createIndex('features', 'creator_id')

  pgm.createTable('feature_members', {
    feature_id: { type: 'uuid', notNull: true, references: 'features(id)', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true, default: 'member' }, // member | reviewer
    joined_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('feature_members', 'feature_members_pkey', 'PRIMARY KEY (feature_id, user_id)')

  pgm.createTable('blocks', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    source_ref: { type: 'text', notNull: true },
    block_type: { type: 'text', notNull: true }, // STAGE | AGENT | SCOPE | SENSOR | RULE | KNOWLEDGE | SKILL | TEMPLATE | ARTIFACT
    slug: { type: 'text', notNull: true },
    phase: { type: 'text' },
    title: { type: 'text' },
    content: { type: 'text', notNull: true },
    metadata: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('blocks', 'blocks_source_ref_slug_unique', 'UNIQUE (source_ref, slug)')
  pgm.createIndex('blocks', 'block_type')
  pgm.createIndex('blocks', ['source_ref', 'block_type'])

  pgm.createTable('artifacts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    feature_id: { type: 'uuid', notNull: true, references: 'features(id)', onDelete: 'CASCADE' },
    stage_run_id: { type: 'uuid' }, // populated after stage_runs created
    artifact_type: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    content_md: { type: 'text', notNull: true, default: '' },
    content_json: { type: 'jsonb' }, // TipTap JSON for rich editing
    version: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('artifacts', 'artifacts_feature_slug_unique', 'UNIQUE (feature_id, slug)')
  pgm.createIndex('artifacts', 'feature_id')

  pgm.createTable('artifact_links', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    from_artifact_id: { type: 'uuid', notNull: true, references: 'artifacts(id)', onDelete: 'CASCADE' },
    to_artifact_id: { type: 'uuid', notNull: true, references: 'artifacts(id)', onDelete: 'CASCADE' },
    link_type: { type: 'text', notNull: true, default: 'consumes' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable('stage_runs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    feature_id: { type: 'uuid', notNull: true, references: 'features(id)', onDelete: 'CASCADE' },
    stage_slug: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' }, // pending | running | parked | done | failed
    execution_id: { type: 'text', notNull: true, unique: true },
    reviewer_findings: { type: 'text' },
    started_at: { type: 'timestamptz' },
    completed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('stage_runs', 'feature_id')
  pgm.createIndex('stage_runs', ['feature_id', 'stage_slug'])

  // Add the FK from artifacts.stage_run_id now that stage_runs exists
  pgm.addConstraint('artifacts', 'artifacts_stage_run_id_fk',
    'FOREIGN KEY (stage_run_id) REFERENCES stage_runs(id) ON DELETE SET NULL')

  pgm.createTable('human_gates', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    feature_id: { type: 'uuid', notNull: true, references: 'features(id)', onDelete: 'CASCADE' },
    stage_run_id: { type: 'uuid', notNull: true, references: 'stage_runs(id)', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true }, // 'question' | 'validation'
    status: { type: 'text', notNull: true, default: 'pending' }, // pending | answered | approved | rejected
    question_text: { type: 'text' },
    question_schema: { type: 'jsonb' }, // StructuredQuestion shape
    answer: { type: 'jsonb' },
    step_id: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    answered_at: { type: 'timestamptz' },
  })
  pgm.createIndex('human_gates', 'stage_run_id')
  pgm.createIndex('human_gates', ['feature_id', 'status'])

  pgm.createTable('approvals', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    gate_id: { type: 'uuid', notNull: true, references: 'human_gates(id)', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)' },
    verdict: { type: 'text', notNull: true }, // 'approved' | 'changes_requested'
    comment: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('approvals', 'approvals_gate_user_unique', 'UNIQUE (gate_id, user_id)')

  pgm.createTable('discussions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    feature_id: { type: 'uuid', notNull: true, references: 'features(id)', onDelete: 'CASCADE' },
    artifact_id: { type: 'uuid', references: 'artifacts(id)', onDelete: 'CASCADE' },
    title: { type: 'text' },
    resolved: { type: 'boolean', notNull: true, default: false },
    created_by: { type: 'uuid', notNull: true, references: 'users(id)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('discussions', 'feature_id')
  pgm.createIndex('discussions', 'artifact_id')

  pgm.createTable('messages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    discussion_id: { type: 'uuid', notNull: true, references: 'discussions(id)', onDelete: 'CASCADE' },
    author_id: { type: 'uuid', notNull: true, references: 'users(id)' },
    body: { type: 'text', notNull: true },
    redacted: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('messages', 'discussion_id')

  pgm.createTable('tool_calls', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    execution_id: { type: 'text', notNull: true },
    step_id: { type: 'text', notNull: true },
    tool_name: { type: 'text', notNull: true },
    args: { type: 'jsonb', notNull: true },
    output: { type: 'jsonb' },
    status: { type: 'text', notNull: true, default: 'pending' }, // pending | succeeded | failed
    error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    completed_at: { type: 'timestamptz' },
  })
  pgm.addConstraint('tool_calls', 'tool_calls_execution_step_unique', 'UNIQUE (execution_id, step_id)')
  pgm.createIndex('tool_calls', 'execution_id')

  pgm.createTable('llm_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    feature_id: { type: 'uuid', references: 'features(id)', onDelete: 'SET NULL' },
    stage_run_id: { type: 'uuid', references: 'stage_runs(id)', onDelete: 'SET NULL' },
    model: { type: 'text', notNull: true },
    tokens_in: { type: 'integer' },
    tokens_out: { type: 'integer' },
    cost_usd: { type: 'numeric(10,6)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('llm_events', 'feature_id')

  // NOTIFY trigger for feature list updates
  pgm.createFunction('notify_features_list', [], {
    language: 'plpgsql',
    returns: 'trigger',
    replace: true,
  }, `
    BEGIN
      PERFORM pg_notify('features:list', row_to_json(NEW)::text);
      RETURN NEW;
    END;
  `)

  pgm.createTrigger('features', 'features_list_notify', {
    when: 'AFTER',
    operation: ['INSERT', 'UPDATE'],
    level: 'ROW',
    function: 'notify_features_list',
  })
}

export const down = (pgm) => {
  pgm.dropTrigger('features', 'features_list_notify', { ifExists: true })
  pgm.dropFunction('notify_features_list', [], { ifExists: true })
  const tables = ['llm_events', 'tool_calls', 'messages', 'discussions', 'approvals',
    'human_gates', 'stage_runs', 'artifact_links', 'artifacts', 'blocks',
    'feature_members', 'features', 'repos', 'sessions', 'users']
  for (const t of tables) pgm.dropTable(t, { ifExists: true, cascade: true })
}
