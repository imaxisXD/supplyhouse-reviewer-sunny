import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { runCypher } from "../db/memgraph.ts";
import { createLogger } from "../config/logger.ts";
import { getRepoContext } from "./repo-context.ts";

const log = createLogger("tools:graph");

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const CallerRecord = z.object({
  functionName: z.string(),
  filePath: z.string(),
  line: z.number(),
  callLine: z.number(),
});

const CalleeRecord = z.object({
  functionName: z.string(),
  filePath: z.string(),
  line: z.number(),
});

const ImporterRecord = z.object({
  filePath: z.string(),
  importedSymbols: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// query_callers
// ---------------------------------------------------------------------------

export const queryCallersTool = createTool({
  id: "query_callers",
  description:
    "Query the code graph for all functions that call a given function. " +
    "Returns caller name, file path, definition line, and call-site line.",
  inputSchema: z.object({
    functionName: z.string().describe("Qualified function name, e.g. 'UserService.getUser'"),
    repoId: z.string().optional().describe("Repository identifier (defaults to active repo context)"),
  }),
  outputSchema: z.object({
    callers: z.array(CallerRecord),
  }),
  execute: async (input) => {
    const { functionName } = input;
    const repoId = input.repoId ?? getRepoContext()?.repoId;
    log.debug({ functionName, repoId }, "Querying callers");

    try {
      if (!repoId) {
        log.warn({ functionName }, "query_callers missing repoId");
        return { callers: [] };
      }
      const records = await runCypher(
        `MATCH (caller:Function)-[r:CALLS]->(target:Function {name: $name})
         WHERE caller.repoId = $repoId
         RETURN caller.name AS functionName,
                caller.file AS filePath,
                caller.startLine AS line,
                r.line AS callLine`,
        { name: functionName, repoId },
      );

      const callers = records.map((r) => ({
        functionName: r.get("functionName") as string,
        filePath: r.get("filePath") as string,
        line: Number(r.get("line") ?? 0),
        callLine: Number(r.get("callLine") ?? 0),
      }));

      return { callers };
    } catch (error) {
      log.error({ error, functionName, repoId }, "Failed to query callers");
      return { callers: [] };
    }
  },
});

// ---------------------------------------------------------------------------
// query_callees
// ---------------------------------------------------------------------------

export const queryCalleesTool = createTool({
  id: "query_callees",
  description:
    "Query the code graph for all functions that a given function calls. " +
    "Returns callee name, file path, and definition line.",
  inputSchema: z.object({
    functionName: z.string().describe("Qualified function name"),
    repoId: z.string().optional().describe("Repository identifier (defaults to active repo context)"),
  }),
  outputSchema: z.object({
    callees: z.array(CalleeRecord),
  }),
  execute: async (input) => {
    const { functionName } = input;
    const repoId = input.repoId ?? getRepoContext()?.repoId;
    log.debug({ functionName, repoId }, "Querying callees");

    try {
      if (!repoId) {
        log.warn({ functionName }, "query_callees missing repoId");
        return { callees: [] };
      }
      const records = await runCypher(
        `MATCH (source:Function {name: $name})-[:CALLS]->(target:Function)
         WHERE source.repoId = $repoId
         RETURN target.name AS functionName,
                target.file AS filePath,
                target.startLine AS line`,
        { name: functionName, repoId },
      );

      const callees = records.map((r) => ({
        functionName: r.get("functionName") as string,
        filePath: r.get("filePath") as string,
        line: Number(r.get("line") ?? 0),
      }));

      return { callees };
    } catch (error) {
      log.error({ error, functionName, repoId }, "Failed to query callees");
      return { callees: [] };
    }
  },
});

// ---------------------------------------------------------------------------
// query_imports
// ---------------------------------------------------------------------------

export const queryImportsTool = createTool({
  id: "query_imports",
  description:
    "Query the code graph for all files that import a given file. " +
    "Returns importer file path and the symbols imported.",
  inputSchema: z.object({
    filePath: z.string().describe("Path of the file being imported"),
    repoId: z.string().optional().describe("Repository identifier (defaults to active repo context)"),
  }),
  outputSchema: z.object({
    importers: z.array(ImporterRecord),
  }),
  execute: async (input) => {
    const { filePath } = input;
    const repoId = input.repoId ?? getRepoContext()?.repoId;
    log.debug({ filePath, repoId }, "Querying importers");

    try {
      if (!repoId) {
        log.warn({ filePath }, "query_imports missing repoId");
        return { importers: [] };
      }
      const records = await runCypher(
        `MATCH (importer:File)-[r:IMPORTS]->(target:File {path: $path})
         WHERE importer.repoId = $repoId
         RETURN importer.path AS filePath,
                r.symbols AS importedSymbols`,
        { path: filePath, repoId },
      );

      const importers = records.map((r) => {
        const symbols = r.get("importedSymbols");
        return {
          filePath: r.get("filePath") as string,
          importedSymbols: Array.isArray(symbols) ? (symbols as string[]) : [],
        };
      });

      return { importers };
    } catch (error) {
      log.error({ error, filePath, repoId }, "Failed to query importers");
      return { importers: [] };
    }
  },
});

// ---------------------------------------------------------------------------
// query_impact
// ---------------------------------------------------------------------------

export const queryImpactTool = createTool({
  id: "query_impact",
  description:
    "Multi-hop query to determine the transitive impact of changing a function or file. " +
    "Returns direct callers, indirect callers (up to 3 hops), importing files, and affected paths.",
  inputSchema: z.object({
    filePath: z.string().describe("Path of the changed file"),
    functionName: z.string().optional().describe("Specific function name (optional)"),
    repoId: z.string().optional().describe("Repository identifier (defaults to active repo context)"),
  }),
  outputSchema: z.object({
    impact: z.object({
      directCallers: z.number(),
      indirectCallers: z.number(),
      importingFiles: z.number(),
      affectedPaths: z.array(z.string()),
    }),
  }),
  execute: async (input) => {
    const { filePath, functionName } = input;
    const repoId = input.repoId ?? getRepoContext()?.repoId;
    log.debug({ filePath, functionName, repoId }, "Querying impact");

    const affectedPaths = new Set<string>();
    let directCallers = 0;
    let indirectCallers = 0;
    let importingFiles = 0;

    try {
      if (!repoId) {
        log.warn({ filePath, functionName }, "query_impact missing repoId");
        return {
          impact: {
            directCallers: 0,
            indirectCallers: 0,
            importingFiles: 0,
            affectedPaths: [],
          },
        };
      }
      // Direct callers (1 hop)
      if (functionName) {
        const directRecords = await runCypher(
          `MATCH (caller:Function)-[:CALLS]->(target:Function {name: $name})
           WHERE caller.repoId = $repoId
           RETURN caller.file AS filePath`,
          { name: functionName, repoId },
        );
        directCallers = directRecords.length;
        for (const r of directRecords) {
          affectedPaths.add(r.get("filePath") as string);
        }

        // Indirect callers (2-3 hops)
        const indirectRecords = await runCypher(
          `MATCH (caller:Function)-[:CALLS*2..3]->(target:Function {name: $name})
           WHERE caller.repoId = $repoId
           RETURN DISTINCT caller.file AS filePath`,
          { name: functionName, repoId },
        );
        indirectCallers = indirectRecords.length;
        for (const r of indirectRecords) {
          affectedPaths.add(r.get("filePath") as string);
        }
      }

      // Files that import the changed file
      const importRecords = await runCypher(
        `MATCH (importer:File)-[:IMPORTS]->(target:File {path: $path})
         WHERE importer.repoId = $repoId
         RETURN importer.path AS filePath`,
        { path: filePath, repoId },
      );
      importingFiles = importRecords.length;
      for (const r of importRecords) {
        affectedPaths.add(r.get("filePath") as string);
      }

      return {
        impact: {
          directCallers,
          indirectCallers,
          importingFiles,
          affectedPaths: Array.from(affectedPaths),
        },
      };
    } catch (error) {
      log.error({ error, filePath, functionName, repoId }, "Failed to query impact");
      return {
        impact: {
          directCallers: 0,
          indirectCallers: 0,
          importingFiles: 0,
          affectedPaths: [],
        },
      };
    }
  },
});
