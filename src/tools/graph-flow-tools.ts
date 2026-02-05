/**
 * Graph-Based Data Flow Tools
 *
 * Cross-file data flow tracing via the call graph (Memgraph).
 * Used by verification agent to trace variables across function boundaries.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { runCypher } from "../db/memgraph.ts";
import { createLogger } from "../config/logger.ts";
import { getRepoContext } from "./repo-context.ts";

const log = createLogger("tools:graph-flow");

// ---------------------------------------------------------------------------
// Data source classification
// ---------------------------------------------------------------------------

type DataSourceType =
  | "USER_INPUT"
  | "DATABASE"
  | "CONFIG"
  | "SERVER_GENERATED"
  | "EXTERNAL_API"
  | "UNKNOWN";

const USER_INPUT_PATTERNS = [
  /req\.body/,
  /req\.query/,
  /req\.params/,
  /request\.body/,
  /request\.query/,
  /request\.params/,
  /\.getParameter/,
  /\.getQueryParameter/,
  /formData/,
  /FormData/,
  /URLSearchParams/,
  /event\.target\.value/,
  /input\.value/,
  /document\.getElementById/,
  /\$\(.*\)\.val\(/,
  /userinput/i,
  /userInput/i,
];

const DATABASE_PATTERNS = [
  /\.findOne/,
  /\.findMany/,
  /\.find\(/,
  /\.query\(/,
  /\.select\(/,
  /EntityQuery/,
  /prisma\./,
  /knex\./,
  /sequelize\./,
  /mongoose\./,
  /\.executeQuery/,
  /\.createQuery/,
  /Repository\./,
  /getRepository/,
];

const CONFIG_PATTERNS = [
  /process\.env/,
  /config\./,
  /Config\./,
  /\.getProperty/,
  /settings\./,
  /Settings\./,
  /Environment\./,
];

const SERVER_PATTERNS = [
  /context\.put/,
  /context\.set/,
  /res\.locals/,
  /response\.locals/,
  /session\./,
  /\.setAttribute/,
  /\.setContext/,
  /templateContext/,
];

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Classify entry point source based on code patterns
 */
function classifySourceType(code: string): DataSourceType {
  if (USER_INPUT_PATTERNS.some((p) => p.test(code))) return "USER_INPUT";
  if (DATABASE_PATTERNS.some((p) => p.test(code))) return "DATABASE";
  if (CONFIG_PATTERNS.some((p) => p.test(code))) return "CONFIG";
  if (SERVER_PATTERNS.some((p) => p.test(code))) return "SERVER_GENERATED";
  return "UNKNOWN";
}

