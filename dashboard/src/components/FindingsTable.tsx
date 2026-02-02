import { useState } from "react";
import type { Finding } from "../api/client";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-rose-50 text-rose-700 border-rose-400/50",
  high: "bg-orange-50 text-orange-700 border-orange-400/50",
  medium: "bg-amber-50 text-amber-700 border-amber-400/50",
  low: "bg-sky-50 text-sky-700 border-sky-400/50",
  info: "bg-warm-100 text-ink-700 border-ink-900",
};

interface FindingsTableProps {
  findings: Finding[];
}

export default function FindingsTable({ findings }: FindingsTableProps) {
  const [filter, setFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered = filter === "all" ? findings : findings.filter((f) => f.severity === filter);

  const makeKey = (finding: Finding, index: number) =>
    `${finding.file}:${finding.line}:${finding.title}:${index}`;

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        {[["all", "All"], ["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["info", "Info"]].map(([sev, label]) => (
          <button
            key={sev}
            onClick={() => setFilter(sev)}
            className={`px-3 py-1 text-xs border transition-colors ${
              filter === sev
                ? "bg-brand-500 border-brand-500 text-white"
                : "bg-white border-ink-900 text-ink-600 hover:text-ink-900"
            }`}
          >
            {label}
            {sev !== "all" && (
              <span className="ml-1 opacity-60">
                ({findings.filter((f) => f.severity === sev).length})
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {filtered.map((finding, index) => {
          const key = makeKey(finding, index);
          return (
          <div
            key={key}
            className="border border-ink-900 overflow-hidden bg-white"
          >
            <button
              onClick={() => toggle(key)}
              className="w-full flex items-center gap-3 p-3 text-left hover:bg-warm-100/70 transition-colors"
            >
              <span
                className={`px-2 py-0.5 text-xs border ${
                  SEVERITY_COLORS[finding.severity] || SEVERITY_COLORS.info
                }`}
              >
                {finding.severity}
              </span>
              <span className="text-sm text-ink-900 flex-1">{finding.title}</span>
              <span className="text-xs text-ink-600 font-mono">
                {finding.file}:{finding.line}
              </span>
              <span className="text-xs text-ink-500">{finding.category}</span>
            </button>
            {expanded.has(key) && (
              <div className="px-4 pb-4 border-t border-ink-900">
                <p className="text-sm text-ink-700 mt-3">{finding.description}</p>
                {finding.suggestion && (
                <div className="mt-3 p-3 bg-warm-50 border border-ink-900">
                    <p className="text-xs text-ink-600 mb-1">Suggestion</p>
                    <p className="text-sm text-ink-800">{finding.suggestion}</p>
                  </div>
                )}
                {finding.relatedCode && (
                  <div className="mt-3 p-3 bg-warm-50 border border-ink-900">
                    <p className="text-xs text-ink-600 mb-1">Related Code</p>
                    <p className="text-xs text-ink-700 font-mono">
                      {finding.relatedCode.file}:{finding.relatedCode.line} — {finding.relatedCode.functionName}
                      {typeof finding.relatedCode.similarity === "number" && (
                        <span className="text-ink-500"> ({Math.round(finding.relatedCode.similarity * 100)}% similar)</span>
                      )}
                    </p>
                  </div>
                )}
                {finding.affectedFiles && finding.affectedFiles.length > 0 && (
                  <div className="mt-3 p-3 bg-warm-50 border border-ink-900">
                    <p className="text-xs text-ink-600 mb-2">Affected Files</p>
                    <div className="space-y-1">
                      {finding.affectedFiles.map((item) => (
                        <div key={`${item.file}:${item.line}`} className="text-xs text-ink-700 font-mono">
                          {item.file}:{item.line} — {item.usage}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(finding.cwe || typeof finding.confidence === "number") && (
                  <div className="mt-3 text-xs text-ink-600 flex gap-4">
                    {finding.cwe && <span>CWE: {finding.cwe}</span>}
                    {typeof finding.confidence === "number" && (
                      <span>Confidence: {Math.round(finding.confidence * 100)}%</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )})}
        {filtered.length === 0 && (
          <p className="text-center text-ink-600 py-8">No findings match the selected filter.</p>
        )}
      </div>
    </div>
  );
}
