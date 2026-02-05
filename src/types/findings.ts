export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Category = "security" | "bug" | "duplication" | "api-change" | "refactor";

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  suggestion?: string;
  confidence: number;
  lineText?: string;
  lineId?: string;
  cwe?: string;
  relatedCode?: {
    file: string;
    line: number;
    functionName: string;
    similarity?: number;
  };
  affectedFiles?: {
    file: string;
    line: number;
    usage: string;
  }[];
}

export interface AgentTrace {
  agent: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  findingsCount: number;
  status: "success" | "failed" | "skipped";
  error?: string;
  /** Reference to Mastra's native trace for detailed span analysis */
  mastraTraceId?: string;
}

export interface ReviewResult {
  findings: Finding[];
  summary: {
    totalFindings: number;
    bySeverity: Record<Severity, number>;
    byCategory: Record<Category, number>;
    filesAnalyzed: number;
    durationMs: number;
    costUsd: number;
  };
  commentsPosted: {
    commentId: string;
    file: string;
    line: number;
  }[];
  synthesis?: {
    inlineComments?: { file: string; line: number; content: string }[];
    summaryComment?: string;
    stats?: {
      totalFindings: number;
      duplicatesRemoved?: number;
      bySeverity?: Record<Severity, number>;
      byCategory?: Record<Category, number>;
    };
    recommendation?: string;
    confidenceScore?: number;
  };
  traces?: AgentTrace[];
  prUrl?: string;
}
