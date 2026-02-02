const PHASES = [
  { key: "queued", label: "Queued" },
  { key: "fetching-pr", label: "Fetching PR" },
  { key: "building-context", label: "Building Context" },
  { key: "running-agents", label: "Running Agents" },
  { key: "synthesizing", label: "Synthesizing" },
  { key: "posting-comments", label: "Posting Comments" },
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
                className={`w-3 h-3 rounded-full border-2 transition-colors ${
                  isFailed && i === 0
                    ? "bg-red-500 border-red-500"
                    : isComplete
                    ? "bg-green-500 border-green-500"
                    : isCurrent
                    ? "bg-blue-500 border-blue-500 animate-pulse"
                    : "bg-transparent border-gray-600"
                }`}
              />
              <span
                className={`text-xs mt-1 ${
                  isFailed && i === 0
                    ? "text-red-400 font-medium"
                    : isCurrent
                    ? "text-blue-400 font-medium"
                    : isComplete
                    ? "text-green-400"
                    : "text-gray-600"
                }`}
              >
                {phase.label}
              </span>
            </div>
            {i < PHASES.length - 1 && (
              <div
                className={`w-8 h-0.5 mb-4 ${isComplete ? "bg-green-500" : "bg-gray-700"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
