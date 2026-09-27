// Fixed intake questionnaire shown ONCE before the OpenSpec pipeline runs.
// Answers are stored on a human_gate (kind='intake') and injected into every
// stage's system prompt by the stage-materializer.

export interface IntakeQuestion {
  id: string
  question: string
  hint?: string
  required?: boolean
  /** Option labels. Last item is always the "Other" free-text sentinel. */
  options: string[]
}

// The sentinel option label — when picked, the UI shows a free-text field.
// The final answer is stored as "Other: <what the user typed>".
export const OTHER_OPTION = 'Other (specify)'

export const INTAKE_QUESTIONS: IntakeQuestion[] = [
  {
    id: 'target_users',
    question: 'Who are the target users of this feature?',
    hint: 'Pick the group that will actually use it. Choose "Other" if none fit.',
    required: true,
    options: [
      'End customers / public users',
      'Internal team members (staff)',
      'Admins / operators',
      'Developers integrating via API',
      'Multiple audiences (mixed)',
      OTHER_OPTION,
    ],
  },
  {
    id: 'core_problem',
    question: 'What problem does this feature solve, and why now?',
    hint: 'The trigger for building this.',
    required: true,
    options: [
      'Users are hitting a pain point / friction',
      'Missing capability blocking a workflow',
      'Compliance or security requirement',
      'Performance or reliability issue',
      'Competitive parity / market opportunity',
      'Reducing manual / repetitive work',
      OTHER_OPTION,
    ],
  },
  {
    id: 'success_criteria',
    question: 'How will you measure success once shipped?',
    hint: '2–4 concrete outcomes.',
    required: true,
    options: [
      'Adoption rate / active user count',
      'Task-completion time reduced',
      'Error / failure rate reduced',
      'Stakeholder or approval sign-off',
      'Compliance / audit pass',
      'Revenue / conversion impact',
      OTHER_OPTION,
    ],
  },
  {
    id: 'constraints',
    question: 'Any constraints the plan must respect?',
    hint: 'Timeline, budget, compliance, existing systems, etc.',
    options: [
      'No hard constraints',
      'Tight timeline (weeks, not months)',
      'Must integrate with existing systems',
      'Regulatory / compliance requirements',
      'Limited budget / small team',
      'Backwards-compatibility required',
      OTHER_OPTION,
    ],
  },
  {
    id: 'tech_preferences',
    question: 'Tech-stack preferences or existing patterns to reuse?',
    hint: 'What the AI should stick to.',
    options: [
      'Follow the existing patterns in this repo',
      'Prefer the current backend stack (no new services)',
      'Open to introducing a new library or service if justified',
      'Match a specific external service already in use',
      'No preference — AI chooses',
      OTHER_OPTION,
    ],
  },
  {
    id: 'out_of_scope',
    question: 'What is explicitly out of scope for this iteration?',
    hint: 'Things the AI should not plan for.',
    options: [
      'Nothing off-limits',
      'Skip UI polish / visual design',
      'Skip analytics / observability',
      'Skip performance optimizations',
      'Skip migration of existing data',
      'Skip mobile / non-web clients',
      OTHER_OPTION,
    ],
  },
]

export const INTAKE_TITLE = 'OpenSpec intake — a few upfront questions'
