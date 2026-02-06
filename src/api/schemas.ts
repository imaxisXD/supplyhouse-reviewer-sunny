/**
 * Shared Elysia response schemas for Eden Treaty type inference.
 * Shapes derived from dashboard/src/api/types.ts (the frontend source of truth).
 */
import { t } from "elysia";

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export const ErrorResponse = t.Object({ error: t.String() });

// ---------------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------------

export const JourneyStateSchema = t.Object({
  step: t.String(),
  updatedAt: t.Optional(t.String()),
});

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export const TokenValidationResultSchema = t.Object({
  valid: t.Boolean(),
  error: t.Optional(t.String()),
  username: t.Optional(t.String()),
  pr: t.Optional(
    t.Object({
      title: t.String(),
      author: t.String(),
      sourceBranch: t.String(),
      targetBranch: t.String(),
    })
  ),
});

export const ReviewIdResponseSchema = t.Object({ reviewId: t.String() });

export const FindingSchema = t.Object({
  file: t.String(),
  line: t.Number(),
  severity: t.Union([
    t.Literal("critical"),
    t.Literal("high"),
    t.Literal("medium"),
    t.Literal("low"),
    t.Literal("info"),
  ]),
  category: t.String(),
  title: t.String(),
  description: t.String(),
  suggestion: t.Optional(t.String()),
  confidence: t.Optional(t.Number()),
  cwe: t.Optional(t.String()),
  relatedCode: t.Optional(
    t.Object({
      file: t.String(),
      line: t.Number(),
      functionName: t.String(),
      similarity: t.Optional(t.Number()),
    })
  ),
  affectedFiles: t.Optional(
    t.Array(
      t.Object({
        file: t.String(),
        line: t.Number(),
        usage: t.String(),
      })
    )
  ),
  lineText: t.Optional(t.String()),
  lineId: t.Optional(t.String()),
  unlocatable: t.Optional(t.Boolean()),
  disproven: t.Optional(t.Boolean()),
  disprovenReason: t.Optional(t.String()),
  verificationNotes: t.Optional(t.String()),
  investigation: t.Optional(
    t.Object({
      toolsUsed: t.Array(t.String()),
      filesChecked: t.Array(t.String()),
      patternsSearched: t.Array(t.String()),
      conclusion: t.String(),
    })
  ),
});

export const ReviewStatusSchema = t.Object({
  id: t.String(),
  phase: t.String(),
  percentage: t.Number(),
  findingsCount: t.Optional(t.Number()),
  findings: t.Optional(t.Array(FindingSchema)),
  currentFile: t.Optional(t.String()),
  agentsRunning: t.Optional(t.Array(t.String())),
  startedAt: t.String(),
  completedAt: t.Optional(t.String()),
  error: t.Optional(t.String()),
  prUrl: t.Optional(t.String()),
});

export const AgentTraceSchema = t.Object({
  agent: t.String(),
  startedAt: t.String(),
  completedAt: t.String(),
  durationMs: t.Number(),
  inputTokens: t.Number(),
  outputTokens: t.Number(),
  costUsd: t.Number(),
  findingsCount: t.Number(),
  status: t.Union([
    t.Literal("success"),
    t.Literal("failed"),
    t.Literal("skipped"),
  ]),
  error: t.Optional(t.String()),
  mastraTraceId: t.Optional(t.String()),
  generationId: t.Optional(t.String()),
  toolUsage: t.Optional(
    t.Object({
      totalCalls: t.Number(),
      byTool: t.Record(t.String(), t.Number()),
    })
  ),
});

export const ReviewResultSchema = t.Object({
  findings: t.Array(FindingSchema),
  disprovenFindings: t.Optional(t.Array(FindingSchema)),
  summary: t.Object({
    totalFindings: t.Number(),
    disprovenCount: t.Optional(t.Number()),
    bySeverity: t.Record(t.String(), t.Number()),
    byCategory: t.Record(t.String(), t.Number()),
    filesAnalyzed: t.Number(),
    durationMs: t.Number(),
    costUsd: t.Number(),
  }),
  commentsPosted: t.Array(
    t.Object({
      commentId: t.String(),
      file: t.String(),
      line: t.Number(),
    })
  ),
  synthesis: t.Optional(
    t.Object({
      inlineComments: t.Optional(
        t.Array(
          t.Object({
            file: t.String(),
            line: t.Number(),
            content: t.String(),
          })
        )
      ),
      summaryComment: t.Optional(t.String()),
      stats: t.Optional(
        t.Object({
          totalFindings: t.Number(),
          duplicatesRemoved: t.Optional(t.Number()),
          bySeverity: t.Optional(t.Record(t.String(), t.Number())),
          byCategory: t.Optional(t.Record(t.String(), t.Number())),
        })
      ),
      recommendation: t.Optional(t.String()),
      confidenceScore: t.Optional(t.Number()),
    })
  ),
  traces: t.Optional(t.Array(AgentTraceSchema)),
  prUrl: t.Optional(t.String()),
  options: t.Optional(
    t.Object({
      skipSecurity: t.Optional(t.Boolean()),
      skipDuplication: t.Optional(t.Boolean()),
      priorityFiles: t.Optional(t.Array(t.String())),
    })
  ),
});

