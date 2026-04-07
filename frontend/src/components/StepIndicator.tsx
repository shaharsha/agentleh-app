interface StepIndicatorProps {
  steps: string[]
  current: number
}

export default function StepIndicator({ steps, current }: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              i <= current
                ? 'bg-brand text-white'
                : 'bg-gray-200 text-gray-500'
            }`}
          >
            {i + 1}
          </div>
          <span className={`text-sm ${i <= current ? 'text-gray-900' : 'text-gray-400'}`}>
            {label}
          </span>
          {i < steps.length - 1 && (
            <div className={`w-8 h-0.5 ${i < current ? 'bg-brand' : 'bg-gray-200'}`} />
          )}
        </div>
      ))}
    </div>
  )
}
