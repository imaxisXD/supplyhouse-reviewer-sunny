import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { Observability, DefaultExporter, SamplingStrategyType } from "@mastra/observability";
import { securityAgent } from "../agents/security.ts";
import { logicAgent } from "../agents/logic.ts";
import { duplicationAgent } from "../agents/duplication.ts";
import { apiChangeAgent } from "../agents/api-change.ts";
import { refactorAgent } from "../agents/refactor.ts";
import { plannerAgent } from "../agents/planner.ts";
import { synthesisAgent } from "../agents/synthesis.ts";
import { completenessAgent } from "../agents/completeness.ts";
import { verificationAgent } from "../agents/verification.ts";
import { domainFactsWorkflow } from "../workflows/domain-facts.ts";

/**
 * Storage for Mastra observability traces.
 * Uses LibSQL (SQLite-compatible) for local persistence.
 */
const storage = new LibSQLStore({
  id: "supplyhouse-reviewer-storage",
  url: process.env.LIBSQL_URL || "file:./data/mastra.db",
});

/**
 * Observability configuration for tracing agent executions.
 * Uses the DefaultExporter which persists traces to the storage.
 */
const observability = new Observability({
  configs: {
    default: {
      serviceName: "supplyhouse-reviewer",
      exporters: [new DefaultExporter()],
      sampling: { type: SamplingStrategyType.ALWAYS },
      includeInternalSpans: false,
    },
  },
});

/**
 * Central Mastra instance that registers all specialist agents and
 * exposes them for use in the review workflow.
 *
 * Includes:
 * - All 6 specialist agents for code review
 * - LibSQL storage for trace persistence
 * - AI Tracing observability enabled (creates spans for AGENT_RUN, MODEL_GENERATION, TOOL_CALL)
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
    "planner-agent": plannerAgent,
    "synthesis-agent": synthesisAgent,
    "completeness-agent": completenessAgent,
    "verification-agent": verificationAgent,
  },
  workflows: {
    "get_domain_facts": domainFactsWorkflow,
  },
  storage,
  observability,
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
  plannerAgent,
  synthesisAgent,
  completenessAgent,
  verificationAgent,
};
