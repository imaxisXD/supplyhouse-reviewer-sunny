/**
 * Shared type definitions for the dashboard API layer.
 * Extracted from client.ts for better organization.
 */

export interface ReviewOptions {
  skipSecurity?: boolean;
  skipDuplication?: boolean;
  priorityFiles?: string[];
}

export type JourneyStepId = "submit" | "review" | "results" | "explore";

export interface JourneyState {
  step: JourneyStepId;
  updatedAt?: string;
}

export interface ReviewSubmission {
  prUrl: string;
  token: string;
  options?: ReviewOptions;
}

export interface IndexSubmission {
  repoUrl: string;
  token: string;
  branch?: string;
  framework?: string;
}

export interface ForceReindexSubmission {
  repoId: string;
  token: string;
  branch?: string;
  framework?: string;
}

export interface RepoMeta {
  repoId: string;
  repoUrl: string;
  branch?: string;
  framework?: string;
  updatedAt?: string;
}

export interface RepoDocListItem {
  id: string;
  repoId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoDoc extends RepoDocListItem {
  body: string;
}

export interface RepoDocSummary {
  repoId: string;
  hasDocs: boolean;
  docCount: number;
  summaryMarkdown: string;
  latestUpdatedAt?: string | null;
}

export interface IndexFramework {
  id: string;
  name: string;
  languages: string[];
}

export interface IncrementalIndexSubmission extends IndexSubmission {
  changedFiles: string[];
}

export interface ReviewStatus {
  id: string;
  phase: string;
  percentage: number;
  findingsCount?: number;
  findings?: Finding[];
  currentFile?: string;
  agentsRunning?: string[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface Finding {
  file: string;
  line: number;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  title: string;
  description: string;
  suggestion?: string;
  confidence?: number;
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
  disproven?: boolean;
  disprovenReason?: string;
  verificationNotes?: string;
  investigation?: {
    toolsUsed: string[];
    filesChecked: string[];
    patternsSearched: string[];
    conclusion: string;
  };
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
  mastraTraceId?: string;
  generationId?: string;
  toolUsage?: {
    totalCalls: number;
    byTool: Record<string, number>;
  };
}

export interface ReviewResult {
  findings: Finding[];
  disprovenFindings?: Finding[];
  summary: {
    totalFindings: number;
    disprovenCount?: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    filesAnalyzed: number;
    durationMs: number;
    costUsd: number;
  };
  commentsPosted: { commentId: string; file: string; line: number }[];
  synthesis?: {
    inlineComments?: { file: string; line: number; content: string }[];
    summaryComment?: string;
    stats?: {
      totalFindings: number;
      duplicatesRemoved?: number;
      bySeverity?: Record<string, number>;
      byCategory?: Record<string, number>;
    };
    recommendation?: string;
  };
  traces?: AgentTrace[];
  prUrl?: string;
  options?: {
    skipSecurity?: boolean;
    skipDuplication?: boolean;
    priorityFiles?: string[];
  };
}

export interface ReviewListItem {
  id: string;
  phase: string;
  totalFindings: number;
  durationMs: number;
  costUsd: number;
  filesAnalyzed: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
  prUrl?: string;
}

export interface Metrics {
  totalReviews: number;
  totalFindings: number;
  avgDurationMs: number;
  totalCostUsd: number;
  severityCounts: Record<string, number>;
  circuitBreakers: Record<string, { state: string; failures: number }>;
}

export interface TokenValidationResult {
  valid: boolean;
  error?: string;
  username?: string;
  pr?: {
    title: string;
    author: string;
    sourceBranch: string;
    targetBranch: string;
  };
}

// WebSocket event types matching backend
export type WSEventType =
  | "PHASE_CHANGE"
  | "AGENT_COMPLETE"
  | "FINDING_ADDED"
  | "ACTIVITY_LOG"
  | "REVIEW_COMPLETE"
  | "REVIEW_FAILED";

export interface WSEvent {
  type: WSEventType | string;
  phase?: string;
  percentage?: number;
  findingsCount?: number;
  currentFile?: string;
  agentsRunning?: string[];
  agent?: string;
  durationMs?: number;
  message?: string;
  timestamp?: string;
  finding?: {
    file: string;
    line: number;
    severity: string;
    title: string;
    agent: string;
  };
  summary?: {
    totalFindings: number;
    filesAnalyzed: number;
    durationMs: number;
    costUsd: number;
  };
  error?: string;
  mastraTraceId?: string;
}

// Graph types
export interface RepoInfo {
  repoId: string;
  fileCount: number;
  functionCount: number;
  classCount: number;
}

export type GraphNodeLabel = "File" | "Function" | "Class";
export type GraphView = "overview" | "full";

export type GraphEdgeType =
  | "CONTAINS"
  | "CALLS"
  | "IMPORTS"
  | "HAS_METHOD"
  | "EXTENDS"
  | "IMPLEMENTS";

export interface GraphNode {
  id: string;
  label: GraphNodeLabel;
  name: string;
  path?: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  isExported?: boolean;
  isAsync?: boolean;
  params?: string;
  returnType?: string;
  extendsName?: string;
  propertyCount?: number;
  methodCount?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: GraphEdgeType;
  weight?: number;
  line?: number;
  symbols?: string[];
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

// Mastra trace types
export interface MastraSpan {
  id: string;
  traceId: string;
  name: string;
  scope?: string;
  kind?: string;
  startTime: string;
  endTime?: string;
  parentSpanId?: string;
  input?: unknown;
  output?: unknown;
  attributes?: Record<string, unknown>;
  status?: {
    code?: number;
    message?: string;
  };
}

export interface MastraTrace {
  id: string;
  name?: string;
  scope?: string;
  startTime: string;
  endTime?: string;
  attributes?: Record<string, unknown>;
}

export interface TraceListResponse {
  traces: MastraTrace[];
  total: number;
  error?: string;
}

export interface TraceDetailResponse {
  traceId: string;
  rootSpan?: MastraSpan;
  spans: MastraSpan[];
  spanCount: number;
  error?: string;
}

export interface SpansResponse {
  spans: MastraSpan[];
  total: number;
  error?: string;
}

export interface TraceStatsResponse {
  totalTraces: number;
  totalSpans: number;
  avgDurationMs: number;
  spanTypeCount: Record<string, number>;
  error?: string;
}

export interface ReviewTraceAgent {
  name: string;
  traceId: string;
  startTime: string | null;
  endTime: string | null;
  status: string;
}

export interface ReviewTraceGroup {
  reviewId: string;
  prUrl: string | null;
  agentCount: number;
  startTime: string | null;
  endTime: string | null;
  agents: ReviewTraceAgent[];
}

export interface ReviewTraceGroupResponse {
  reviews: ReviewTraceGroup[];
}
