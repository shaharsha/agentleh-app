interface StepIndicatorProps {
  steps: string[]
  current: number
}

export default function StepIndicator({ steps, current }: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-1 mb-10">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center gap-1">
          <div className="flex flex-col items-center gap-1.5">
            <div
              className={`w-9 h-9 rounded-full flex items-center justify-center text-[14px] font-medium transition-all duration-300 ${
                i < current
                  ? 'bg-gradient-to-b from-brand to-brand-dark text-white shadow-md shadow-brand/20'
                  : i === current
                    ? 'bg-gradient-to-b from-brand to-brand-dark text-white shadow-lg shadow-brand/25 scale-110'
                    : 'glass text-text-muted'
              }`}
            >
              {i < current ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                i + 1
              )}
            </div>
            <span className={`text-[12px] font-medium ${
              i <= current ? 'text-text-primary' : 'text-text-muted'
            }`}>
              {label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={`w-10 h-[2px] rounded-full mb-5 mx-1 transition-all duration-500 ${
              i < current ? 'bg-brand' : 'bg-black/[0.06]'
            }`} />
          )}
        </div>
      ))}
    </div>
  )
}
