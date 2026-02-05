const PHASES = [
  { key: "queued", label: "Queued" },
  { key: "fetching-pr", label: "Fetching PR" },
  { key: "indexing", label: "Indexing" },
  { key: "building-context", label: "Building Context" },
  { key: "running-agents", label: "Running Agents" },
  { key: "synthesizing", label: "Synthesizing" },
  { key: "posting-comments", label: "Posting Comments" },
  { key: "cancelling", label: "Cancelling" },
  { key: "complete", label: "Complete" },
];

interface PhaseIndicatorProps {
  currentPhase: string;
}

export default function PhaseIndicator({ currentPhase }: PhaseIndicatorProps) {
  const currentIndex = PHASES.findIndex((p) => p.key === currentPhase);

  return (
    <div className="flex items-center gap-1">
      {PHASES.map((phase, i) => {
        const isComplete = i < currentIndex;
        const isCurrent = i === currentIndex;
        const isFailed = currentPhase === "failed";
        return (
          <div key={phase.key} className="flex items-center gap-1">
            <div className="flex flex-col items-center">
              <div
                className={`w-3 h-3 border-2 transition-colors ${
                  isFailed && i === 0
                    ? "bg-rose-500 border-rose-500"
                    : isComplete
                    ? "bg-emerald-500 border-emerald-500"
                    : isCurrent
                    ? "bg-brand-500 border-brand-500 animate-pulse"
                    : "bg-transparent border-ink-900"
                }`}
              />
              <span
                className={`text-xs mt-1 ${
                  isFailed && i === 0
                    ? "text-rose-700 font-medium"
                    : isCurrent
                    ? "text-brand-600 font-medium"
                    : isComplete
                    ? "text-emerald-700"
                    : "text-ink-600"
                }`}
              >
                {phase.label}
              </span>
            </div>
            {i < PHASES.length - 1 && (
              <div
                className={`w-8 h-0.5 mb-4 ${isComplete ? "bg-emerald-500" : "bg-ink-900"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
