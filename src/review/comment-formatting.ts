/**
 * Bitbucket comment formatting helpers.
 *
 * These functions produce the Markdown text that gets posted as PR comments
 * (started, completed, failed, per-finding inline, and summary).
 */

import type { Finding, Severity, Category, AgentTrace, ReviewResult } from "../types/findings.ts";

// ---------------------------------------------------------------------------
// Status comments
// ---------------------------------------------------------------------------

export function formatStartedComment(estimateMinutes: number, queueDepth: number): string {
  const lines = [
    "\uD83D\uDC41\uFE0F **Review in progress**",
    "",
    "The SupplyHouse Reviewer bot is analyzing this pull request.",
  ];

  if (queueDepth > 0) {
    lines.push(`There ${queueDepth === 1 ? "is 1 review" : `are ${queueDepth} reviews`} ahead in the queue.`);
  }

  lines.push(`Estimated time: ~${estimateMinutes} minute${estimateMinutes !== 1 ? "s" : ""}.`);
  lines.push("", "---", "_Automated review by SupplyHouse Reviewer_");

  return lines.join("\n");
}

export function formatCompletedComment(summary: ReviewResult["summary"], totalFindings: number): string {
  const lines = [
    "\uD83D\uDC4D **Review complete**",
    "",
    `Analyzed **${summary.filesAnalyzed}** files and found **${totalFindings}** issue${totalFindings !== 1 ? "s" : ""}.`,
    `Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
    "",
    "See inline comments for details and the summary comment below.",
    "",
    "---",
    "_Automated review by SupplyHouse Reviewer_",
  ];

  return lines.join("\n");
}

export function formatFailedComment(errorMessage: string): string {
  const lines = [
    "\u274C **Review failed**",
    "",
    `Error: ${errorMessage}`,
    "",
    "---",
    "_Automated review by SupplyHouse Reviewer_",
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Finding inline comment
// ---------------------------------------------------------------------------

export function formatFindingComment(finding: Finding): string {
  const severityEmoji: Record<Severity, string> = {
    critical: "\u{1F534}", high: "\u{1F7E0}", medium: "\u{1F7E1}", low: "\u{1F535}", info: "\u26AA",
  };

  const categoryEmoji: Record<Category, string> = {
    security: "\u{1F512}",    // 🔒
    bug: "\u{1F41B}",         // 🐛
    duplication: "\u{1F4CB}", // 📋
    "api-change": "\u{26A0}\u{FE0F}",  // ⚠️
    refactor: "\u{1F9F9}",    // 🧹
  };

  const catEmoji = categoryEmoji[finding.category] ?? "";

  const lines = [
    `${severityEmoji[finding.severity]} **${finding.severity.toUpperCase()}** | ${catEmoji} ${finding.category}`,
    "",
    `**${finding.title}**`,
    "",
    finding.description,
  ];

  if (finding.suggestion) {
    lines.push("", "**Suggestion:**", finding.suggestion);
  }
  if (finding.cwe) {
    lines.push("", `_CWE: ${finding.cwe}_`);
  }
  if (finding.confidence < 0.8) {
    lines.push("", `_Confidence: ${Math.round(finding.confidence * 100)}%_`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Summary comment
// ---------------------------------------------------------------------------

export const AGENT_TO_CATEGORY: Record<string, Category> = {
  security: "security",
  logic: "bug",
  duplication: "duplication",
  "api-change": "api-change",
  refactor: "refactor",
};

export function computeCodeQualityScore(findings: Finding[]): number {
  if (findings.length === 0) return 5;
  const sev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (f.severity in sev) sev[f.severity as keyof typeof sev]++;
  }
  if (sev.critical > 0 || sev.high >= 3) return 1;
  if (sev.high > 0) return 2;
  if (sev.medium > 0) return 3;
  if (sev.low > 0) return 4;
  return 5;
}

export function formatSummaryComment(
  summary: ReviewResult["summary"],
  totalFindings: number,
  _traces?: AgentTrace[],
  findings?: Finding[],
  recommendation?: string,
): string {
  const lines = [
    "## \uD83D\uDD0D Review Summary",
    "",
    `\uD83D\uDCCA Analyzed **${summary.filesAnalyzed}** files \u00B7 Found **${totalFindings}** issue${totalFindings !== 1 ? "s" : ""} \u00B7 \u23F1 ${(summary.durationMs / 1000).toFixed(1)}s`,
    "",
  ];

  if (totalFindings === 0) {
    lines.push("\u2705 No issues found. Code looks clean.", "");
  } else {
    // Severity overview line
    const parts: string[] = [];
    if (summary.bySeverity.critical > 0) parts.push(`\uD83D\uDD34 **${summary.bySeverity.critical} Critical**`);
    if (summary.bySeverity.high > 0) parts.push(`\uD83D\uDFE0 **${summary.bySeverity.high} High**`);
    if (summary.bySeverity.medium > 0) parts.push(`\uD83D\uDFE1 **${summary.bySeverity.medium} Medium**`);
    if (summary.bySeverity.low > 0) parts.push(`\uD83D\uDD35 **${summary.bySeverity.low} Low**`);
    if (summary.bySeverity.info > 0) parts.push(`\u26AA **${summary.bySeverity.info} Info**`);
    lines.push(parts.join(" \u00B7 "), "");

    if (findings && findings.length > 0) {
      const bySev: Record<string, Finding[]> = { critical: [], high: [], medium: [], low: [], info: [] };
      for (const f of findings) {
        if (f.severity in bySev) bySev[f.severity]!.push(f);
      }

      // Critical
      if (bySev.critical!.length > 0) {
        lines.push("### \uD83D\uDD34 Critical");
        for (const f of bySev.critical!) {
          lines.push(`- ${f.title} (\`${f.file.split("/").pop()}:${f.line}\`)`);
        }
        lines.push("");
      }

      // High
      if (bySev.high!.length > 0) {
        lines.push("### \uD83D\uDFE0 High Priority");
        for (const f of bySev.high!) {
          lines.push(`- ${f.title} (\`${f.file.split("/").pop()}:${f.line}\`)`);
        }
        lines.push("");
      }

      // Medium — show all with file:line
      if (bySev.medium!.length > 0) {
        lines.push("### \uD83D\uDFE1 Medium");
        for (const f of bySev.medium!) {
          lines.push(`- ${f.title} (\`${f.file.split("/").pop()}:${f.line}\`)`);
        }
        lines.push("");
      }

      // Low — show all with file:line (so users can find them)
      if (bySev.low!.length > 0) {
        lines.push("### \uD83D\uDD35 Low");
        for (const f of bySev.low!) {
          lines.push(`- ${f.title} (\`${f.file.split("/").pop()}:${f.line}\`)`);
        }
        lines.push("");
      }

      // Info — show all with file:line
      if (bySev.info!.length > 0) {
        lines.push("### \u26AA Info");
        for (const f of bySev.info!) {
          lines.push(`- ${f.title} (\`${f.file.split("/").pop()}:${f.line}\`)`);
        }
        lines.push("");
      }
    }
  }

  // Code Quality Score + Recommendation
  const score = findings ? computeCodeQualityScore(findings) : 5;
  let rec = recommendation;
  if (!rec) {
    if (totalFindings === 0) rec = "Safe to merge";
    else if (summary.bySeverity.critical > 0) rec = "Request changes \u2014 critical issues need attention";
    else if (summary.bySeverity.high >= 2) rec = "Request changes \u2014 multiple high-severity issues found";
    else if (summary.bySeverity.high === 1) rec = "Review suggested \u2014 one high-severity issue needs attention";
    else rec = "Safe to merge after fixing the issues above";
  }
  lines.push(`**Code Quality: ${score}/5** \u00B7 ${rec}`, "");

  lines.push("---", "_Automated review by SupplyHouse Reviewer_");

  return lines.join("\n");
}
