import { Mastra } from "@mastra/core/mastra";
import { securityAgent } from "../agents/security.ts";
import { logicAgent } from "../agents/logic.ts";
import { duplicationAgent } from "../agents/duplication.ts";
import { apiChangeAgent } from "../agents/api-change.ts";
import { refactorAgent } from "../agents/refactor.ts";
import { synthesisAgent } from "../agents/synthesis.ts";

/**
 * Central Mastra instance that registers all specialist agents and
 * exposes them for use in the review workflow.
 *
 * Usage:
 *   import { mastra } from "./mastra/index.ts";
 *   const agent = mastra.getAgent("security-agent");
 *   const result = await agent.generate("Analyze this diff ...");
 */
export const mastra = new Mastra({
  agents: {
    "security-agent": securityAgent,
    "logic-agent": logicAgent,
    "duplication-agent": duplicationAgent,
    "api-change-agent": apiChangeAgent,
    "refactor-agent": refactorAgent,
    "synthesis-agent": synthesisAgent,
  },
});

/**
 * Convenience re-exports so consumers can import agents directly
 * from the mastra module if needed.
 */
export {
  securityAgent,
  logicAgent,
  duplicationAgent,
  apiChangeAgent,
  refactorAgent,
  synthesisAgent,
};
