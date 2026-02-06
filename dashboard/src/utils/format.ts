/**
 * Shared formatting helpers used across dashboard pages and components.
 */

/** Format a duration given start/end ISO strings (for trace viewers). */
export function formatDurationSpan(startTime: string, endTime?: string | null): string {
  if (!endTime) return "running...";
  const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(2)}s`;
}

/** Format a duration in milliseconds (for review lists). */
export function formatDurationMs(ms: number): string {
  if (ms <= 0) return "-";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
