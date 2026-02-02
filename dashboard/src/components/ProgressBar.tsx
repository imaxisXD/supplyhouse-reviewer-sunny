interface ProgressBarProps {
  percentage: number;
  label?: string;
}

export default function ProgressBar({ percentage, label }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percentage));
  return (
    <div>
      {label && (
        <div className="flex justify-between text-sm mb-1">
          <span className="text-ink-700">{label}</span>
          <span className="text-ink-600 font-mono">{clamped}%</span>
        </div>
      )}
      <div className="w-full h-2 bg-warm-200 overflow-hidden">
        <div
          className="h-full bg-brand-500 transition-all duration-500 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
