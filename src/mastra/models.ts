/**
 * Model configurations for each specialist agent.
 *
 * Models are accessed via OpenRouter, which provides a unified API across providers.
 * Security-sensitive and reasoning-heavy agents use Claude Sonnet while the duplication
 * agent uses a faster/cheaper model since it primarily relies on embedding similarity.
 */
export const MODELS = {
  security: "openrouter/moonshotai/kimi-k2.5",
  logic: "openrouter/moonshotai/kimi-k2.5",
  duplication: "openrouter/google/gemini-3-flash-preview",
  apiChange: "openrouter/moonshotai/kimi-k2.5",
  refactor: "openrouter/moonshotai/kimi-k2.5",
  planner: "openrouter/moonshotai/kimi-k2.5",
  synthesis: "openrouter/moonshotai/kimi-k2.5",
  // Completeness agent - finds MISSING controls (uses same model as logic for reasoning)
  discovery: "openrouter/moonshotai/kimi-k2.5",
  // Verification agent - disproves findings (fast model for cost efficiency)
  verification: "openrouter/moonshotai/kimi-k2.5",
} as const;

export type ModelRole = keyof typeof MODELS;
