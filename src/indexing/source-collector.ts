/**
 * Shared source file collection, parsing, and snippet extraction utilities.
 *
 * Used by both the indexing worker (full/incremental indexing) and the review
 * workflow (auto-index before review).
 */

import type { ParsedFile, CodeParser } from "./parsers/base.ts";
import type { CodeSnippet } from "./embedding-generator.ts";
import { typescriptParser } from "./parsers/typescript.ts";
import { javaParser } from "./parsers/java.ts";
import { dartParser } from "./parsers/dart.ts";
import { ftlParser } from "./parsers/ftl.ts";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File extensions we know how to parse. */
export const PARSEABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".java",
  ".dart",
  ".ftl",
]);

/** Directories that should always be excluded. */
export const ALWAYS_EXCLUDE = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "__pycache__", ".venv", "venv",
  ".gradle", ".mvn", "target", "build",
  "dist", ".next", ".nuxt", "out",
  ".dart_tool", ".flutter-plugins",
  ".idea", ".vscode",
]);

/** Maximum file size to parse (512 KB). */
export const MAX_FILE_SIZE = 512 * 1024;

// ---------------------------------------------------------------------------
// Parser registry
// ---------------------------------------------------------------------------

const PARSERS: CodeParser[] = [
  typescriptParser,
  javaParser,
  dartParser,
  ftlParser,
];

export function getParserForFile(filePath: string): CodeParser | null {
  const ext = path.extname(filePath).toLowerCase();
  // TypeScript parser also handles .js/.jsx since the regex fallback works.
  if (ext === ".js" || ext === ".jsx") return typescriptParser;
  return PARSERS.find((p) => p.fileExtensions.includes(ext)) ?? null;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/**
 * Recursively walk the directory tree and collect files that match parseable
 * extensions, skipping excluded directories and files exceeding the size limit.
 */
export function collectSourceFiles(
  dir: string,
  excludePatterns: Set<string>,
): string[] {
  const files: string[] = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (excludePatterns.has(entry.name) || ALWAYS_EXCLUDE.has(entry.name)) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!PARSEABLE_EXTENSIONS.has(ext)) continue;

        // Skip large files
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }

        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

// ---------------------------------------------------------------------------
// Snippet extraction (for embeddings)
// ---------------------------------------------------------------------------

/**
 * Convert parsed files into CodeSnippet array suitable for embedding.
 * Each function and class method becomes one snippet.
 */
export function extractSnippets(files: ParsedFile[]): CodeSnippet[] {
  const snippets: CodeSnippet[] = [];

  for (const file of files) {
    // Top-level functions
    for (const fn of file.functions) {
      snippets.push({
        name: fn.name,
        code: fn.body || `function ${fn.name}${fn.params}`,
        file: file.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
    }

    // Class methods
    for (const cls of file.classes) {
      for (const method of cls.methods) {
        snippets.push({
          name: `${cls.name}.${method.name}`,
          code: method.body || `${method.name}${method.params}`,
          file: file.filePath,
          startLine: method.startLine,
          endLine: method.endLine,
        });
      }

      // If the class has no methods but has properties, embed the class itself
      if (cls.methods.length === 0) {
        snippets.push({
          name: cls.name,
          code: `class ${cls.name}${cls.extends ? ` extends ${cls.extends}` : ""}`,
          file: file.filePath,
          startLine: cls.startLine,
          endLine: cls.endLine,
        });
      }
    }
  }

  return snippets;
}
