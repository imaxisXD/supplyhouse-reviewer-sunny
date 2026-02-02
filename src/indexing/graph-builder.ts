/**
 * Graph builder: creates a code knowledge graph in Memgraph.
 *
 * Nodes:
 *   - File   { path, repoId }
 *   - Function { name, file, startLine, endLine, repoId }
 *   - Class  { name, file, repoId }
 *
 * Edges:
 *   - (File)-[:CONTAINS]->(Function)
 *   - (File)-[:CONTAINS]->(Class)
 *   - (Class)-[:HAS_METHOD]->(Function)
 *   - (Function)-[:CALLS]->(Function)
 *   - (File)-[:IMPORTS]->(File)
 *   - (Class)-[:EXTENDS]->(Class)
 *   - (Class)-[:IMPLEMENTS]->(Class)
 */

import { runCypher } from "../db/memgraph.ts";
import type { ParsedFile, FunctionInfo, ClassInfo } from "./parsers/base.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("graph-builder");

/** Maximum number of Cypher statements to batch into a single UNWIND. */
const BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build (or update) the code knowledge graph for the given repository.
 * Uses MERGE for idempotency -- re-running with the same data will not
 * create duplicates.
 */
export async function buildGraph(
  repoId: string,
  files: ParsedFile[],
): Promise<void> {
  log.info({ repoId, fileCount: files.length }, "Building code graph");

  // -- 1. Create repo-level constraint / index (best-effort) --------------
  await safeRunCypher("CREATE INDEX ON :File(path)");
  await safeRunCypher("CREATE INDEX ON :File(repoId)");
  await safeRunCypher("CREATE INDEX ON :Function(name)");
  await safeRunCypher("CREATE INDEX ON :Function(repoId)");
  await safeRunCypher("CREATE INDEX ON :Class(name)");
  await safeRunCypher("CREATE INDEX ON :Class(repoId)");

  // -- 2. File nodes ------------------------------------------------------
  const fileEntries = files.map((f) => ({
    path: f.filePath,
    language: f.language,
    repoId,
  }));
  await batchMerge(
    `UNWIND $batch AS row
     MERGE (f:File {path: row.path, repoId: row.repoId})
     SET f.language = row.language`,
    fileEntries,
  );

  // -- 3. Function nodes + CONTAINS edges ---------------------------------
  const funcEntries: Record<string, unknown>[] = [];
  for (const file of files) {
    for (const fn of file.functions) {
      funcEntries.push({
        name: fn.name,
        file: file.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
        isExported: fn.isExported,
        isAsync: fn.isAsync,
        params: fn.params,
        returnType: fn.returnType,
        repoId,
      });
    }
    // Also add class methods as Function nodes
    for (const cls of file.classes) {
      for (const method of cls.methods) {
        funcEntries.push({
          name: `${cls.name}.${method.name}`,
          file: file.filePath,
          startLine: method.startLine,
          endLine: method.endLine,
          isExported: method.isExported,
          isAsync: method.isAsync,
          params: method.params,
          returnType: method.returnType,
          repoId,
        });
      }
    }
  }

  await batchMerge(
    `UNWIND $batch AS row
     MERGE (fn:Function {name: row.name, file: row.file, repoId: row.repoId})
     SET fn.startLine = row.startLine,
         fn.endLine = row.endLine,
         fn.isExported = row.isExported,
         fn.isAsync = row.isAsync,
         fn.params = row.params,
         fn.returnType = row.returnType
     WITH fn, row
     MATCH (f:File {path: row.file, repoId: row.repoId})
     MERGE (f)-[:CONTAINS]->(fn)`,
    funcEntries,
  );

  // -- 4. Class nodes + CONTAINS edges ------------------------------------
  const classEntries: Record<string, unknown>[] = [];
  for (const file of files) {
    for (const cls of file.classes) {
      classEntries.push({
        name: cls.name,
        file: file.filePath,
        startLine: cls.startLine,
        endLine: cls.endLine,
        isExported: cls.isExported,
        extendsName: cls.extends ?? null,
        implementsList: cls.implements ?? [],
        propertyCount: cls.properties.length,
        methodCount: cls.methods.length,
        repoId,
      });
    }
  }

  await batchMerge(
    `UNWIND $batch AS row
     MERGE (c:Class {name: row.name, file: row.file, repoId: row.repoId})
     SET c.startLine = row.startLine,
         c.endLine = row.endLine,
         c.isExported = row.isExported,
         c.extendsName = row.extendsName,
         c.propertyCount = row.propertyCount,
         c.methodCount = row.methodCount
     WITH c, row
     MATCH (f:File {path: row.file, repoId: row.repoId})
     MERGE (f)-[:CONTAINS]->(c)`,
    classEntries,
  );

  // -- 5. HAS_METHOD edges (Class -> Function) ----------------------------
  const methodEdges: Record<string, unknown>[] = [];
  for (const file of files) {
    for (const cls of file.classes) {
      for (const method of cls.methods) {
        methodEdges.push({
          className: cls.name,
          methodName: `${cls.name}.${method.name}`,
          file: file.filePath,
          repoId,
        });
      }
    }
  }

  await batchMerge(
    `UNWIND $batch AS row
     MATCH (c:Class {name: row.className, file: row.file, repoId: row.repoId})
     MATCH (fn:Function {name: row.methodName, file: row.file, repoId: row.repoId})
     MERGE (c)-[:HAS_METHOD]->(fn)`,
    methodEdges,
  );

  // -- 6. CALLS edges (analysed from function bodies) ---------------------
  const callEdges = extractCallEdges(repoId, files);
  await batchMerge(
    `UNWIND $batch AS row
     MATCH (caller:Function {name: row.callerName, file: row.callerFile, repoId: row.repoId})
     MATCH (callee:Function {name: row.calleeName, repoId: row.repoId})
     WHERE callee.file <> ""
     MERGE (caller)-[r:CALLS]->(callee)
     SET r.line = row.line`,
    callEdges,
  );

  // -- 7. IMPORTS edges (File -> File, resolved loosely) ------------------
  const importEdges = extractImportEdges(repoId, files);
  await batchMerge(
    `UNWIND $batch AS row
     MATCH (src:File {path: row.srcFile, repoId: row.repoId})
     MATCH (tgt:File {path: row.tgtFile, repoId: row.repoId})
     MERGE (src)-[r:IMPORTS]->(tgt)
     SET r.symbols = row.symbols`,
    importEdges,
  );

  // -- 8. EXTENDS / IMPLEMENTS edges (Class -> Class) ---------------------
  const inheritanceEdges = extractInheritanceEdges(repoId, files);
  await batchMerge(
    `UNWIND $batch AS row
     MATCH (child:Class {name: row.childName, file: row.childFile, repoId: row.repoId})
     MATCH (parent:Class {name: row.parentName, repoId: row.repoId})
     MERGE (child)-[:EXTENDS]->(parent)`,
    inheritanceEdges.extends,
  );
  await batchMerge(
    `UNWIND $batch AS row
     MATCH (child:Class {name: row.childName, file: row.childFile, repoId: row.repoId})
     MATCH (iface:Class {name: row.ifaceName, repoId: row.repoId})
     MERGE (child)-[:IMPLEMENTS]->(iface)`,
    inheritanceEdges.implements,
  );

  log.info(
    {
      repoId,
      files: fileEntries.length,
      functions: funcEntries.length,
      classes: classEntries.length,
      calls: callEdges.length,
      imports: importEdges.length,
    },
    "Code graph built",
  );
}

