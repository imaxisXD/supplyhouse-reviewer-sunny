import { useState } from "react";
import type { Finding } from "../api/client";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-900/50 text-red-300 border-red-800",
  high: "bg-orange-900/50 text-orange-300 border-orange-800",
  medium: "bg-yellow-900/50 text-yellow-300 border-yellow-800",
  low: "bg-blue-900/50 text-blue-300 border-blue-800",
  info: "bg-gray-800/50 text-gray-300 border-gray-700",
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
      <div className="flex gap-2 mb-4">
        {["all", "critical", "high", "medium", "low", "info"].map((sev) => (
          <button
            key={sev}
            onClick={() => setFilter(sev)}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
              filter === sev
                ? "bg-blue-600 border-blue-500 text-white"
                : "bg-gray-800 border-gray-700 text-gray-400 hover:text-white"
            }`}
          >
            {sev === "all" ? "All" : sev.charAt(0).toUpperCase() + sev.slice(1)}
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
            className="border border-gray-800 rounded-lg overflow-hidden"
          >
            <button
              onClick={() => toggle(key)}
              className="w-full flex items-center gap-3 p-3 text-left hover:bg-gray-800/50 transition-colors"
            >
              <span
                className={`px-2 py-0.5 text-xs rounded border ${
                  SEVERITY_COLORS[finding.severity] || SEVERITY_COLORS.info
                }`}
              >
                {finding.severity}
              </span>
              <span className="text-sm text-gray-200 flex-1">{finding.title}</span>
              <span className="text-xs text-gray-500 font-mono">
                {finding.file}:{finding.line}
              </span>
              <span className="text-xs text-gray-600">{finding.category}</span>
            </button>
            {expanded.has(key) && (
              <div className="px-4 pb-4 border-t border-gray-800">
                <p className="text-sm text-gray-300 mt-3">{finding.description}</p>
                {finding.suggestion && (
                  <div className="mt-3 p-3 bg-gray-800/50 rounded border border-gray-700">
                    <p className="text-xs text-gray-500 mb-1">Suggestion</p>
                    <p className="text-sm text-gray-200">{finding.suggestion}</p>
                  </div>
                )}
                {finding.relatedCode && (
                  <div className="mt-3 p-3 bg-gray-800/50 rounded border border-gray-700">
                    <p className="text-xs text-gray-500 mb-1">Related Code</p>
                    <p className="text-xs text-gray-300 font-mono">
                      {finding.relatedCode.file}:{finding.relatedCode.line} — {finding.relatedCode.functionName}
                      {typeof finding.relatedCode.similarity === "number" && (
                        <span className="text-gray-500"> ({Math.round(finding.relatedCode.similarity * 100)}% similar)</span>
                      )}
                    </p>
                  </div>
                )}
                {finding.affectedFiles && finding.affectedFiles.length > 0 && (
                  <div className="mt-3 p-3 bg-gray-800/50 rounded border border-gray-700">
                    <p className="text-xs text-gray-500 mb-2">Affected Files</p>
                    <div className="space-y-1">
                      {finding.affectedFiles.map((item) => (
                        <div key={`${item.file}:${item.line}`} className="text-xs text-gray-300 font-mono">
                          {item.file}:{item.line} — {item.usage}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(finding.cwe || typeof finding.confidence === "number") && (
                  <div className="mt-3 text-xs text-gray-500 flex gap-4">
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
          <p className="text-center text-gray-600 py-8">No findings match the selected filter.</p>
        )}
      </div>
    </div>
  );
}
