export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Category = "security" | "bug" | "duplication" | "api-change" | "refactor";

/** Investigation trail showing how an agent verified a finding */
export interface InvestigationTrail {
  toolsUsed: string[];
  filesChecked: string[];
  patternsSearched: string[];
  conclusion: string;
}

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
  // Verification status - set by verification agent
  disproven?: boolean;
  disprovenReason?: string;
  verificationNotes?: string;
  /** Investigation trail documenting how the agent verified this finding */
  investigation?: InvestigationTrail;
}

/** Summary of tool calls made during an agent execution */
export interface ToolUsageSummary {
  totalCalls: number;
  byTool: Record<string, number>;
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
  /** OpenRouter generation ID for re-fetching cost data */
  generationId?: string;
  /** Tool usage summary — tracks whether the agent actually used its tools */
  toolUsage?: ToolUsageSummary;
}

export interface ReviewResult {
  findings: Finding[];
  disprovenFindings?: Finding[]; // Findings disproven by verification agent
  summary: {
    totalFindings: number;
    disprovenCount?: number; // Count of false positives removed
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
  options?: {
    skipSecurity?: boolean;
    skipDuplication?: boolean;
    priorityFiles?: string[];
  };
}
