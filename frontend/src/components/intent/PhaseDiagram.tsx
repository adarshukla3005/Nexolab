const STAGES = [
  { slug: 'proposal', label: 'Proposal' },
  { slug: 'spec', label: 'Spec' },
  { slug: 'design', label: 'Design' },
  { slug: 'technical', label: 'Technical' },
  { slug: 'review', label: 'Review' },
  { slug: 'approval', label: 'Approval' },
]

interface PhaseDiagramProps {
  currentStage: string | null
  selectedStage?: string | null
  onSelectStage?: (slug: string) => void
}

export function PhaseDiagram({ currentStage, selectedStage, onSelectStage }: PhaseDiagramProps) {
  const currentIdx = STAGES.findIndex((s) => s.slug === currentStage)

  return (
    <div className="p-3">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Stages</h3>
      <div className="space-y-1">
        {STAGES.map((stage, idx) => {
          const done = currentIdx > idx
          const active = currentIdx === idx
          const isSelected = selectedStage === stage.slug
          return (
            <button
              key={stage.slug}
              onClick={() => onSelectStage?.(stage.slug)}
              className={`w-full text-left px-3 py-2 rounded text-sm flex items-center gap-2 transition-colors ${
                isSelected ? 'bg-primary/20 text-primary font-medium ring-1 ring-primary/30' :
                active ? 'bg-primary/10 text-primary font-medium' :
                done ? 'text-muted-foreground hover:bg-accent' :
                'text-muted-foreground/50'
              }`}
            >
              <span className={`w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center text-xs border ${
                active ? 'bg-primary border-primary text-white' :
                done ? 'bg-green-500 border-green-500 text-white' :
                'border-border'
              }`}>
                {done ? '✓' : idx + 1}
              </span>
              <span>{stage.label}</span>
              {active && <span className="ml-auto text-xs animate-pulse">●</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
