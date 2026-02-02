/**
 * Pre-configured circuit breakers for all external services.
 *
 * Each breaker is tuned to the failure characteristics of its service:
 *   - LLM/Embedding APIs: higher threshold, longer reset (transient rate limits)
 *   - BitBucket: moderate threshold, shorter reset
 *   - Databases: low threshold, short reset (usually fast to recover)
 */

import { CircuitBreaker } from "../utils/circuit-breaker.ts";

/** OpenRouter LLM API – tolerates more failures before opening. */
export const openRouterBreaker = new CircuitBreaker({
  name: "openrouter",
  failureThreshold: 8,
  resetTimeout: 60_000,
  monitorWindow: 120_000,
});

/** Voyage AI Embedding API. */
export const voyageBreaker = new CircuitBreaker({
  name: "voyage-ai",
  failureThreshold: 5,
  resetTimeout: 45_000,
  monitorWindow: 90_000,
});

/** BitBucket REST API. */
export const bitbucketBreaker = new CircuitBreaker({
  name: "bitbucket",
  failureThreshold: 5,
  resetTimeout: 30_000,
  monitorWindow: 60_000,
});

/** Qdrant vector database. */
export const qdrantBreaker = new CircuitBreaker({
  name: "qdrant",
  failureThreshold: 3,
  resetTimeout: 15_000,
  monitorWindow: 30_000,
});

/** Memgraph graph database. */
export const memgraphBreaker = new CircuitBreaker({
  name: "memgraph",
  failureThreshold: 3,
  resetTimeout: 15_000,
  monitorWindow: 30_000,
});

/** Map of all breakers for health checks. */
export const allBreakers = {
  openrouter: openRouterBreaker,
  "voyage-ai": voyageBreaker,
  bitbucket: bitbucketBreaker,
  qdrant: qdrantBreaker,
  memgraph: memgraphBreaker,
} as const;

/**
 * Get a summary of all circuit breaker states.
 */
export function getBreakerStates(): Record<string, { state: string; failures: number }> {
  const result: Record<string, { state: string; failures: number }> = {};
  for (const [name, breaker] of Object.entries(allBreakers)) {
    const stats = breaker.getStats();
    result[name] = { state: stats.state, failures: stats.failures };
  }
  return result;
}
