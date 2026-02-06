/**
 * Dashboard API client — imperative fetch calls still used by consumers
 * that need one-off mutations or WebSocket-connected pages.
 *
 * Most GET endpoints have been migrated to SWR hooks in ./hooks.ts.
 * WebSocket connections live in ./websocket.ts.
 */

import type {
  JourneyStepId,
  JourneyState,
  ReviewSubmission,
  IndexSubmission,
  ForceReindexSubmission,
  IncrementalIndexSubmission,
  ReviewStatus,
  ReviewResult,
  TokenValidationResult,
  SpansResponse,
} from "./types";

const BASE_URL = "";

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

// ---------------------------------------------------------------------------
// Review APIs
// ---------------------------------------------------------------------------

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

export async function cancelReview(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/review/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to cancel review: ${res.statusText}`);
}

// ---------------------------------------------------------------------------
// Index APIs
// ---------------------------------------------------------------------------

export async function submitIndex(data: IndexSubmission): Promise<{ indexId: string }> {
  const res = await fetch(`${BASE_URL}/api/indexing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to submit index: ${res.statusText}`);
  return res.json();
}

export async function submitForceReindex(data: ForceReindexSubmission): Promise<{ indexId: string }> {
  const res = await fetch(`${BASE_URL}/api/indexing/force`, {
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
  const res = await fetch(`${BASE_URL}/api/indexing/incremental`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to submit incremental index: ${res.statusText}`);
  return res.json();
}

export async function cancelIndex(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/indexing/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to cancel index: ${res.statusText}`);
}

// ---------------------------------------------------------------------------
// Mastra Traces (imperative — used for on-click span loading)
// ---------------------------------------------------------------------------

export async function getMastraSpans(traceId: string): Promise<SpansResponse> {
  const res = await fetch(`${BASE_URL}/api/traces/${encodeURIComponent(traceId)}/spans`);
  if (!res.ok) throw new Error(`Failed to fetch spans: ${res.statusText}`);
  return res.json();
}
