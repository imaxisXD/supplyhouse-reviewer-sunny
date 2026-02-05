const BASE_URL = "";

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

// ---------------------------------------------------------------------------
// Journey APIs
// ---------------------------------------------------------------------------

export async function getJourney(): Promise<JourneyState> {
  const res = await fetch(`${BASE_URL}/api/journey`);
  if (!res.ok) throw new Error(`Failed to fetch journey: ${res.statusText}`);
  return res.json();
}

export async function setJourney(step: JourneyStepId): Promise<JourneyState> {
  const res = await fetch(`${BASE_URL}/api/journey`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step }),
  });
  if (!res.ok) throw new Error(`Failed to update journey: ${res.statusText}`);
  return res.json();
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
  /** Mastra trace ID for viewing detailed spans */
  mastraTraceId?: string;
}

// ---------------------------------------------------------------------------
// Review APIs
// ---------------------------------------------------------------------------

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

export async function validateToken(prUrl: string, token: string): Promise<TokenValidationResult> {
  const res = await fetch(`${BASE_URL}/api/review/validate-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl, token }),
  });
  return res.json();
}

export async function submitReview(data: ReviewSubmission): Promise<{ reviewId: string }> {
  const res = await fetch(`${BASE_URL}/api/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to submit review: ${res.statusText}`);
  return res.json();
}

export async function getReviewStatus(id: string): Promise<ReviewStatus> {
  const res = await fetch(`${BASE_URL}/api/review/${id}/status`);
  if (!res.ok) throw new Error(`Failed to get review status: ${res.statusText}`);
  return res.json();
}

export async function getReviewResult(id: string): Promise<ReviewResult> {
  const res = await fetch(`${BASE_URL}/api/review/${id}/result`);
  if (!res.ok) throw new Error(`Failed to get review result: ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Index APIs
// ---------------------------------------------------------------------------

export async function submitIndex(data: IndexSubmission): Promise<{ indexId: string }> {
  const res = await fetch(`${BASE_URL}/api/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to submit index: ${res.statusText}`);
  return res.json();
}

export async function submitForceReindex(data: ForceReindexSubmission): Promise<{ indexId: string }> {
  const res = await fetch(`${BASE_URL}/api/index/force`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const payload = await res.json();
      message = payload?.error || payload?.message || message;
    } catch {
      // ignore parse errors
    }
    throw new Error(`Failed to submit force re-index: ${message}`);
  }
  return res.json();
}

export async function submitIncrementalIndex(data: IncrementalIndexSubmission): Promise<{ indexId: string }> {
  const res = await fetch(`${BASE_URL}/api/index/incremental`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to submit incremental index: ${res.statusText}`);
  return res.json();
}

export async function getRepoMeta(repoId: string): Promise<RepoMeta> {
  const res = await fetch(`${BASE_URL}/api/index/meta/${encodeURIComponent(repoId)}`);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const payload = await res.json();
      message = payload?.error || payload?.message || message;
    } catch {
      // ignore parse errors
    }
    throw new Error(`Failed to fetch repo metadata: ${message}`);
  }
  return res.json();
}

export async function getIndexJobs(
  limit = 20,
  offset?: number,
): Promise<{ jobs: Record<string, unknown>[]; total: number; nextOffset?: number | null }> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (typeof offset === "number") params.set("offset", String(offset));
  const res = await fetch(`${BASE_URL}/api/index/jobs?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to get index jobs: ${res.statusText}`);
  return res.json();
}

export async function getIndexFrameworks(): Promise<{ frameworks: IndexFramework[] }> {
  const res = await fetch(`${BASE_URL}/api/index/frameworks`);
  if (!res.ok) throw new Error(`Failed to get index frameworks: ${res.statusText}`);
  return res.json();
}

export async function cancelReview(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/review/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to cancel review: ${res.statusText}`);
}

export async function cancelIndex(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/index/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to cancel index: ${res.statusText}`);
}

// ---------------------------------------------------------------------------
// Observability APIs
// ---------------------------------------------------------------------------

export async function getReviewsList(limit = 50): Promise<{ reviews: ReviewListItem[]; total: number }> {
  const res = await fetch(`${BASE_URL}/api/reviews?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to get reviews list: ${res.statusText}`);
  return res.json();
}

export async function getMetrics(): Promise<Metrics> {
  const res = await fetch(`${BASE_URL}/api/metrics`);
  if (!res.ok) throw new Error(`Failed to get metrics: ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Graph APIs
// ---------------------------------------------------------------------------

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
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export async function getIndexedRepos(): Promise<{ repos: RepoInfo[] }> {
  const res = await fetch(`${BASE_URL}/api/graph/repos`);
  if (!res.ok) throw new Error(`Failed to get indexed repos: ${res.statusText}`);
  return res.json();
}

export async function getRepoGraph(
  repoId: string,
  view: GraphView = "overview",
): Promise<GraphData> {
  const params = new URLSearchParams();
  params.set("view", view);
  const res = await fetch(
    `${BASE_URL}/api/graph/${encodeURIComponent(repoId)}?${params.toString()}`,
  );
  if (!res.ok) throw new Error(`Failed to get repo graph: ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Health API
// ---------------------------------------------------------------------------

export async function getHealth(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/health/services`);
  if (!res.ok) throw new Error(`Failed to get health: ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Mastra Traces API
// ---------------------------------------------------------------------------

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

export async function getMastraTraces(params?: {
  limit?: number;
  name?: string;
  startDate?: string;
  endDate?: string;
}): Promise<TraceListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.name) searchParams.set("name", params.name);
  if (params?.startDate) searchParams.set("startDate", params.startDate);
  if (params?.endDate) searchParams.set("endDate", params.endDate);

  const res = await fetch(`${BASE_URL}/api/traces?${searchParams}`);
  if (!res.ok) throw new Error(`Failed to fetch traces: ${res.statusText}`);
  return res.json();
}

export async function getMastraTrace(traceId: string): Promise<TraceDetailResponse> {
  const res = await fetch(`${BASE_URL}/api/traces/${encodeURIComponent(traceId)}`);
  if (!res.ok) throw new Error(`Failed to fetch trace: ${res.statusText}`);
  return res.json();
}

export async function getMastraSpans(traceId: string): Promise<SpansResponse> {
  const res = await fetch(`${BASE_URL}/api/traces/${encodeURIComponent(traceId)}/spans`);
  if (!res.ok) throw new Error(`Failed to fetch spans: ${res.statusText}`);
  return res.json();
}

export async function getMastraTraceStats(): Promise<TraceStatsResponse> {
  const res = await fetch(`${BASE_URL}/api/traces/stats`);
  if (!res.ok) throw new Error(`Failed to fetch trace stats: ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

type WSOptions = {
  onOpen?: () => void;
  onClose?: () => void;
};

function normalizeOptions(options?: (() => void) | WSOptions): WSOptions {
  if (!options) return {};
  if (typeof options === "function") return { onClose: options };
  return options;
}

export function connectWebSocket(
  reviewId: string,
  onMessage: (event: WSEvent) => void,
  options?: (() => void) | WSOptions,
): () => void {
  const { onOpen, onClose } = normalizeOptions(options);
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const params = new URLSearchParams();
  params.set("reviewId", reviewId);
  const authToken = import.meta.env.VITE_WS_AUTH_TOKEN as string | undefined;
  if (authToken) params.set("auth", authToken);
  let ws: WebSocket | null = null;
  let closed = false;
  let retryCount = 0;
  let retryTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`${protocol}//${host}/ws?${params.toString()}`);

    ws.onopen = () => {
      retryCount = 0;
      onOpen?.();
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        onMessage(parsed);
      } catch {
        // Ignore non-JSON messages
      }
    };

    ws.onclose = (event) => {
      onClose?.();
      if (closed) return;
      if (event.code === 4000 || event.code === 4001) {
        closed = true;
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
      retryCount += 1;
      retryTimer = window.setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer) {
      window.clearTimeout(retryTimer);
    }
    ws?.close();
  };
}

export function connectIndexWebSocket(
  indexId: string,
  onMessage: (event: Record<string, unknown>) => void,
  options?: (() => void) | WSOptions,
): () => void {
  const { onOpen, onClose } = normalizeOptions(options);
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const params = new URLSearchParams();
  params.set("indexId", indexId);
  const authToken = import.meta.env.VITE_WS_AUTH_TOKEN as string | undefined;
  if (authToken) params.set("auth", authToken);
  let ws: WebSocket | null = null;
  let closed = false;
  let retryCount = 0;
  let retryTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`${protocol}//${host}/ws?${params.toString()}`);

    ws.onopen = () => {
      retryCount = 0;
      onOpen?.();
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        onMessage(parsed);
      } catch {
        // Ignore non-JSON messages
      }
    };

    ws.onclose = (event) => {
      onClose?.();
      if (closed) return;
      if (event.code === 4000 || event.code === 4001) {
        closed = true;
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
      retryCount += 1;
      retryTimer = window.setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer) {
      window.clearTimeout(retryTimer);
    }
    ws?.close();
  };
}
