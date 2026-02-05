/**
 * SWR hooks wrapping the Eden Treaty client.
 * GET endpoints → useSWR; mutations → useSWRMutation.
 */
import useSWR, { type SWRConfiguration } from "swr";
import useSWRMutation from "swr/mutation";
import { api, extractErrorMessage } from "./eden";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unwrap an Eden response — throw on error, return data. */
function unwrap<T>(res: { data: T; error: unknown }): T {
  if (res.error) throw new Error(extractErrorMessage(res.error));
  return res.data as T;
}

// ---------------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------------

export function useJourney(config?: SWRConfiguration) {
  return useSWR("/api/journey", async () => unwrap(await api.api.journey.get()), config);
}

export function useSetJourney() {
  return useSWRMutation("/api/journey", async (_key, { arg }: { arg: { step: string } }) =>
    unwrap(await api.api.journey.put(arg)),
  );
}

// ---------------------------------------------------------------------------
// Repo Docs
// ---------------------------------------------------------------------------

export function useRepoDocs(repoId: string | undefined, config?: SWRConfiguration) {
  return useSWR(
    repoId ? `/api/docs/repos/${repoId}` : null,
    async () => unwrap(await api.api.docs.repos({ repoId: repoId! }).get()),
    config,
  );
}

export function useRepoDocSummary(repoId: string | undefined, config?: SWRConfiguration) {
  return useSWR(
    repoId ? `/api/docs/repos/${repoId}/summary` : null,
    async () => unwrap(await api.api.docs.repos({ repoId: repoId! }).summary.get()),
    config,
  );
}

export function useRepoDoc(docId: string | undefined, config?: SWRConfiguration) {
  return useSWR(
    docId ? `/api/docs/${docId}` : null,
    async () => unwrap(await api.api.docs({ docId: docId! }).get()),
    config,
  );
}

export function useCreateRepoDoc() {
  return useSWRMutation(
    "/api/docs",
    async (_key, { arg }: { arg: { repoId: string; title: string; body: string } }) =>
      unwrap(await api.api.docs.post(arg)),
  );
}

export function useUpdateRepoDoc(docId: string) {
  return useSWRMutation(
    `/api/docs/${docId}`,
    async (_key, { arg }: { arg: { title: string; body: string } }) =>
      unwrap(await api.api.docs({ docId }).put(arg)),
  );
}

