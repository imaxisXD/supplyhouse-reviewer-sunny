/**
 * TypeScript / TSX parser.
 *
 * Attempts to use tree-sitter for accurate AST-based extraction.
 * Falls back to regex-based parsing when the native tree-sitter modules
 * are not installed.
 */

import type {
  CodeParser,
  ParsedFile,
  FunctionInfo,
  ClassInfo,
  ImportInfo,
  ExportInfo,
} from "./base.ts";

// ---------------------------------------------------------------------------
// Tree-sitter dynamic loader
// ---------------------------------------------------------------------------

let treeSitterAvailable = false;
let Parser: any = null;
let TypeScriptLang: any = null;
let TSXLang: any = null;

async function loadTreeSitter(): Promise<boolean> {
  try {
    const treeSitterModule = await import("tree-sitter");
    Parser = treeSitterModule.default ?? treeSitterModule;

    const tsModule = await import("tree-sitter-typescript");
    TypeScriptLang = tsModule.default?.typescript ?? tsModule.typescript;
    TSXLang = tsModule.default?.tsx ?? tsModule.tsx;

    treeSitterAvailable = true;
    return true;
  } catch {
    treeSitterAvailable = false;
    return false;
  }
}

// Kick off the loading attempt on import (non-blocking).
const _loadPromise = loadTreeSitter();

// ---------------------------------------------------------------------------
// Tree-sitter based extraction
// ---------------------------------------------------------------------------