const VALIDATION_PATTERNS = [
  /sanitize/i,
  /escape/i,
  /encode/i,
  /validate/i,
  /check/i,
  /verify/i,
  /parse(Int|Float|UUID)/,
  /DOMPurify/,
  /xss/i,
  /htmlspecialchars/i,
  /filter/i,
  /clean/i,
  /strip/i,
  /trim/,
  /\.test\(/,
  /\.match\(/,
  /typeof\s+\w+\s*===?\s*["'](string|number|boolean)/,
  /instanceof/,
  /isNaN/,
  /Number\.isFinite/,
  /Number\.isInteger/,
];

/**
 * Check if code contains validation patterns
 */
function hasValidationPattern(code: string): boolean {
  return VALIDATION_PATTERNS.some((p) => p.test(code));
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CallChainNode = z.object({
  function: z.string(),
  file: z.string(),
  line: z.number(),
});

const CallChainResult = z.object({
  path: z.array(CallChainNode),
  entryPoint: z.object({
    function: z.string(),
    file: z.string(),
    sourceType: z.enum([
      "USER_INPUT",
      "DATABASE",
      "CONFIG",
      "SERVER_GENERATED",
      "EXTERNAL_API",
      "UNKNOWN",
    ]),
  }),
  hasValidation: z.boolean(),
  validationLocation: z.string().optional(),
});

// ---------------------------------------------------------------------------
// trace_cross_file tool
// ---------------------------------------------------------------------------

export const traceCrossFileTool = createTool({
  id: "trace_cross_file",
  description:
    "Trace a variable's flow across function boundaries using the call graph. " +
    "Given a function where a dangerous sink is used, trace back through callers " +
    "to find where user input enters and if validation exists along the path. " +
    "Returns call chains, entry point classifications, and validation findings.",
  inputSchema: z.object({
    sinkFunction: z.string().describe("Function name where the dangerous sink is"),
    sinkFile: z.string().describe("File containing the sink function"),
    variableName: z
      .string()
      .optional()
      .describe("Variable used at the sink (e.g., parameter name)"),
    maxHops: z
      .number()
      .default(3)
      .describe("Maximum call chain depth to trace (default: 3)"),
  }),
  outputSchema: z.object({
    callChains: z.array(CallChainResult),
    summary: z.object({
      totalChains: z.number(),
      userInputChains: z.number(),
      validatedChains: z.number(),
      exploitableChains: z.number(),
    }),
    allPathsExploitable: z.boolean(),
    recommendation: z.enum(["VERIFY", "DISPROVE", "NEEDS_MANUAL_REVIEW"]),
    confidence: z.number(),
  }),
  execute: async (input) => {
    const { sinkFunction, sinkFile, maxHops = 3 } = input;
    const repoId = getRepoContext()?.repoId;

    log.debug({ sinkFunction, sinkFile, maxHops, repoId }, "Tracing cross-file data flow");

    if (!repoId) {
      log.warn({ sinkFunction }, "trace_cross_file missing repoId");
      return {
        callChains: [],
        summary: {
          totalChains: 0,
          userInputChains: 0,
          validatedChains: 0,
          exploitableChains: 0,
        },
        allPathsExploitable: false,
        recommendation: "NEEDS_MANUAL_REVIEW" as const,
        confidence: 0,
      };
    }

    try {
      // Step 1: Get all call chains up to maxHops
      const chainQuery = `
        MATCH path = (caller:Function)-[:CALLS*1..${maxHops}]->(sink:Function {name: $name, file: $file})
        WHERE caller.repoId = $repoId
        RETURN [node IN nodes(path) | {
          name: node.name,
          file: node.file,
          startLine: node.startLine,
          code: node.code
        }] AS chain
        LIMIT 50
      `;

      const chainRecords = await runCypher(chainQuery, {
        name: sinkFunction,
        file: sinkFile,
        repoId,
      });

      // Also get direct callers (1 hop) which might not be captured in the multi-hop query
      const directQuery = `
        MATCH (caller:Function)-[:CALLS]->(sink:Function {name: $name, file: $file})
        WHERE caller.repoId = $repoId
        RETURN [{
          name: caller.name,
          file: caller.file,
          startLine: caller.startLine,
          code: caller.code
        }, {
          name: sink.name,
          file: sink.file,
          startLine: sink.startLine,
          code: sink.code
        }] AS chain
        LIMIT 20
      `;

      const directRecords = await runCypher(directQuery, {
        name: sinkFunction,
        file: sinkFile,
        repoId,
      });

      // Combine and dedupe chains
      const allChainData = [...chainRecords, ...directRecords];
      const seenChains = new Set<string>();
      const uniqueChains: Array<
        Array<{ name: string; file: string; startLine: number; code?: string }>
      > = [];

      for (const record of allChainData) {
        const chain = record.get("chain") as Array<{
          name: string;
          file: string;
          startLine: number;
          code?: string;
        }>;
        const chainKey = chain.map((n) => `${n.file}:${n.name}`).join("->");
        if (!seenChains.has(chainKey)) {
          seenChains.add(chainKey);
          uniqueChains.push(chain);
        }
      }

      // Step 2: Analyze each chain
      const analyzedChains: Array<z.infer<typeof CallChainResult>> = [];

      for (const chain of uniqueChains) {
        // Entry point is the first node in the chain (furthest from sink)
        const entryNode = chain[0];
        if (!entryNode) continue; // Skip empty chains
        const entryCode = entryNode.code || "";

        // Classify the entry point
        const sourceType = classifySourceType(entryCode);

        // Check for validation in any node along the chain
        let hasValidation = false;
        let validationLocation: string | undefined;

        for (const node of chain) {
          const nodeCode = node.code || "";
          if (hasValidationPattern(nodeCode)) {
            hasValidation = true;
            validationLocation = `${node.file}:${node.startLine} (${node.name})`;
            break;
          }
        }

        analyzedChains.push({
          path: chain.map((n) => ({
            function: n.name,
            file: n.file,
            line: Number(n.startLine) || 0,
          })),
          entryPoint: {
            function: entryNode.name,
            file: entryNode.file,
            sourceType,
          },
          hasValidation,
          validationLocation,
        });
      }

      // Step 3: Calculate summary
      const userInputChains = analyzedChains.filter(
        (c) => c.entryPoint.sourceType === "USER_INPUT",
      );
      const validatedChains = analyzedChains.filter((c) => c.hasValidation);
      const exploitableChains = userInputChains.filter((c) => !c.hasValidation);

      const summary = {
        totalChains: analyzedChains.length,
        userInputChains: userInputChains.length,
        validatedChains: validatedChains.length,
        exploitableChains: exploitableChains.length,
      };

      // Step 4: Determine recommendation
      let recommendation: "VERIFY" | "DISPROVE" | "NEEDS_MANUAL_REVIEW";
      let confidence: number;

      if (analyzedChains.length === 0) {
        // No call chains found - might be dead code or entry point itself
        recommendation = "NEEDS_MANUAL_REVIEW";
        confidence = 0.3;
      } else if (userInputChains.length === 0) {
        // No paths from user input - likely false positive
        recommendation = "DISPROVE";
        confidence = 0.85;
      } else if (exploitableChains.length === 0) {
        // User input exists but ALL paths are validated
        recommendation = "DISPROVE";
        confidence = 0.9;
      } else if (exploitableChains.length === userInputChains.length) {
        // ALL user input paths are exploitable
        recommendation = "VERIFY";
        confidence = 0.9;
      } else {
        // Some paths are exploitable, some are not
        recommendation = "VERIFY";
        confidence = 0.7;
      }

      const allPathsExploitable =
        userInputChains.length > 0 &&
        exploitableChains.length === userInputChains.length;

      return {
        callChains: analyzedChains,
        summary,
        allPathsExploitable,
        recommendation,
        confidence,
      };
    } catch (error) {
      log.error({ error, sinkFunction, sinkFile, repoId }, "Failed to trace cross-file flow");
      return {
        callChains: [],
        summary: {
          totalChains: 0,
          userInputChains: 0,
          validatedChains: 0,
          exploitableChains: 0,
        },
        allPathsExploitable: false,
        recommendation: "NEEDS_MANUAL_REVIEW" as const,
        confidence: 0,
      };
    }
  },
});

// ---------------------------------------------------------------------------
// find_entry_points tool
// ---------------------------------------------------------------------------

export const findEntryPointsTool = createTool({
  id: "find_entry_points",
  description:
    "Find all entry points (functions with no callers) that can reach a given function. " +
    "Useful for understanding how user input can flow to a vulnerable sink.",
  inputSchema: z.object({
    targetFunction: z.string().describe("The function to find entry points for"),
    targetFile: z.string().describe("File containing the target function"),
    maxHops: z
      .number()
      .default(5)
      .describe("Maximum hops to search for entry points (default: 5)"),
  }),
  outputSchema: z.object({
    entryPoints: z.array(
      z.object({
        function: z.string(),
        file: z.string(),
        line: z.number(),
        hopsToTarget: z.number(),
        likelyUserInput: z.boolean(),
      }),
    ),
  }),
  execute: async (input) => {
    const { targetFunction, targetFile, maxHops = 5 } = input;
    const repoId = getRepoContext()?.repoId;

    log.debug({ targetFunction, targetFile, maxHops, repoId }, "Finding entry points");

    if (!repoId) {
      log.warn({ targetFunction }, "find_entry_points missing repoId");
      return { entryPoints: [] };
    }

    try {
      // Find functions that can reach the target but have no callers themselves
      const query = `
        MATCH path = (entry:Function)-[:CALLS*1..${maxHops}]->(target:Function {name: $name, file: $file})
        WHERE entry.repoId = $repoId
          AND NOT exists((otherCaller:Function)-[:CALLS]->(entry))
        RETURN entry.name AS name,
               entry.file AS file,
               entry.startLine AS line,
               entry.code AS code,
               length(path) AS hops
        LIMIT 30
      `;

      const records = await runCypher(query, {
        name: targetFunction,
        file: targetFile,
        repoId,
      });

      const entryPoints = records.map((r) => {
        const code = (r.get("code") as string) || "";
        const likelyUserInput = classifySourceType(code) === "USER_INPUT";

        return {
          function: r.get("name") as string,
          file: r.get("file") as string,
          line: Number(r.get("line") ?? 0),
          hopsToTarget: Number(r.get("hops") ?? 0),
          likelyUserInput,
        };
      });

      return { entryPoints };
    } catch (error) {
      log.error({ error, targetFunction, targetFile, repoId }, "Failed to find entry points");
      return { entryPoints: [] };
    }
  },
});
