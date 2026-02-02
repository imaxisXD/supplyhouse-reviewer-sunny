/**
 * Model configurations for each specialist agent.
 *
 * Models are accessed via OpenRouter, which provides a unified API across providers.
 * Security-sensitive and reasoning-heavy agents use Claude Sonnet while the duplication
 * agent uses a faster/cheaper model since it primarily relies on embedding similarity.
 */
export const MODELS = {
  security: "openrouter/anthropic/claude-sonnet-4-20250514",
  logic: "openrouter/anthropic/claude-sonnet-4-20250514",
  duplication: "openrouter/google/gemini-2.0-flash-001",
  apiChange: "openrouter/anthropic/claude-sonnet-4-20250514",
  refactor: "openrouter/anthropic/claude-sonnet-4-20250514",
  synthesis: "openrouter/anthropic/claude-sonnet-4-20250514",
} as const;

export type ModelRole = keyof typeof MODELS;

export const MODEL_PRICING: Record<string, { inputPer1kTokens: number; outputPer1kTokens: number }> = {
  "openrouter/anthropic/claude-sonnet-4-20250514": { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
  "openrouter/google/gemini-2.0-flash-001": { inputPer1kTokens: 0.0001, outputPer1kTokens: 0.0004 },
};

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens / 1000) * pricing.inputPer1kTokens + (outputTokens / 1000) * pricing.outputPer1kTokens;
}
