import { useRef, useState } from 'react'
import { api } from '../../lib/api.js'
import { toast } from 'sonner'

interface QuestionItem {
  id: string
  text: string
  type: 'single' | 'multi' | 'text'
  options?: Array<{ label: string; description?: string }>
}

// The sentinel used by intake questions — when the user picks this option we show
// a free-text field and store the answer as "Other: <typed text>".
const OTHER_OPTION_LABEL = 'Other (specify)'
const isOtherLabel = (v: unknown) =>
  typeof v === 'string' && (v === OTHER_OPTION_LABEL || v.startsWith('Other: '))
// Handles single-select (string) and multi-select (string[]) values.
const isOtherPicked = (val: unknown): boolean => {
  if (Array.isArray(val)) return val.some(isOtherLabel)
  return isOtherLabel(val)
}

interface GateSchema {
  text: string
  type: 'single' | 'multi' | 'batch'
  options?: Array<{ label: string; description?: string }>
  questions?: QuestionItem[] // batch mode
}

interface GateApproval { user_id: string; name: string; verdict: string }

interface Gate {
  id: string
  kind: 'question' | 'validation'
  status: string
  question_text: string
  question_schema: GateSchema | null
  answer: unknown
  created_at: string
  // Populated by the backend for validation gates
  approvals?: GateApproval[]
  quorum?: number
  member_count?: number
}

