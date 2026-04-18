interface StepIndicatorProps {
  steps: string[]
  current: number
}

export default function StepIndicator({ steps, current }: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-1.5 mb-12">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center gap-1.5">
          <div className="flex flex-col items-center gap-2">
            <div
              className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-semibold transition-all duration-300 ${
                i < current
                  ? 'bg-text-primary text-surface shadow-[0_2px_8px_rgb(14_19_32/0.08)]'
                  : i === current
                    ? 'bg-brand text-white shadow-[0_8px_24px_rgba(212,98,43,0.25)] scale-110'
                    : 'bg-surface-soft border-2 border-border text-text-muted'
              }`}
            >
              {i < current ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                i + 1
              )}
            </div>
            <span className={`text-[12px] font-medium transition-colors ${
              i <= current ? 'text-text-primary' : 'text-text-muted'
            }`}>
              {label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={`w-12 h-[1.5px] rounded-full mb-6 mx-0.5 transition-all duration-500 ${
              i < current ? 'bg-text-primary/25' : 'bg-border'
            }`} />
          )}
        </div>
      ))}
    </div>
  )
}
