/**
 * Graceful degradation service.
 *
 * Monitors circuit breaker states and external service health to determine
 * which capabilities are currently available. The review workflow consults
 * this module to decide whether to skip agents or fall back to simpler
 * strategies when a dependency is unhealthy.
 */

import { qdrantBreaker, memgraphBreaker, openRouterBreaker, voyageBreaker, bitbucketBreaker } from "./breakers.ts";
import { env } from "../config/env.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("degradation");

export interface DegradationMode {
  /** Memgraph is unavailable – skip graph queries, use grep fallback. */
  noGraph: boolean;
  /** Qdrant is unavailable – skip vector similarity, skip duplication agent. */
  noVectors: boolean;
  /** LLM is slow or failing – fall back to cheaper model. */
  slowLlm: boolean;
  /** Embedding API unavailable – skip embedding generation. */
  noEmbeddings: boolean;
  /** Bitbucket API unavailable – skip comment posting. */
  noBitbucket: boolean;
}

/**
 * Check current service states and return the active degradation mode.
 *
 * This is called at the start of each review so the workflow can adapt.
 */
export function getDegradationMode(): DegradationMode {
  const mode: DegradationMode = {
    noGraph: memgraphBreaker.getState() === "OPEN",
    noVectors: qdrantBreaker.getState() === "OPEN",
    slowLlm: openRouterBreaker.getState() === "OPEN" || !env.OPENROUTER_API_KEY,
    noEmbeddings: voyageBreaker.getState() === "OPEN" || !env.VOYAGE_API_KEY,
    noBitbucket: bitbucketBreaker.getState() === "OPEN",
  };

  if (mode.noGraph || mode.noVectors || mode.slowLlm || mode.noEmbeddings) {
    log.warn({ mode }, "Running in degraded mode");
  }

  return mode;
}

/**
 * Fallback model to use when the primary LLM provider is degraded.
 */
export const FALLBACK_MODEL = "openrouter/google/gemini-2.0-flash-001";
