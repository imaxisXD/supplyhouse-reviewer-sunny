import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createLogger } from "../config/logger.ts";
import { getRepoContext } from "./repo-context.ts";

const log = createLogger("tools:search");

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const GrepMatch = z.object({
  file: z.string(),
  line: z.number(),
  content: z.string(),
  match: z.string(),
});

const UsageRecord = z.object({
  file: z.string(),
  line: z.number(),
  context: z.string(),
});

const DefinitionRecord = z.object({
  file: z.string(),
  line: z.number(),
  type: z.enum(["function", "class", "variable", "type"]),
  signature: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RipgrepJsonMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: { match: { text: string }; start: number; end: number }[];
  };
}

/**
 * Runs ripgrep as a subprocess and parses the JSON output.
 */
async function runRipgrep(args: string[]): Promise<RipgrepJsonMatch[]> {
  const proc = Bun.spawn(["rg", "--json", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const exitCode = await proc.exited;

  // Exit code 1 means no matches (not an error)
  if (exitCode !== 0 && exitCode !== 1) {
    log.warn({ stderr, exitCode, args }, "ripgrep returned non-zero exit code");
  }

  const matches: RipgrepJsonMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "match") {
        matches.push(parsed as RipgrepJsonMatch);
      }
    } catch {
      // Skip non-JSON lines (e.g. summary)
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// grep_codebase
// ---------------------------------------------------------------------------

export const grepCodebaseTool = createTool({
  id: "grep_codebase",
  description:
    "Fast text/regex search across the codebase using ripgrep. " +
    "Returns matching file paths, line numbers, content, and the matched portion.",
  inputSchema: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    repoPath: z
      .string()
      .optional()
      .describe("Absolute path to the repository root (defaults to active repo context)"),
    fileGlob: z.string().optional().describe("Optional file glob filter, e.g. '*.ts'"),
    maxResults: z.number().default(100).describe("Maximum number of matches to return"),
  }),
  outputSchema: z.object({
    matches: z.array(GrepMatch),
  }),
  execute: async (input) => {
    const { pattern, fileGlob, maxResults } = input;
    const repoPath = input.repoPath ?? getRepoContext()?.repoPath;
    log.debug({ pattern, repoPath, fileGlob, maxResults }, "Running grep_codebase");

    try {
      if (!repoPath) {
        log.warn({ pattern }, "grep_codebase missing repoPath");
        return { matches: [] };
      }
      const args: string[] = [];

      if (fileGlob) {
        args.push("--glob", fileGlob);
      }

      // Common exclusions
      args.push(
        "--glob",
        "!node_modules",
        "--glob",
        "!.git",
        "--glob",
        "!dist",
        "--glob",
        "!build",
        "--max-count",
        String(maxResults),
        pattern,
        repoPath,
      );

      const rawMatches = await runRipgrep(args);

      const matches = rawMatches.slice(0, maxResults).map((m) => ({
        file: m.data.path.text,
        line: m.data.line_number,
        content: m.data.lines.text.trimEnd(),
        match: m.data.submatches?.[0]?.match?.text ?? "",
      }));

      log.debug({ matchCount: matches.length }, "grep_codebase complete");
      return { matches };
    } catch (error) {
      log.error({ error, pattern, repoPath }, "grep_codebase failed");
      return { matches: [] };
    }
  },
});

// ---------------------------------------------------------------------------
// find_usages
// ---------------------------------------------------------------------------