// ---------------------------------------------------------------------------
// Edge extraction helpers
// ---------------------------------------------------------------------------

/**
 * Analyse function bodies for call expressions. This is a best-effort
 * heuristic: it looks for `functionName(` patterns inside every function body
 * and checks whether a Function node with that name exists in the same repo.
 */
function extractCallEdges(
  repoId: string,
  files: ParsedFile[],
): Record<string, unknown>[] {
  // Build a set of known function names for quick lookup
  const knownFunctions = new Set<string>();
  for (const file of files) {
    for (const fn of file.functions) {
      knownFunctions.add(fn.name);
    }
    for (const cls of file.classes) {
      for (const method of cls.methods) {
        knownFunctions.add(`${cls.name}.${method.name}`);
      }
    }
  }

  const edges: Record<string, unknown>[] = [];
  const callRe = /(?<![.\w])(\w+)\s*\(/g;
  const memberCallRe = /(?<![\w])(\w+)\.(\w+)\s*\(/g;

  for (const file of files) {
    const allFunctions = [
      ...file.functions,
      ...file.classes.flatMap((cls) =>
        cls.methods.map((m) => ({
          ...m,
          name: `${cls.name}.${m.name}`,
        })),
      ),
    ];

    for (const fn of allFunctions) {
      const body = fn.body;
      if (!body) continue;

      const currentClass = fn.name.includes(".") ? fn.name.split(".")[0] : null;
      let match: RegExpExecArray | null;
      const seenCallees = new Set<string>();
      callRe.lastIndex = 0;
      memberCallRe.lastIndex = 0;

      while ((match = callRe.exec(body)) !== null) {
        const calleeName = match[1];
        if (!calleeName) continue;
        // Avoid self-references and noise keywords
        if (calleeName === fn.name) continue;
        if (NOISE_IDENTIFIERS.has(calleeName)) continue;
        let resolvedName = calleeName;
        if (!knownFunctions.has(resolvedName) && currentClass) {
          const candidate = `${currentClass}.${calleeName}`;
          if (knownFunctions.has(candidate)) {
            resolvedName = candidate;
          } else {
            continue;
          }
        } else if (!knownFunctions.has(resolvedName)) {
          continue;
        }
        if (seenCallees.has(resolvedName)) continue;

        seenCallees.add(resolvedName);
        const lineOffset = body.slice(0, match.index).split("\n").length - 1;
        const callLine = fn.startLine + Math.max(lineOffset, 0);

        edges.push({
          callerName: fn.name,
          callerFile: file.filePath,
          calleeName: resolvedName,
          repoId,
          line: callLine,
        });
      }

      while ((match = memberCallRe.exec(body)) !== null) {
        const objectName = match[1];
        const methodName = match[2];
        if (!objectName || !methodName) continue;
        if (NOISE_IDENTIFIERS.has(methodName)) continue;

        let resolvedName: string | null = null;
        if ((objectName === "this" || objectName === "super") && currentClass) {
          const candidate = `${currentClass}.${methodName}`;
          if (knownFunctions.has(candidate)) {
            resolvedName = candidate;
          }
        } else {
          const candidate = `${objectName}.${methodName}`;
          if (knownFunctions.has(candidate)) {
            resolvedName = candidate;
          }
        }

        if (!resolvedName || seenCallees.has(resolvedName)) continue;
        seenCallees.add(resolvedName);
        const lineOffset = body.slice(0, match.index).split("\n").length - 1;
        const callLine = fn.startLine + Math.max(lineOffset, 0);

        edges.push({
          callerName: fn.name,
          callerFile: file.filePath,
          calleeName: resolvedName,
          repoId,
          line: callLine,
        });
      }
    }
  }

  return edges;
}

/**
 * Resolve import statements to file paths within the parsed file set.
 * This is a loose match: we check whether any parsed file's path ends with
 * the import source (ignoring extensions).
 */
function extractImportEdges(
  repoId: string,
  files: ParsedFile[],
): Record<string, unknown>[] {
  const pathSet = new Set(files.map((f) => f.filePath));
  const edges: Record<string, unknown>[] = [];

  for (const file of files) {
    for (const imp of file.imports) {
      // Attempt to resolve the import source to one of the parsed files.
      const resolved = resolveImportSource(imp.source, file.filePath, pathSet);
      if (resolved && resolved !== file.filePath) {
        edges.push({
          srcFile: file.filePath,
          tgtFile: resolved,
          repoId,
          symbols: imp.specifiers.map((s) => s.name),
        });
      }
    }
  }

  return edges;
}

/**
 * Extract class inheritance (extends, implements) edges.
 */
function extractInheritanceEdges(
  repoId: string,
  files: ParsedFile[],
): {
  extends: Record<string, unknown>[];
  implements: Record<string, unknown>[];
} {
  const extendsEdges: Record<string, unknown>[] = [];
  const implementsEdges: Record<string, unknown>[] = [];

  for (const file of files) {
    for (const cls of file.classes) {
      if (cls.extends) {
        extendsEdges.push({
          childName: cls.name,
          childFile: file.filePath,
          parentName: cls.extends,
          repoId,
        });
      }
      if (cls.implements) {
        for (const iface of cls.implements) {
          implementsEdges.push({
            childName: cls.name,
            childFile: file.filePath,
            ifaceName: iface,
            repoId,
          });
        }
      }
    }
  }

  return { extends: extendsEdges, implements: implementsEdges };
}

// ---------------------------------------------------------------------------
// Import resolution helper
// ---------------------------------------------------------------------------

/**
 * Tries to match an import source string against the set of known file paths.
 * Handles relative paths (./foo, ../bar) and bare specifiers.
 */
function resolveImportSource(
  source: string,
  currentFile: string,
  pathSet: Set<string>,
): string | null {
  // Skip external / node_modules / absolute URL imports
  if (
    source.startsWith("http") ||
    source.startsWith("node:") ||
    (!source.startsWith(".") && !source.startsWith("/"))
  ) {
    // Could still be a project-internal import; check by suffix
    return findBySuffix(source, pathSet);
  }

  // Resolve relative to current file directory
  const dir = currentFile.replace(/\/[^/]+$/, "");
  const parts = source.split("/");
  let resolved = dir;

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      resolved = resolved.replace(/\/[^/]+$/, "");
    } else {
      resolved = `${resolved}/${part}`;
    }
  }

  // Try common extensions
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".java", ".dart", "/index.ts", "/index.js"];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (pathSet.has(candidate)) return candidate;
  }

  return null;
}