export function useDeleteRepoDoc() {
  return useSWRMutation(
    "/api/docs/delete",
    async (_key, { arg }: { arg: string }) =>
      unwrap(await api.api.docs({ docId: arg }).delete()),
  );
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export function useValidateToken() {
  return useSWRMutation(
    "/api/review/validate-token",
    async (_key, { arg }: { arg: { prUrl: string; token: string } }) =>
      unwrap(await api.api.review["validate-token"].post(arg)),
  );
}

export function useSubmitReview() {
  return useSWRMutation(
    "/api/review",
    async (
      _key,
      {
        arg,
      }: {
        arg: {
          prUrl: string;
          token: string;
          options?: {
            skipSecurity?: boolean;
            skipDuplication?: boolean;
            priorityFiles?: string[];
          };
        };
      },
    ) => unwrap(await api.api.review.post(arg)),
  );
}

export function useReviewStatus(id: string | undefined, config?: SWRConfiguration) {
  return useSWR(
    id ? `/api/review/${id}/status` : null,
    async () => unwrap(await api.api.review({ id: id! }).status.get()),
    config,
  );
}

export function useReviewResult(id: string | undefined, config?: SWRConfiguration) {
  return useSWR(
    id ? `/api/review/${id}/result` : null,
    async () => unwrap(await api.api.review({ id: id! }).result.get()),
    config,
  );
}

export function useCancelReview() {
  return useSWRMutation(
    "/api/review/cancel",
    async (_key, { arg }: { arg: string }) =>
      unwrap(await api.api.review({ id: arg }).delete()),
  );
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export function useSubmitIndex() {
  return useSWRMutation(
    "/api/indexing",
    async (
      _key,
      {
        arg,
      }: {
        arg: {
          repoUrl: string;
          token: string;
          branch?: string;
          framework?: "react" | "typescript" | "java" | "spring-boot" | "flutter" | "ftl";
          includeEmbeddings?: boolean;
        };
      },
    ) => unwrap(await api.api.indexing.post(arg)),
  );
}

export function useSubmitForceReindex() {
  return useSWRMutation(
    "/api/indexing/force",
    async (
      _key,
      {
        arg,
      }: {
        arg: {
          repoId: string;
          token: string;
          branch?: string;
          framework?: "react" | "typescript" | "java" | "spring-boot" | "flutter" | "ftl";
          includeEmbeddings?: boolean;
        };
      },
    ) => unwrap(await api.api.indexing.force.post(arg)),
  );
}

export function useSubmitIncrementalIndex() {
  return useSWRMutation(
    "/api/indexing/incremental",
    async (
      _key,
      {
        arg,
      }: {
        arg: {
          repoUrl: string;
          token: string;
          branch?: string;
          framework?: "react" | "typescript" | "java" | "spring-boot" | "flutter" | "ftl";
          changedFiles: string[];
          includeEmbeddings?: boolean;
        };
      },
    ) => unwrap(await api.api.indexing.incremental.post(arg)),
  );
}

export function useRepoMeta(repoId: string | undefined, config?: SWRConfiguration) {
  return useSWR(
    repoId ? `/api/indexing/meta/${repoId}` : null,
    async () => unwrap(await api.api.indexing.meta({ repoId: repoId! }).get()),
    config,
  );
}

export function useRepoMetaList(config?: SWRConfiguration) {
  return useSWR("/api/indexing/meta", async () => unwrap(await api.api.indexing.meta.get()), config);
}

export function useIndexJobs(
  params?: { limit?: number; offset?: number },
  config?: SWRConfiguration,
) {
  const query = {
    limit: params?.limit?.toString(),
    offset: params?.offset?.toString(),
  };
  return useSWR(
    `/api/indexing/jobs?${new URLSearchParams(query as Record<string, string>)}`,
    async () =>
      unwrap(await api.api.indexing.jobs.get({ query })),
    config,
  );
}

export function useIndexFrameworks(config?: SWRConfiguration) {
  return useSWR(
    "/api/indexing/frameworks",
    async () => unwrap(await api.api.indexing.frameworks.get()),
    config,
  );
}

export function useCancelIndex() {
  return useSWRMutation(
    "/api/indexing/cancel",
    async (_key, { arg }: { arg: string }) =>
      unwrap(await api.api.indexing({ id: arg }).delete()),
  );
}

// ---------------------------------------------------------------------------
// Reviews list / Metrics
// ---------------------------------------------------------------------------

export function useReviewsList(limit = 50, config?: SWRConfiguration) {
  return useSWR(
    `/api/reviews?limit=${limit}`,
    async () =>
      unwrap(await api.api.reviews.get({ query: { limit: String(limit) } })),
    config,
  );
}

export function useMetrics(config?: SWRConfiguration) {
  return useSWR("/api/metrics", async () => unwrap(await api.api.metrics.get()), config);
}

export function useRefreshCosts() {
  return useSWRMutation("/api/metrics/refresh-costs", async () =>
    unwrap(await api.api.metrics["refresh-costs"].post()),
  );
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export function useIndexedRepos(config?: SWRConfiguration) {
  return useSWR(
    "/api/graph/repos",
    async () => unwrap(await api.api.graph.repos.get()),
    config,
  );
}

export function useRepoGraph(
  repoId: string | undefined,
  view: string = "overview",
  config?: SWRConfiguration,
) {
  return useSWR(
    repoId ? `/api/graph/${repoId}?view=${view}` : null,
    async () =>
      unwrap(await api.api.graph({ repoId: repoId! }).get({ query: { view } })),
    config,
  );
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function useHealth(config?: SWRConfiguration) {
  return useSWR(
    "/health/services",
    async () => unwrap(await api.health.services.get()),
    config,
  );
}

// ---------------------------------------------------------------------------
// Mastra Traces
// ---------------------------------------------------------------------------

export function useMastraTraces(
  params?: {
    limit?: number;
    name?: string;
    reviewId?: string;
    startDate?: string;
    endDate?: string;
  },
  config?: SWRConfiguration,
) {
  const query = {
    limit: params?.limit?.toString(),
    name: params?.name,
    reviewId: params?.reviewId,
    startDate: params?.startDate,
    endDate: params?.endDate,
  };
  const key = `/api/traces?${JSON.stringify(params ?? {})}`;
  return useSWR(
    key,
    async () => unwrap(await api.api.traces.get({ query })),
    config,
  );
}

export function useMastraTrace(traceId: string | undefined, config?: SWRConfiguration) {
  return useSWR(
    traceId ? `/api/traces/${traceId}` : null,
    async () => unwrap(await api.api.traces({ traceId: traceId! }).get()),
    config,
  );
}

export function useMastraSpans(traceId: string | undefined, config?: SWRConfiguration) {
  return useSWR(
    traceId ? `/api/traces/${traceId}/spans` : null,
    async () => unwrap(await api.api.traces({ traceId: traceId! }).spans.get()),
    config,
  );
}

export function useMastraTraceStats(config?: SWRConfiguration) {
  return useSWR(
    "/api/traces/stats",
    async () => unwrap(await api.api.traces.stats.get()),
    config,
  );
}

export function useTracesByReview(config?: SWRConfiguration) {
  return useSWR(
    "/api/traces/by-review",
    async () => unwrap(await api.api.traces["by-review"].get()),
    config,
  );
}

// ---------------------------------------------------------------------------
// Index Status (separate from index jobs)
// ---------------------------------------------------------------------------

export function useIndexStatus(id: string | undefined, config?: SWRConfiguration) {
  return useSWR(
    id ? `/api/indexing/${id}/status` : null,
    async () => unwrap(await api.api.indexing({ id: id! }).status.get()),
    config,
  );
}