export function GateCard({
  gate,
  currentUserId,
  onAnswered,
}: {
  gate: Gate
  currentUserId?: string | null
  onAnswered: () => void
}) {
  const isBatch = gate.question_schema?.type === 'batch'

  // Single-question state
  const [selected, setSelected] = useState<string[]>([])
  // Batch state: map of questionId → answer(s)
  const [batchAnswers, setBatchAnswers] = useState<Record<string, string | string[]>>({})
  // Per-question free-text when the user has picked the "Other (specify)" option.
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  // Synchronous re-entry guard so a burst of double-clicks can't queue multiple requests
  // before the async setLoading(true) reaches the DOM.
  const submitInFlight = useRef(false)

  const isAnswered = gate.status === 'answered' || gate.status === 'approved'

  // Validation-gate approval state (only relevant when kind='validation'):
  const gateApprovals = gate.approvals ?? []
  const approvedCount = gateApprovals.filter((a) => a.verdict === 'approved').length
  const gateQuorum = gate.quorum ?? 1
  const quorumMet = approvedCount >= gateQuorum
  const iAlreadyApproved = !!currentUserId && gateApprovals.some(
    (a) => a.user_id === currentUserId && a.verdict === 'approved',
  )

  // --- single question helpers ---
  const toggleOption = (label: string) => {
    if (gate.question_schema?.type === 'single') {
      setSelected([label])
    } else {
      setSelected((prev) => prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label])
    }
  }

  // --- batch helpers ---
  const setBatchSingle = (qid: string, label: string) => {
    setBatchAnswers((p) => ({ ...p, [qid]: label }))
  }
  const toggleBatchMulti = (qid: string, label: string) => {
    setBatchAnswers((p) => {
      const cur = (p[qid] as string[] | undefined) ?? []
      return { ...p, [qid]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
    })
  }
  const setBatchText = (qid: string, val: string) => {
    setBatchAnswers((p) => ({ ...p, [qid]: val }))
  }

  const batchComplete = isBatch
    ? (gate.question_schema?.questions ?? []).every((q) => {
        const a = batchAnswers[q.id]
        if (q.type === 'text') return typeof a === 'string' && a.trim().length > 0
        const picked = Array.isArray(a) ? a.length > 0 : typeof a === 'string' && a.length > 0
        if (!picked) return false
        // If "Other" is selected, require the free-text field to be filled.
        if (isOtherPicked(a)) return (otherText[q.id] ?? '').trim().length > 0
        return true
      })
    : true

  const handleAnswer = async () => {
    if (submitInFlight.current) return // second click before first landed — ignore
    submitInFlight.current = true
    setLoading(true)
    try {
      let body: Record<string, unknown>
      if (gate.kind === 'validation') {
        body = { verdict: 'approved' }
      } else if (isBatch) {
        // If a question has "Other (specify)" picked, replace the sentinel with the free-text.
        // Works for both single (string) and multi (string[]) select answers.
        const submitAnswers: Record<string, string | string[]> = { ...batchAnswers }
        for (const [qid, a] of Object.entries(submitAnswers)) {
          const otherVal = `Other: ${(otherText[qid] ?? '').trim()}`
          if (typeof a === 'string' && a === OTHER_OPTION_LABEL) {
            submitAnswers[qid] = otherVal
          } else if (Array.isArray(a)) {
            submitAnswers[qid] = a.map((v) => v === OTHER_OPTION_LABEL ? otherVal : v)
          }
        }
        body = { answer: submitAnswers }
      } else {
        body = { answer: gate.question_schema?.type === 'single' ? selected[0] : selected }
      }
      await api.post(`/api/gates/${gate.id}/answer`, body)
      toast.success(gate.kind === 'validation' ? 'Approved!' : 'Answers submitted')
      onAnswered()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setLoading(false)
      submitInFlight.current = false
    }
  }

  // Compact single-row layout for validation (approval) gates — no big card,
  // just a thin strip that fits under the tab bar so the artifact editor stays visible.
  if (gate.kind === 'validation') {
    const isValidation = true
    const validationDisabled = iAlreadyApproved || quorumMet
    const disabled = loading || validationDisabled
    let label: string
    if (loading) label = 'Submitting…'
    else if (iAlreadyApproved) label = '✓ You approved'
    else if (quorumMet) label = `Quorum met (${approvedCount}/${gateQuorum})`
    else label = `Approve stage (${approvedCount}/${gateQuorum})`
    return (
      <div className={`flex items-center gap-3 px-3 py-1.5 rounded-md border ${
        isAnswered || quorumMet
          ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30'
          : 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30'
      }`}>
        <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${
          isAnswered || quorumMet ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
        }`}>
          {isAnswered || quorumMet ? '✓ Approved' : 'Approval needed'}
        </span>
        <span className="text-xs text-foreground flex-1 min-w-0 truncate">
          {gate.question_text.replace(/\*\*([^*]+)\*\*/g, '$1')}
        </span>
        {!isAnswered && !quorumMet && (
          <button
            onClick={handleAnswer}
            disabled={disabled}
            title={iAlreadyApproved ? 'You have already approved this stage.' : ''}
            className={`flex-shrink-0 px-3 py-1 rounded text-xs font-medium transition-colors ${
              disabled ? 'bg-secondary text-muted-foreground cursor-not-allowed' : 'bg-primary text-primary-foreground hover:opacity-90'
            }`}
          >
            {label}
          </button>
        )}
        {/* Suppress unused var warning for isValidation — kept for symmetry with the full-card path. */}
        {isValidation && null}
      </div>
    )
  }

  return (
    <div className={`border rounded-lg p-4 mb-3 ${isAnswered ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
          {isBatch ? 'Questions' : 'Question'}
        </span>
        {isAnswered && <span className="text-xs text-green-600 font-medium">✓ {gate.status}</span>}
      </div>

      <p className="text-sm font-semibold mb-3 whitespace-pre-line">
        {gate.question_text.replace(/\*\*([^*]+)\*\*/g, '$1')}
      </p>

      {!isAnswered && isBatch && gate.question_schema?.questions && (
        <div className="space-y-4">
          {gate.question_schema.questions.map((q, idx) => {
            const ans = batchAnswers[q.id]
            return (
              <div key={q.id} className="border border-amber-200 rounded-md p-3 bg-white/60">
                <p className="text-xs font-semibold text-foreground mb-2">
                  <span className="text-amber-600 mr-1">{idx + 1}.</span>
                  {q.text}
                </p>
                {q.type === 'text' ? (
                  <textarea
                    className="w-full text-xs px-2 py-1.5 border border-input rounded resize-none bg-background"
                    rows={2}
                    value={typeof ans === 'string' ? ans : ''}
                    onChange={(e) => setBatchText(q.id, e.target.value)}
                    placeholder="Your answer…"
                  />
                ) : (
                  <div className="space-y-1.5">
                    {(q.options ?? []).map((opt) => {
                      const checked = q.type === 'multi'
                        ? (Array.isArray(ans) && ans.includes(opt.label))
                        : ans === opt.label
                      return (
                        <label key={opt.label} className="flex items-start gap-2 cursor-pointer">
                          <input
                            type={q.type === 'multi' ? 'checkbox' : 'radio'}
                            checked={checked}
                            onChange={() => q.type === 'multi' ? toggleBatchMulti(q.id, opt.label) : setBatchSingle(q.id, opt.label)}
                            className="mt-0.5 flex-shrink-0"
                          />
                          <div>
                            <span className="text-xs font-medium">{opt.label}</span>
                            {opt.description && <p className="text-[11px] text-muted-foreground">{opt.description}</p>}
                          </div>
                        </label>
                      )
                    })}
                    {/* Free-text extension when the user picks the "Other" option */}
                    {isOtherPicked(ans) && (
                      <div className="mt-2 pl-6">
                        <textarea
                          className="w-full text-xs px-2 py-1.5 border border-input rounded resize-none bg-background focus:outline-none focus:border-primary/60"
                          rows={2}
                          value={otherText[q.id] ?? ''}
                          onChange={(e) => setOtherText((p) => ({ ...p, [q.id]: e.target.value }))}
                          placeholder="Type your own answer…"
                          autoFocus
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!isAnswered && !isBatch && gate.question_schema?.options && (
        <div className="space-y-2">
          {gate.question_schema.options.map((opt) => (
            <label key={opt.label} className="flex items-start gap-2 cursor-pointer">
              <input
                type={gate.question_schema?.type === 'single' ? 'radio' : 'checkbox'}
                checked={selected.includes(opt.label)}
                onChange={() => toggleOption(opt.label)}
                className="mt-0.5"
              />
              <div>
                <span className="text-sm font-medium">{opt.label}</span>
                {opt.description && <p className="text-xs text-muted-foreground">{opt.description}</p>}
              </div>
            </label>
          ))}
        </div>
      )}

      {!isAnswered && (
        <div className="mt-4">
          {(() => {
            // Validation gates render via the compact path early-returned above,
            // so here `gate.kind` is always 'question'.
            const disabled = loading
              || (!isBatch && selected.length === 0)
              || (isBatch && !batchComplete)

            const label = loading
              ? 'Submitting…'
              : isBatch
                ? `Submit all ${gate.question_schema?.questions?.length ?? ''} answers`
                : 'Submit answer'

            return (
              <button
                onClick={handleAnswer}
                disabled={disabled}
                className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
                  disabled
                    ? 'bg-secondary text-muted-foreground cursor-not-allowed'
                    : 'bg-primary text-primary-foreground hover:opacity-90'
                }`}
              >
                {label}
              </button>
            )
          })()}
          {isBatch && !batchComplete && (
            <span className="ml-3 text-xs text-muted-foreground">Answer all questions to continue</span>
          )}
        </div>
      )}
    </div>
  )
}