export const CancelResponseSchema = t.Object({ message: t.String() });

// ---------------------------------------------------------------------------
// Reviews list / Metrics
// ---------------------------------------------------------------------------

export const ReviewListItemSchema = t.Object({
  id: t.String(),
  phase: t.String(),
  totalFindings: t.Number(),
  durationMs: t.Number(),
  costUsd: t.Number(),
  filesAnalyzed: t.Number(),
  startedAt: t.String(),
  completedAt: t.Optional(t.String()),
  error: t.Optional(t.String()),
  prUrl: t.Optional(t.String()),
});

export const ReviewsListResponseSchema = t.Object({
  reviews: t.Array(ReviewListItemSchema),
  total: t.Number(),
});

export const SeverityCountsSchema = t.Object({
  critical: t.Number(),
  high: t.Number(),
  medium: t.Number(),
  low: t.Number(),
  info: t.Number(),
});

export const CircuitBreakerStateSchema = t.Object({
  state: t.String(),
  failures: t.Number(),
});

export const MetricsSchema = t.Object({
  totalReviews: t.Number(),
  totalFindings: t.Number(),
  avgDurationMs: t.Number(),
  totalCostUsd: t.Number(),
  severityCounts: SeverityCountsSchema,
  circuitBreakers: t.Record(t.String(), CircuitBreakerStateSchema),
});

export const RefreshCostsResponseSchema = t.Object({
  totalReviews: t.Number(),
  totalFindings: t.Number(),
  avgDurationMs: t.Number(),
  totalCostUsd: t.Number(),
  severityCounts: SeverityCountsSchema,
  circuitBreakers: t.Record(t.String(), CircuitBreakerStateSchema),
  refreshStats: t.Optional(
    t.Object({
      updatedCount: t.Number(),
      skippedCount: t.Number(),
      errorCount: t.Number(),
    })
  ),
});

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export const IndexIdResponseSchema = t.Object({ indexId: t.String() });

export const RepoMetaSchema = t.Object({
  repoId: t.String(),
  repoUrl: t.String(),
  branch: t.Optional(t.String()),
  framework: t.Optional(t.String()),
  updatedAt: t.Optional(t.String()),
});

export const RepoMetaListResponseSchema = t.Object({
  items: t.Array(RepoMetaSchema),
});

export const IndexStatusSchema = t.Object({
  id: t.String(),
  phase: t.String(),
  percentage: t.Number(),
  repoId: t.Optional(t.String()),
  repoUrl: t.Optional(t.String()),
  branch: t.Optional(t.String()),
  framework: t.Optional(t.String()),
  includeEmbeddings: t.Optional(t.Boolean()),
  filesProcessed: t.Optional(t.Number()),
  totalFiles: t.Optional(t.Number()),
  functionsIndexed: t.Optional(t.Number()),
  startedAt: t.Optional(t.String()),
  completedAt: t.Optional(t.String()),
  error: t.Optional(t.String()),
});

export const IndexFrameworkSchema = t.Object({
  id: t.String(),
  name: t.String(),
  languages: t.Array(t.String()),
});

export const IndexFrameworksResponseSchema = t.Object({
  frameworks: t.Array(IndexFrameworkSchema),
});

export const IndexJobsResponseSchema = t.Object({
  jobs: t.Array(t.Record(t.String(), t.Unknown())),
  total: t.Number(),
  nextOffset: t.Union([t.Number(), t.Null()]),
});

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export const RepoInfoSchema = t.Object({
  repoId: t.String(),
  fileCount: t.Number(),
  functionCount: t.Number(),
  classCount: t.Number(),
});

export const IndexedReposResponseSchema = t.Object({
  repos: t.Array(RepoInfoSchema),
});

export const GraphNodeSchema = t.Object({
  id: t.String(),
  label: t.String(),
  name: t.String(),
  path: t.Optional(t.String()),
  language: t.Optional(t.String()),
  startLine: t.Optional(t.Number()),
  endLine: t.Optional(t.Number()),
  isExported: t.Optional(t.Boolean()),
  isAsync: t.Optional(t.Boolean()),
  params: t.Optional(t.String()),
  returnType: t.Optional(t.String()),
  extendsName: t.Optional(t.String()),
  propertyCount: t.Optional(t.Number()),
  methodCount: t.Optional(t.Number()),
});

