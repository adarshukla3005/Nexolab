import { useState } from 'react'
import { api } from '../../lib/api.js'
import { toast } from 'sonner'

interface ParsedOption {
  key: string
  label: string
}

interface ParsedQuestion {
  index: number
  heading: string
  text: string
  options: ParsedOption[]
  existingAnswer: string | null
}

function parseQuestions(md: string): ParsedQuestion[] {
  const questions: ParsedQuestion[] = []
  // Split on ## Question N: ... headings
  const sections = md.split(/\n(?=## Question \d+)/g)

  for (const section of sections) {
    const headingMatch = section.match(/^## Question (\d+):\s*(.+)/)
    if (!headingMatch) continue

    const index = parseInt(headingMatch[1], 10)
    const heading = headingMatch[2].trim()

    // Question text is bold line
    const textMatch = section.match(/\*\*(.+?)\*\*/)
    const text = textMatch ? textMatch[1].trim() : heading

    // Options: lines like "A. ..." or "A) ..."
    const optionLines = section.match(/^[A-Z][.)]\s+.+/gm) ?? []
    const options: ParsedOption[] = optionLines.map((line) => {
      const m = line.match(/^([A-Z])[.)]\s+(.+)/)
      return m ? { key: m[1], label: m[2].trim() } : null
    }).filter(Boolean) as ParsedOption[]

    // Existing answer
    const answerMatch = section.match(/\[Answer\]:\s*([A-Z,\s]+)?/)
    const existingAnswer = answerMatch?.[1]?.trim() || null

    questions.push({ index, heading, text, options, existingAnswer })
  }

  return questions
}

interface QuestionFormProps {
  featureId: string
  artifactId: string
  artifactSlug: string
  content: string
  onSubmitted: () => void
}

export function QuestionForm({ featureId, artifactId, artifactSlug, content, onSubmitted }: QuestionFormProps) {
  const questions = parseQuestions(content)
  const [answers, setAnswers] = useState<Record<number, string[]>>(() => {
    const init: Record<number, string[]> = {}
    for (const q of questions) {
      if (q.existingAnswer) {
        init[q.index] = q.existingAnswer.split(',').map((s) => s.trim()).filter(Boolean)
      } else {
        init[q.index] = []
      }
    }
    return init
  })
  const [customAnswers, setCustomAnswers] = useState<Record<number, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const toggle = (qIndex: number, key: string) => {
    setAnswers((prev) => {
      const current = prev[qIndex] ?? []
      if (key === 'X') {
        // X is exclusive — clear other selections
        return { ...prev, [qIndex]: current.includes('X') ? [] : ['X'] }
      }
      // Remove X if selecting a real option
      const without = current.filter((k) => k !== 'X')
      return {
        ...prev,
        [qIndex]: without.includes(key)
          ? without.filter((k) => k !== key)
          : [...without, key],
      }
    })
  }

  const isSelected = (qIndex: number, key: string) =>
    (answers[qIndex] ?? []).includes(key)

  const allAnswered = questions.every((q) => {
    const sel = answers[q.index] ?? []
    if (sel.length === 0) return false
    if (sel.includes('X') && !customAnswers[q.index]?.trim()) return false
    return true
  })

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      // Build updated markdown with answers filled in
      let updated = content
      for (const q of questions) {
        const sel = answers[q.index] ?? []
        let answerText = sel.join(', ')
        if (sel.includes('X') && customAnswers[q.index]?.trim()) {
          answerText += `: ${customAnswers[q.index].trim()}`
        }
        // Replace [Answer]: (possibly with existing value) with new answer
        updated = updated.replace(
          /(\[Answer\]:)[^\n]*/,
          `$1 ${answerText}`,
        )
        // Only replace first occurrence per question — do it section by section
      }

      // Save answers back to artifact and also POST to /api/features/:id/answer-questions
      await api.post(`/api/features/${featureId}/answer-questions`, {
        artifactId,
        answers: questions.map((q) => ({
          question: q.text,
          answer: (answers[q.index] ?? []).join(', ') + (
            (answers[q.index] ?? []).includes('X') && customAnswers[q.index]
              ? `: ${customAnswers[q.index]}`
              : ''
          ),
        })),
      })

      toast.success('Answers submitted — AI is continuing…')
      onSubmitted()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (questions.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No questions found in this artifact.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-3 border-b border-border bg-amber-50/60 flex items-center gap-2 flex-shrink-0">
        <span className="text-amber-700 text-sm font-medium">
          ✦ {questions.length} questions — answer to continue the OpenSpec workflow
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-8">
        {questions.map((q) => {
          const sel = answers[q.index] ?? []
          const hasX = sel.includes('X')

          return (
            <div key={q.index} className="space-y-3">
              <div>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Question {q.index}
                </span>
                <p className="text-base font-medium text-foreground mt-0.5">{q.text}</p>
              </div>

              <div className="grid gap-2">
                {q.options.map((opt) => {
                  const selected = sel.includes(opt.key)
                  const isOther = opt.key === 'X'
                  return (
                    <button
                      key={opt.key}
                      onClick={() => toggle(q.index, opt.key)}
                      className={`flex items-start gap-3 px-4 py-3 rounded-lg border text-left transition-all ${
                        selected
                          ? isOther
                            ? 'border-amber-400 bg-amber-50 text-amber-900'
                            : 'border-primary bg-primary/5 text-primary'
                          : 'border-border hover:border-ring hover:bg-accent/50 text-foreground'
                      }`}
                    >
                      <span className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center text-xs font-bold mt-0.5 ${
                        selected
                          ? isOther ? 'bg-amber-400 text-white' : 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {opt.key}
                      </span>
                      <span className="text-sm leading-snug">{opt.label}</span>
                    </button>
                  )
                })}
              </div>

              {hasX && (
                <textarea
                  autoFocus
                  value={customAnswers[q.index] ?? ''}
                  onChange={(e) => setCustomAnswers((p) => ({ ...p, [q.index]: e.target.value }))}
                  placeholder="Describe your answer…"
                  rows={2}
                  className="w-full px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"
                />
              )}

              {sel.length > 0 && !hasX && (
                <p className="text-xs text-primary font-medium">
                  Selected: {sel.map((k) => {
                    const o = q.options.find((x) => x.key === k)
                    return o ? `${k}. ${o.label}` : k
                  }).join(' · ')}
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div className="border-t border-border px-6 py-3 flex items-center justify-between flex-shrink-0 bg-background">
        <p className="text-xs text-muted-foreground">
          {questions.filter((q) => (answers[q.index] ?? []).length > 0).length} / {questions.length} answered
        </p>
        <button
          onClick={handleSubmit}
          disabled={!allAnswered || submitting}
          className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
            allAnswered && !submitting
              ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
          }`}
        >
          {submitting ? 'Submitting…' : 'Submit answers →'}
        </button>
      </div>
    </div>
  )
}