function parseWithTreeSitter(
  code: string,
  filePath: string,
  isTsx: boolean,
): ParsedFile {
  const parser = new Parser();
  parser.setLanguage(isTsx ? TSXLang : TypeScriptLang);
  const tree = parser.parse(code);
  const root = tree.rootNode;

  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];

  // Recursive walk ---------------------------------------------------------
  function walk(node: any, exportContext = false): void {
    switch (node.type) {
      // -- functions / arrow functions in variable declarations -----------
      case "function_declaration":
      case "generator_function_declaration": {
        const nameNode = node.childForFieldName("name");
        const paramsNode = node.childForFieldName("parameters");
        const returnNode = node.childForFieldName("return_type");
        const bodyNode = node.childForFieldName("body");
        functions.push({
          name: nameNode?.text ?? "<anonymous>",
          params: paramsNode?.text ?? "()",
          returnType: returnNode?.text?.replace(/^:\s*/, "") ?? "",
          body: bodyNode?.text ?? "",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: exportContext || isExportedNode(node),
          isAsync: code.slice(node.startIndex, node.startIndex + 30).includes("async"),
        });
        break;
      }

      case "lexical_declaration":
      case "variable_declaration": {
        // e.g. const foo = (...) => { ... }
        for (const declarator of node.namedChildren) {
          if (declarator.type !== "variable_declarator") continue;
          const nameNode = declarator.childForFieldName("name");
          const valueNode = declarator.childForFieldName("value");
          if (!valueNode) continue;

          if (
            valueNode.type === "arrow_function" ||
            valueNode.type === "function_expression" ||
            valueNode.type === "function"
          ) {
            const paramsNode = valueNode.childForFieldName("parameters");
            const returnNode = valueNode.childForFieldName("return_type");
            const bodyNode = valueNode.childForFieldName("body");
            functions.push({
              name: nameNode?.text ?? "<anonymous>",
              params: paramsNode?.text ?? "()",
              returnType: returnNode?.text?.replace(/^:\s*/, "") ?? "",
              body: bodyNode?.text ?? "",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              isExported: exportContext || isExportedNode(node),
              isAsync:
                code
                  .slice(valueNode.startIndex, valueNode.startIndex + 30)
                  .includes("async"),
            });
          }
        }
        break;
      }

      // -- classes --------------------------------------------------------
      case "class_declaration": {
        const nameNode = node.childForFieldName("name");
        const bodyNode = node.childForFieldName("body");
        const heritageNode = node.children.find(
          (c: any) => c.type === "class_heritage",
        );

        const methods: FunctionInfo[] = [];
        const properties: { name: string; type: string }[] = [];
        let extendsName: string | undefined;
        const implementsList: string[] = [];

        if (heritageNode) {
          const extendsClause = heritageNode.children.find(
            (c: any) => c.type === "extends_clause",
          );
          const implementsClause = heritageNode.children.find(
            (c: any) => c.type === "implements_clause",
          );
          if (extendsClause) {
            const typeNode = extendsClause.namedChildren[0];
            extendsName = typeNode?.text;
          }
          if (implementsClause) {
            for (const child of implementsClause.namedChildren) {
              implementsList.push(child.text);
            }
          }
        }

        if (bodyNode) {
          for (const member of bodyNode.namedChildren) {
            if (
              member.type === "method_definition" ||
              member.type === "method_signature"
            ) {
              const mNameNode = member.childForFieldName("name");
              const mParamsNode = member.childForFieldName("parameters");
              const mReturnNode = member.childForFieldName("return_type");
              const mBodyNode = member.childForFieldName("body");
              methods.push({
                name: mNameNode?.text ?? "<anonymous>",
                params: mParamsNode?.text ?? "()",
                returnType: mReturnNode?.text?.replace(/^:\s*/, "") ?? "",
                body: mBodyNode?.text ?? "",
                startLine: member.startPosition.row + 1,
                endLine: member.endPosition.row + 1,
                isExported: false,
                isAsync: code
                  .slice(member.startIndex, member.startIndex + 30)
                  .includes("async"),
              });
            } else if (
              member.type === "public_field_definition" ||
              member.type === "property_declaration" ||
              member.type === "property_signature"
            ) {
              const pNameNode = member.childForFieldName("name");
              const pTypeNode = member.childForFieldName("type");
              properties.push({
                name: pNameNode?.text ?? "",
                type: pTypeNode?.text?.replace(/^:\s*/, "") ?? "",
              });
            }
          }
        }

        classes.push({
          name: nameNode?.text ?? "<anonymous>",
          methods,
          properties,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: exportContext || isExportedNode(node),
          extends: extendsName,
          implements: implementsList.length > 0 ? implementsList : undefined,
        });
        break;
      }

      // -- imports --------------------------------------------------------
      case "import_statement": {
        const sourceNode = node.childForFieldName("source");
        const source = sourceNode?.text?.replace(/['"]/g, "") ?? "";
        const specifiers: ImportInfo["specifiers"] = [];

        for (const child of node.namedChildren) {
          if (child.type === "import_clause") {
            for (const inner of child.namedChildren) {
              if (inner.type === "identifier") {
                specifiers.push({
                  name: inner.text,
                  isDefault: true,
                });
              } else if (inner.type === "named_imports") {
                for (const spec of inner.namedChildren) {
                  if (spec.type === "import_specifier") {
                    const specName = spec.childForFieldName("name");
                    const specAlias = spec.childForFieldName("alias");
                    specifiers.push({
                      name: specName?.text ?? spec.text,
                      alias: specAlias?.text,
                      isDefault: false,
                    });
                  }
                }
              } else if (inner.type === "namespace_import") {
                const aliasNode = inner.childForFieldName("name") ?? inner.namedChildren[0];
                specifiers.push({
                  name: "*",
                  alias: aliasNode?.text,
                  isDefault: false,
                });
              }
            }
          }
        }

        imports.push({
          source,
          specifiers,
          line: node.startPosition.row + 1,
        });
        break;
      }

      // -- exports --------------------------------------------------------
      case "export_statement": {
        const isDefault = node.children.some(
          (c: any) => c.type === "default",
        );

        // Check for re-exports or named exports
        const declaration = node.childForFieldName("declaration");
        if (declaration) {
          // export function foo / export class Foo / export const bar = ...
          walk(declaration, true);
          const declName =
            declaration.childForFieldName("name")?.text ?? "default";
          exports.push({
            name: declName,
            isDefault,
            line: node.startPosition.row + 1,
          });
        } else {
          // export { a, b } or export default expr
          const exportClause = node.children.find(
            (c: any) => c.type === "export_clause",
          );
          if (exportClause) {
            for (const spec of exportClause.namedChildren) {
              if (spec.type === "export_specifier") {
                const specName = spec.childForFieldName("name");
                exports.push({
                  name: specName?.text ?? spec.text,
                  isDefault: false,
                  line: node.startPosition.row + 1,
                });
              }
            }
          } else {
            exports.push({
              name: "default",
              isDefault: true,
              line: node.startPosition.row + 1,
            });
          }
        }
        return; // children already walked via `declaration`
      }

      default:
        break;
    }

    // Recurse into children (except for nodes already handled above)
    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  function isExportedNode(node: any): boolean {
    const parent = node.parent;
    return parent?.type === "export_statement";
  }

  walk(root);

  return {
    filePath,
    language: isTsx ? "tsx" : "typescript",
    functions,
    classes,
    imports,
    exports,
  };
}

// ---------------------------------------------------------------------------
// Regex-based fallback
// ---------------------------------------------------------------------------

function parseWithRegex(code: string, filePath: string): ParsedFile {
  const lines = code.split("\n");
  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];

  // -- Imports ------------------------------------------------------------
  const importRe =
    /^import\s+(?:(?:type\s+)?(?:(\w+)(?:\s*,\s*)?)?(?:\{([^}]*)\})?\s+from\s+)?['"]([^'"]+)['"]/;
  const importStarRe = /^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // Namespace imports
    const starMatch = importStarRe.exec(line);
    if (starMatch) {
      imports.push({
        source: starMatch[2]!,
        specifiers: [{ name: "*", alias: starMatch[1]!, isDefault: false }],
        line: i + 1,
      });
      continue;
    }

    const importMatch = importRe.exec(line);
    if (importMatch) {
      const defaultName = importMatch[1];
      const namedRaw = importMatch[2];
      const source = importMatch[3];
      const specifiers: ImportInfo["specifiers"] = [];

      if (defaultName) {
        specifiers.push({ name: defaultName, isDefault: true });
      }
      if (namedRaw) {
        const named = namedRaw.split(",").map((s) => s.trim()).filter(Boolean);
        for (const n of named) {
          const parts = n.split(/\s+as\s+/);
          specifiers.push({
            name: parts[0]!.replace(/^type\s+/, "").trim(),
            alias: parts[1]?.trim(),
            isDefault: false,
          });
        }
      }

      imports.push({ source: source!, specifiers, line: i + 1 });
    }
  }

  // -- Exports (simple) ---------------------------------------------------
  const exportNamedRe = /^export\s+(?:const|let|var|function|class|type|interface|enum|async\s+function)\s+(\w+)/;
  const exportDefaultRe = /^export\s+default\s+/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const namedMatch = exportNamedRe.exec(line);
    if (namedMatch) {
      exports.push({ name: namedMatch[1]!, isDefault: false, line: i + 1 });
    } else if (exportDefaultRe.test(line)) {
      // Try to extract a name after "export default"
      const afterDefault = line.replace(exportDefaultRe, "").trim();
      const nameMatch = /^(?:class|function)\s+(\w+)/.exec(afterDefault);
      exports.push({
        name: nameMatch?.[1] ?? "default",
        isDefault: true,
        line: i + 1,
      });
    }
  }

  // -- Functions ----------------------------------------------------------
  // Matches: [export] [async] function name(params)[: returnType] {
  const funcDeclRe =
    /^(export\s+)?(?:default\s+)?(async\s+)?function\s+(\w+)\s*(\([^)]*\))\s*(?::\s*([^\s{]+))?\s*\{/;
  // Matches: [export] const name = [async] (params)[: returnType] => {
  const arrowRe =
    /^(export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*\S+\s*)?=\s*(async\s+)?(?:\([^)]*\)|[^=]*)(?::\s*([^\s=]+))?\s*=>\s*[{\(]/;
  // Simpler arrow for single-expression arrows
  const arrowSimpleRe =
    /^(export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(([^)]*)\)\s*(?::\s*([^\s=]+))?\s*=>/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    const funcMatch = funcDeclRe.exec(line);
    if (funcMatch) {
      const endLine = findClosingBrace(lines, i);
      functions.push({
        name: funcMatch[3]!,
        params: funcMatch[4]!,
        returnType: funcMatch[5] ?? "",
        body: lines.slice(i, endLine + 1).join("\n"),
        startLine: i + 1,
        endLine: endLine + 1,
        isExported: !!funcMatch[1],
        isAsync: !!funcMatch[2],
      });
      continue;
    }

    const arrowMatch = arrowRe.exec(line) ?? arrowSimpleRe.exec(line);
    if (arrowMatch) {
      const endLine = findClosingBrace(lines, i);
      functions.push({
        name: arrowMatch[2]!,
        params: arrowMatch[4] ? `(${arrowMatch[4]})` : "()",
        returnType: arrowMatch[5] ?? "",
        body: lines.slice(i, endLine + 1).join("\n"),
        startLine: i + 1,
        endLine: endLine + 1,
        isExported: !!arrowMatch[1],
        isAsync: !!arrowMatch[3],
      });
    }
  }

  // -- Classes ------------------------------------------------------------
  const classRe =
    /^(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const classMatch = classRe.exec(line);
    if (classMatch) {
      const endLine = findClosingBrace(lines, i);
      const className = classMatch[2]!;
      const extendsName = classMatch[3];
      const implementsRaw = classMatch[4];
      const implementsList = implementsRaw
        ? implementsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;

      // Extract methods inside the class body
      const methods: FunctionInfo[] = [];
      const properties: { name: string; type: string }[] = [];
      const methodRe =
        /^\s*(public|private|protected|static|async|readonly|\s)*\s*(\w+)\s*(\([^)]*\))\s*(?::\s*([^\s{]+))?\s*\{/;
      const propRe =
        /^\s*(public|private|protected|static|readonly|\s)*\s*(\w+)\s*(?:\?\s*)?:\s*([^;=]+)/;

      for (let j = i + 1; j <= endLine; j++) {
        const memberLine = lines[j]!.trim();
        const methodMatch = methodRe.exec(memberLine);
        if (methodMatch && methodMatch[2] !== "constructor") {
          const mEndLine = findClosingBrace(lines, j);
          if (methodMatch) {
            methods.push({
              name: methodMatch[2]!,
              params: methodMatch[3]!,
              returnType: methodMatch[4] ?? "",
              body: lines.slice(j, mEndLine + 1).join("\n"),
              startLine: j + 1,
              endLine: mEndLine + 1,
              isExported: false,
              isAsync: memberLine.includes("async"),
            });
          }
          j = mEndLine;
          continue;
        }

        const propMatch = propRe.exec(memberLine);
        if (propMatch && !memberLine.includes("(")) {
          properties.push({
            name: propMatch[2]!,
            type: propMatch[3]!.trim().replace(/;$/, ""),
          });
        }
      }

      classes.push({
        name: className!,
        methods,
        properties,
        startLine: i + 1,
        endLine: endLine + 1,
        isExported: !!classMatch[1],
        extends: extendsName,
        implements: implementsList,
      });
    }
  }

  const isTsx = filePath.endsWith(".tsx");
  return {
    filePath,
    language: isTsx ? "tsx" : "typescript",
    functions,
    classes,
    imports,
    exports,
  };
}

// ---------------------------------------------------------------------------
// Brace-matching utility for regex fallback
// ---------------------------------------------------------------------------

function findClosingBrace(lines: string[], startIdx: number): number {
  let depth = 0;
  let found = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") {
        depth++;
        found = true;
      } else if (ch === "}") {
        depth--;
        if (found && depth === 0) return i;
      }
    }
  }
  return Math.min(startIdx + 50, lines.length - 1);
}

// ---------------------------------------------------------------------------
// Exported parser
// ---------------------------------------------------------------------------

export const typescriptParser: CodeParser = {
  language: "typescript",
  fileExtensions: [".ts", ".tsx"],

  parse(code: string, filePath: string): ParsedFile {
    if (treeSitterAvailable) {
      try {
        const isTsx = filePath.endsWith(".tsx");
        return parseWithTreeSitter(code, filePath, isTsx);
      } catch {
        // Fall through to regex
      }
    }
    return parseWithRegex(code, filePath);
  },
};

/**
 * Ensure tree-sitter loading has completed before first parse.
 * Callers can await this if they want the tree-sitter path to be tried.
 */
export async function ensureTreeSitterLoaded(): Promise<boolean> {
  await _loadPromise;
  return treeSitterAvailable;
}
