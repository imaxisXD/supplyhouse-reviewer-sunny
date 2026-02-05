import { env } from "../config/env.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("openrouter-cost");
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type GenerationResponse = {
  data?: {
    total_cost?: number;
  };
};

/**
 * Fetches the cost of a generation from OpenRouter's generation stats endpoint.
 * Includes retry logic because generation stats may not be immediately available
 * after a request completes (typically takes a few hundred milliseconds to index).
 */
export async function fetchOpenRouterCostUsd(
  generationId: string,
  maxRetries = 3,
  baseDelayMs = 500,
): Promise<number | null> {
  if (!generationId) return null;
  if (!env.OPENROUTER_API_KEY) {
    log.debug({ generationId }, "OPENROUTER_API_KEY not set; skipping cost lookup");
    return null;
  }

  const url = `${OPENROUTER_BASE_URL}/generation?id=${encodeURIComponent(generationId)}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        },
      });

      // Retry on 404 - generation may not be indexed yet
      if (response.status === 404 && attempt < maxRetries) {
        const delay = baseDelayMs * attempt;
        log.debug({ generationId, attempt, delay }, "Generation not found, retrying...");
        await Bun.sleep(delay);
        continue;
      }

      if (!response.ok) {
        log.warn({ generationId, status: response.status, attempt }, "OpenRouter cost lookup failed");
        return null;
      }

      const payload = (await response.json()) as GenerationResponse;
      const totalCost = payload?.data?.total_cost;

      if (typeof totalCost !== "number") {
        log.debug({ generationId, payload }, "OpenRouter cost lookup returned no total_cost");
        return null;
      }

      log.debug({ generationId, totalCost, attempt }, "OpenRouter cost retrieved");
      return totalCost;
    } catch (error) {
      log.warn(
        { generationId, error: error instanceof Error ? error.message : String(error), attempt },
        "OpenRouter cost lookup error",
      );
      if (attempt === maxRetries) return null;
      await Bun.sleep(baseDelayMs * attempt);
    }
  }
  return null;
}
