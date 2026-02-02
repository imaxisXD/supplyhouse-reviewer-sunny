import { useEffect, useState } from "react";
import { getMetrics } from "../api/client";
import type { Metrics } from "../api/client";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-rose-500",
  high: "bg-orange-500",
  medium: "bg-amber-500",
  low: "bg-sky-500",
  info: "bg-warm-300",
};

const SEVERITY_TEXT_COLORS: Record<string, string> = {
  critical: "text-rose-700",
  high: "text-orange-700",
  medium: "text-amber-700",
  low: "text-sky-700",
  info: "text-ink-600",
};

const BREAKER_DOT_COLORS: Record<string, string> = {
  CLOSED: "bg-emerald-500",
  OPEN: "bg-rose-500",
  HALF_OPEN: "bg-amber-500",
};

const BREAKER_TEXT_COLORS: Record<string, string> = {
  CLOSED: "text-emerald-700",
  OPEN: "text-rose-700",
  HALF_OPEN: "text-amber-700",
};

export default function MetricsPanel() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    getMetrics()
      .then(setMetrics)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-center py-12 text-ink-600">Loading metrics...</div>;
  }

  if (error) {
    return (
      <div className="p-4 bg-rose-50 border border-rose-300/70 text-rose-700 text-sm">
        {error}
      </div>
    );
  }

  if (!metrics) {
    return <div className="text-center py-12 text-ink-600">No metrics available.</div>;
  }

  const severityOrder = ["critical", "high", "medium", "low", "info"];
  const totalSeverityCount = severityOrder.reduce(
    (sum, s) => sum + (metrics.severityCounts[s] ?? 0),
    0,
  );

  const breakerEntries = Object.entries(metrics.circuitBreakers);

  return (
    <div className="space-y-8">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-ink-900 p-4">
          <p className="text-xs text-ink-600 mb-1">Total Reviews</p>
          <p className="text-2xl font-bold text-ink-950">{metrics.totalReviews}</p>
        </div>
        <div className="bg-white border border-ink-900 p-4">
          <p className="text-xs text-ink-600 mb-1">Avg Duration</p>
          <p className="text-2xl font-bold text-amber-700">
            {(metrics.avgDurationMs / 1000).toFixed(1)}s
          </p>
        </div>
        <div className="bg-white border border-ink-900 p-4">
          <p className="text-xs text-ink-600 mb-1">Total Findings</p>
          <p className="text-2xl font-bold text-brand-600">{metrics.totalFindings}</p>
        </div>
        <div className="bg-white border border-ink-900 p-4">
          <p className="text-xs text-ink-600 mb-1">Total Cost</p>
          <p className="text-2xl font-bold text-emerald-700">
            ${metrics.totalCostUsd.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Severity Breakdown */}
      <div>
        <h3 className="text-sm font-medium text-ink-700 mb-3">Severity Breakdown</h3>
        <div className="bg-white border border-ink-900 p-4">
          {totalSeverityCount === 0 ? (
            <p className="text-sm text-ink-600">No findings recorded yet.</p>
          ) : (
            <>
              {/* Stacked bar */}
              <div className="w-full h-6 bg-warm-200 overflow-hidden flex">
                {severityOrder.map((sev) => {
                  const count = metrics.severityCounts[sev] ?? 0;
                  if (count === 0) return null;
                  const pct = (count / totalSeverityCount) * 100;
                  return (
                    <div
                      key={sev}
                      className={`h-full ${SEVERITY_COLORS[sev]} transition-all duration-300`}
                      style={{ width: `${pct}%` }}
                      title={`${sev}: ${count}`}
                    />
                  );
                })}
              </div>
              {/* Legend */}
              <div className="flex flex-wrap gap-4 mt-3">
                {severityOrder.map((sev) => {
                  const count = metrics.severityCounts[sev] ?? 0;
                  return (
                    <div key={sev} className="flex items-center gap-1.5">
                      <span className={`w-2.5 h-2.5 ${SEVERITY_COLORS[sev]}`} />
                      <span className={`text-xs capitalize ${SEVERITY_TEXT_COLORS[sev]}`}>
                        {sev}
                      </span>
                      <span className="text-xs text-ink-600">({count})</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Circuit Breakers */}
      <div>
        <h3 className="text-sm font-medium text-ink-700 mb-3">Circuit Breakers</h3>
        {breakerEntries.length === 0 ? (
          <div className="bg-white border border-ink-900 p-4">
            <p className="text-sm text-ink-600">No circuit breakers configured.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {breakerEntries.map(([name, breaker]) => (
              <div
                key={name}
                className="bg-white border border-ink-900 p-4 flex items-center justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-ink-900">{name}</p>
                  <p className="text-xs text-ink-600 mt-0.5">
                    {breaker.failures} failure{breaker.failures !== 1 ? "s" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 ${BREAKER_DOT_COLORS[breaker.state] ?? "bg-warm-300"}`}
                  />
                  <span
                    className={`text-xs font-medium ${BREAKER_TEXT_COLORS[breaker.state] ?? "text-ink-600"}`}
                  >
                    {breaker.state}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
