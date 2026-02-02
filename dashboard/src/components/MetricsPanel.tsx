import { useEffect, useState } from "react";
import { getMetrics } from "../api/client";
import type { Metrics } from "../api/client";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-500",
  info: "bg-gray-500",
};

const SEVERITY_TEXT_COLORS: Record<string, string> = {
  critical: "text-red-400",
  high: "text-orange-400",
  medium: "text-yellow-400",
  low: "text-blue-400",
  info: "text-gray-400",
};

const BREAKER_DOT_COLORS: Record<string, string> = {
  CLOSED: "bg-green-500",
  OPEN: "bg-red-500",
  HALF_OPEN: "bg-yellow-500",
};

const BREAKER_TEXT_COLORS: Record<string, string> = {
  CLOSED: "text-green-400",
  OPEN: "text-red-400",
  HALF_OPEN: "text-yellow-400",
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
    return <div className="text-center py-12 text-gray-500">Loading metrics...</div>;
  }

  if (error) {
    return (
      <div className="p-4 bg-red-900/30 border border-red-800 rounded-lg text-red-300 text-sm">
        {error}
      </div>
    );
  }

  if (!metrics) {
    return <div className="text-center py-12 text-gray-600">No metrics available.</div>;
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
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Total Reviews</p>
          <p className="text-2xl font-bold text-white">{metrics.totalReviews}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Avg Duration</p>
          <p className="text-2xl font-bold text-purple-400">
            {(metrics.avgDurationMs / 1000).toFixed(1)}s
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Total Findings</p>
          <p className="text-2xl font-bold text-orange-400">{metrics.totalFindings}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-1">Total Cost</p>
          <p className="text-2xl font-bold text-emerald-400">
            ${metrics.totalCostUsd.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Severity Breakdown */}
      <div>
        <h3 className="text-sm font-medium text-gray-400 mb-3">Severity Breakdown</h3>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          {totalSeverityCount === 0 ? (
            <p className="text-sm text-gray-600">No findings recorded yet.</p>
          ) : (
            <>
              {/* Stacked bar */}
              <div className="w-full h-6 bg-gray-800 rounded-full overflow-hidden flex">
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
                      <span className={`w-2.5 h-2.5 rounded-full ${SEVERITY_COLORS[sev]}`} />
                      <span className={`text-xs capitalize ${SEVERITY_TEXT_COLORS[sev]}`}>
                        {sev}
                      </span>
                      <span className="text-xs text-gray-500">({count})</span>
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
        <h3 className="text-sm font-medium text-gray-400 mb-3">Circuit Breakers</h3>
        {breakerEntries.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-sm text-gray-600">No circuit breakers configured.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {breakerEntries.map(([name, breaker]) => (
              <div
                key={name}
                className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-between"
              >
                <div>
                  <p className="text-sm font-medium text-gray-200">{name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {breaker.failures} failure{breaker.failures !== 1 ? "s" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${BREAKER_DOT_COLORS[breaker.state] ?? "bg-gray-500"}`}
                  />
                  <span
                    className={`text-xs font-medium ${BREAKER_TEXT_COLORS[breaker.state] ?? "text-gray-400"}`}
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