export const GraphLinkSchema = t.Object({
  source: t.String(),
  target: t.String(),
  type: t.String(),
  weight: t.Optional(t.Number()),
  line: t.Optional(t.Number()),
  symbols: t.Optional(t.Array(t.String())),
});

export const GraphDataSchema = t.Object({
  nodes: t.Array(GraphNodeSchema),
  links: t.Array(GraphLinkSchema),
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const HealthSimpleSchema = t.Object({
  status: t.String(),
  timestamp: t.String(),
});

export const HealthServicesSchema = t.Object({
  status: t.String(),
  services: t.Object({
    qdrant: t.Boolean(),
    memgraph: t.Boolean(),
    redis: t.Boolean(),
  }),
  circuitBreakers: t.Record(t.String(), CircuitBreakerStateSchema),
  degradation: t.Unknown(),
  timestamp: t.String(),
});

// ---------------------------------------------------------------------------
// Mastra Traces
// ---------------------------------------------------------------------------

export const MastraSpanSchema = t.Object({
  id: t.Unknown(),
  traceId: t.Unknown(),
  parentSpanId: t.Union([t.Unknown(), t.Null()]),
  name: t.String(),
  scope: t.Union([t.Unknown(), t.Null()]),
  startTime: t.Union([t.String(), t.Null()]),
  endTime: t.Union([t.String(), t.Null()]),
  input: t.Union([t.Unknown(), t.Null()]),
  output: t.Union([t.Unknown(), t.Null()]),
  attributes: t.Union([t.Unknown(), t.Null()]),
  status: t.Object({
    code: t.Optional(t.Number()),
    message: t.Optional(t.String()),
  }),
});

export const MastraTraceSchema = t.Object({
  id: t.Unknown(),
  name: t.Union([t.Unknown(), t.Null()]),
  scope: t.Union([t.Unknown(), t.Null()]),
  startTime: t.Union([t.String(), t.Null()]),
  endTime: t.Union([t.String(), t.Null()]),
  attributes: t.Union([t.Unknown(), t.Null()]),
});

export const TraceListResponseSchema = t.Object({
  traces: t.Array(MastraTraceSchema),
  total: t.Number(),
});

export const TraceDetailResponseSchema = t.Object({
  traceId: t.String(),
  rootSpan: t.Union([MastraSpanSchema, t.Null()]),
  spans: t.Array(MastraSpanSchema),
  spanCount: t.Number(),
});

export const SpansResponseSchema = t.Object({
  spans: t.Array(MastraSpanSchema),
  total: t.Optional(t.Number()),
});

export const TraceStatsResponseSchema = t.Object({
  totalTraces: t.Number(),
  totalSpans: t.Number(),
  avgDurationMs: t.Number(),
  spanTypeCount: t.Record(t.String(), t.Number()),
});

export const ReviewTraceAgentSchema = t.Object({
  name: t.String(),
  traceId: t.String(),
  startTime: t.Union([t.String(), t.Null()]),
  endTime: t.Union([t.String(), t.Null()]),
  status: t.String(),
});

export const ReviewTraceGroupSchema = t.Object({
  reviewId: t.String(),
  prUrl: t.Union([t.String(), t.Null()]),
  agentCount: t.Number(),
  startTime: t.Union([t.String(), t.Null()]),
  endTime: t.Union([t.String(), t.Null()]),
  agents: t.Array(ReviewTraceAgentSchema),
});

export const ReviewTraceGroupResponseSchema = t.Object({
  reviews: t.Array(ReviewTraceGroupSchema),
});

// ---------------------------------------------------------------------------
// Repo Docs
// ---------------------------------------------------------------------------

export const RepoDocListItemSchema = t.Object({
  id: t.String(),
  repoId: t.String(),
  title: t.String(),
  createdAt: t.String(),
  updatedAt: t.String(),
});

export const RepoDocSchema = t.Object({
  id: t.String(),
  repoId: t.String(),
  title: t.String(),
  body: t.String(),
  createdAt: t.String(),
  updatedAt: t.String(),
});

export const RepoDocsListResponseSchema = t.Object({
  docs: t.Array(RepoDocListItemSchema),
});

export const RepoDocSummarySchema = t.Object({
  repoId: t.String(),
  hasDocs: t.Boolean(),
  docCount: t.Number(),
  summaryMarkdown: t.String(),
  latestUpdatedAt: t.Optional(t.Union([t.String(), t.Null()])),
});

export const DeleteOkResponseSchema = t.Object({ ok: t.Boolean() });
