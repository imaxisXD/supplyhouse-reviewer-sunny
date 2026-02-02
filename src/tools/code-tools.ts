import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createLogger } from "../config/logger.ts";
import { getRepoContext } from "./repo-context.ts";
import { isAbsolute, join, resolve } from "path";

const log = createLogger("tools:code");

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export const readFileTool = createTool({
  id: "read_file",
  description:
    "Read the full content of a file and return it as a string. " +
    "Useful for getting complete context around code changes.",
  inputSchema: z.object({
    filePath: z.string().describe("Absolute path to the file to read"),
  }),
  outputSchema: z.object({
    content: z.string(),
    lineCount: z.number(),
    exists: z.boolean(),
  }),
  execute: async (input) => {
    const repoPath = getRepoContext()?.repoPath;
    const filePath = repoPath
      ? resolve(repoPath, input.filePath.replace(/^\/+/, ""))
      : input.filePath;

    // Prevent path traversal outside the repo
    if (repoPath && !filePath.startsWith(resolve(repoPath) + "/") && filePath !== resolve(repoPath)) {
      log.warn({ filePath, repoPath }, "Path traversal blocked");
      return { content: "", lineCount: 0, exists: false };
    }

    log.debug({ filePath }, "Reading file");

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();

      if (!exists) {
        log.warn({ filePath }, "File does not exist");
        return { content: "", lineCount: 0, exists: false };
      }

      const content = await file.text();
      const lineCount = content.split("\n").length;

      log.debug({ filePath, lineCount }, "File read successfully");
      return { content, lineCount, exists: true };
    } catch (error) {
      log.error({ error, filePath }, "Failed to read file");
      return { content: "", lineCount: 0, exists: false };
    }
  },
});

// ---------------------------------------------------------------------------
// expand_context
// ---------------------------------------------------------------------------

export const expandContextTool = createTool({
  id: "expand_context",
  description:
    "Read surrounding lines around a specific line number in a file. " +
    "Returns the expanded context with line numbers for understanding " +
    "the full function or block of code around a change.",
  inputSchema: z.object({
    filePath: z.string().describe("Absolute path to the file"),
    lineNumber: z.number().describe("Center line number (1-based)"),
    linesBefore: z.number().default(30).describe("Number of lines to include before the target line"),
    linesAfter: z.number().default(30).describe("Number of lines to include after the target line"),
  }),
  outputSchema: z.object({
    content: z.string().describe("The expanded code content"),
    startLine: z.number().describe("First line number in the returned content (1-based)"),
    endLine: z.number().describe("Last line number in the returned content (1-based)"),
    totalLines: z.number().describe("Total number of lines in the file"),
    exists: z.boolean(),
  }),
  execute: async (input) => {
    const repoPath = getRepoContext()?.repoPath;
    const filePath = repoPath
      ? resolve(repoPath, input.filePath.replace(/^\/+/, ""))
      : input.filePath;

    // Prevent path traversal outside the repo
    if (repoPath && !filePath.startsWith(resolve(repoPath) + "/") && filePath !== resolve(repoPath)) {
      log.warn({ filePath, repoPath }, "Path traversal blocked");
      return { content: "", startLine: 0, endLine: 0, totalLines: 0, exists: false };
    }

    const { lineNumber, linesBefore, linesAfter } = input;
    log.debug({ filePath, lineNumber, linesBefore, linesAfter }, "Expanding context");

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();

      if (!exists) {
        log.warn({ filePath }, "File does not exist");
        return { content: "", startLine: 0, endLine: 0, totalLines: 0, exists: false };
      }

      const fullContent = await file.text();
      const allLines = fullContent.split("\n");
      const totalLines = allLines.length;

      // Convert to 0-based index
      const centerIndex = lineNumber - 1;
      const startIndex = Math.max(0, centerIndex - linesBefore);
      const endIndex = Math.min(totalLines - 1, centerIndex + linesAfter);

      // Build the content with line numbers
      const selectedLines = allLines.slice(startIndex, endIndex + 1);
      const numberedLines = selectedLines.map((line, i) => {
        const num = startIndex + i + 1;
        return `${num}: ${line}`;
      });

      const content = numberedLines.join("\n");
      const startLine = startIndex + 1;
      const endLine = endIndex + 1;

      log.debug({ filePath, startLine, endLine, totalLines }, "Context expanded");
      return { content, startLine, endLine, totalLines, exists: true };
    } catch (error) {
      log.error({ error, filePath }, "Failed to expand context");
      return { content: "", startLine: 0, endLine: 0, totalLines: 0, exists: false };
    }
  },
});