export const findUsagesTool = createTool({
  id: "find_usages",
  description:
    "Search for all usages of a given identifier in the codebase. " +
    "Optionally excludes the definition site itself.",
  inputSchema: z.object({
    identifier: z.string().describe("Identifier to search for, e.g. 'validateEmail'"),
    repoPath: z
      .string()
      .optional()
      .describe("Absolute path to the repository root (defaults to active repo context)"),
    excludeDefinition: z
      .boolean()
      .default(true)
      .describe("Whether to exclude the definition site"),
  }),
  outputSchema: z.object({
    usages: z.array(UsageRecord),
  }),
  execute: async (input) => {
    const { identifier, excludeDefinition } = input;
    const repoPath = input.repoPath ?? getRepoContext()?.repoPath;
    log.debug({ identifier, repoPath, excludeDefinition }, "Finding usages");

    try {
      if (!repoPath) {
        log.warn({ identifier }, "find_usages missing repoPath");
        return { usages: [] };
      }
      // Use word-boundary matching to avoid partial matches
      const pattern = `\\b${identifier}\\b`;
      const args: string[] = [
        "--glob",
        "!node_modules",
        "--glob",
        "!.git",
        "--glob",
        "!dist",
        "--glob",
        "!build",
        "--glob",
        "!*.min.*",
        pattern,
        repoPath,
      ];

      const rawMatches = await runRipgrep(args);

      let usages = rawMatches.map((m) => ({
        file: m.data.path.text,
        line: m.data.line_number,
        context: m.data.lines.text.trimEnd(),
      }));

      if (excludeDefinition) {
        // Filter out lines that look like definitions
        const definitionPatterns = [
          new RegExp(`^\\s*(export\\s+)?(function|const|let|var|class|interface|type|enum)\\s+${identifier}\\b`),
          new RegExp(`^\\s*(public|private|protected|static)?\\s*(async\\s+)?${identifier}\\s*\\(`),
          new RegExp(`^\\s*def\\s+${identifier}\\b`),
        ];

        usages = usages.filter((u) => {
          return !definitionPatterns.some((p) => p.test(u.context));
        });
      }

      log.debug({ usageCount: usages.length }, "find_usages complete");
      return { usages };
    } catch (error) {
      log.error({ error, identifier, repoPath }, "find_usages failed");
      return { usages: [] };
    }
  },
});

// ---------------------------------------------------------------------------
// find_definitions
// ---------------------------------------------------------------------------

export const findDefinitionsTool = createTool({
  id: "find_definitions",
  description:
    "Search for the definition site of a given identifier. " +
    "Returns the file, line, type of definition, and signature.",
  inputSchema: z.object({
    identifier: z.string().describe("Identifier to find the definition of"),
    repoPath: z
      .string()
      .optional()
      .describe("Absolute path to the repository root (defaults to active repo context)"),
  }),
  outputSchema: z.object({
    definitions: z.array(DefinitionRecord),
  }),
  execute: async (input) => {
    const { identifier } = input;
    const repoPath = input.repoPath ?? getRepoContext()?.repoPath;
    log.debug({ identifier, repoPath }, "Finding definitions");

    try {
      if (!repoPath) {
        log.warn({ identifier }, "find_definitions missing repoPath");
        return { definitions: [] };
      }
      // Search for common definition patterns across languages
      const patterns = [
        // TypeScript / JavaScript
        `(export\\s+)?(function|const|let|var|class|interface|type|enum)\\s+${identifier}\\b`,
        // Java / Kotlin
        `(public|private|protected)\\s+.*\\s+${identifier}\\s*\\(`,
        // Python
        `^\\s*(def|class)\\s+${identifier}\\b`,
        // Dart
        `^\\s*(class|void|Future|Stream|int|double|String|bool)\\s+${identifier}\\b`,
      ];

      const combinedPattern = patterns.join("|");
      const args: string[] = [
        "--glob",
        "!node_modules",
        "--glob",
        "!.git",
        "--glob",
        "!dist",
        "--glob",
        "!build",
        combinedPattern,
        repoPath,
      ];

      const rawMatches = await runRipgrep(args);

      const definitions = rawMatches.map((m) => {
        const content = m.data.lines.text.trimEnd();
        let type: "function" | "class" | "variable" | "type" = "function";

        if (/\b(class)\b/.test(content)) {
          type = "class";
        } else if (/\b(interface|type|enum)\b/.test(content)) {
          type = "type";
        } else if (/\b(const|let|var)\b/.test(content)) {
          type = "variable";
        }

        return {
          file: m.data.path.text,
          line: m.data.line_number,
          type,
          signature: content.trim(),
        };
      });

      log.debug({ definitionCount: definitions.length }, "find_definitions complete");
      return { definitions };
    } catch (error) {
      log.error({ error, identifier, repoPath }, "find_definitions failed");
      return { definitions: [] };
    }
  },
});