function findBySuffix(source: string, pathSet: Set<string>): string | null {
  const cleaned = source.replace(/^[@/]+/, "");
  for (const p of pathSet) {
    if (p.endsWith(`/${cleaned}`) || p.endsWith(`/${cleaned}.ts`) || p.endsWith(`/${cleaned}.tsx`) || p.endsWith(`/${cleaned}.js`)) {
      return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Batch execution helper
// ---------------------------------------------------------------------------

async function batchMerge(
  cypherTemplate: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      await runCypher(cypherTemplate, { batch });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(
        { batchIndex: i, batchSize: batch.length, error: msg },
        "Batch merge warning (continuing)",
      );
    }
  }
}

async function safeRunCypher(query: string): Promise<void> {
  try {
    await runCypher(query);
  } catch {
    // Index may already exist, etc.
  }
}

// ---------------------------------------------------------------------------
// Noise identifiers to exclude from CALLS extraction
// ---------------------------------------------------------------------------

const NOISE_IDENTIFIERS = new Set([
  // JS/TS keywords / built-ins
  "if", "else", "for", "while", "do", "switch", "case", "return", "throw",
  "try", "catch", "finally", "new", "delete", "typeof", "void", "in",
  "instanceof", "break", "continue", "default", "yield", "await",
  "import", "export", "from", "as", "class", "extends", "super", "this",
  "constructor", "get", "set", "static", "async",
  "console", "log", "warn", "error", "info", "debug",
  "require", "module", "exports",
  "Array", "Object", "String", "Number", "Boolean", "Date", "Math",
  "JSON", "Promise", "Map", "Set", "RegExp", "Error", "Symbol",
  "parseInt", "parseFloat", "isNaN", "isFinite", "undefined", "null",
  "true", "false", "NaN", "Infinity",
  // Python built-ins
  "print", "len", "range", "enumerate", "zip", "map", "filter",
  "type", "isinstance", "issubclass", "str", "int", "float", "bool",
  "list", "dict", "tuple", "set",
  // Java keywords
  "System", "Override", "public", "private", "protected",
]);
