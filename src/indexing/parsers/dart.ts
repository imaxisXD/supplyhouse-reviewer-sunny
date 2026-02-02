/**
 * Dart / Flutter parser.
 *
 * Attempts to use tree-sitter-dart for accurate AST-based extraction.
 * Falls back to regex-based parsing when the native module is not installed.
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
let DartLang: any = null;

async function loadTreeSitter(): Promise<boolean> {
  try {
    const treeSitterModule = await import("tree-sitter");
    Parser = treeSitterModule.default ?? treeSitterModule;

    // @ts-ignore - tree-sitter grammars are loaded dynamically at runtime
    const dartModule = await import("tree-sitter-dart");
    DartLang = dartModule.default ?? dartModule;

    treeSitterAvailable = true;
    return true;
  } catch {
    treeSitterAvailable = false;
    return false;
  }
}

const _loadPromise = loadTreeSitter();

// ---------------------------------------------------------------------------
// Tree-sitter based extraction
// ---------------------------------------------------------------------------

function parseWithTreeSitter(code: string, filePath: string): ParsedFile {
  const parser = new Parser();
  parser.setLanguage(DartLang);
  const tree = parser.parse(code);
  const root = tree.rootNode;

  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];

  function walk(node: any): void {
    switch (node.type) {
      // -- imports / exports ---------------------------------------------
      case "import_or_export": {
        // tree-sitter-dart may group imports/exports
        const text = node.text;
        if (text.startsWith("import")) {
          const sourceMatch = text.match(/['"]([^'"]+)['"]/);
          if (sourceMatch) {
            const source = sourceMatch[1];
            const asMatch = text.match(/\bas\s+(\w+)/);
            const showMatch = text.match(/\bshow\s+([\w,\s]+)/);
            const specifiers: ImportInfo["specifiers"] = [];

            if (showMatch) {
              const names = showMatch[1]!.split(",").map((s: string) => s.trim()).filter(Boolean);
              for (const name of names) {
                specifiers.push({ name, isDefault: false });
              }
            } else if (asMatch) {
              specifiers.push({ name: "*", alias: asMatch[1], isDefault: false });
            } else {
              const lastSlash = source.lastIndexOf("/");
              const fileName = lastSlash >= 0 ? source.slice(lastSlash + 1) : source;
              specifiers.push({ name: fileName.replace(".dart", ""), isDefault: true });
            }

            imports.push({ source, specifiers, line: node.startPosition.row + 1 });
          }
        } else if (text.startsWith("export")) {
          const sourceMatch = text.match(/['"]([^'"]+)['"]/);
          if (sourceMatch) {
            exports.push({
              name: sourceMatch[1],
              isDefault: false,
              line: node.startPosition.row + 1,
            });
          }
        }
        break;
      }

      // Alternate node types for imports
      case "import_specification": {
        const sourceMatch = node.text.match(/['"]([^'"]+)['"]/);
        if (sourceMatch) {
          const source = sourceMatch[1];
          const asMatch = node.text.match(/\bas\s+(\w+)/);
          const specifiers: ImportInfo["specifiers"] = [];
          if (asMatch) {
            specifiers.push({ name: "*", alias: asMatch[1], isDefault: false });
          } else {
            specifiers.push({ name: source, isDefault: true });
          }
          imports.push({ source, specifiers, line: node.startPosition.row + 1 });
        }
        break;
      }

      // -- functions (top-level) -----------------------------------------
      case "function_signature":
      case "function_definition": {
        const nameNode = node.childForFieldName("name");
        const paramsNode = node.childForFieldName("parameters") ??
          node.namedChildren.find((c: any) => c.type === "formal_parameter_list");
        const returnTypeNode = node.childForFieldName("return_type") ??
          node.namedChildren.find((c: any) => c.type === "type_identifier" || c.type === "void_type");
        const bodyNode = node.childForFieldName("body") ??
          node.namedChildren.find((c: any) => c.type === "function_body");

        functions.push({
          name: nameNode?.text ?? "<anonymous>",
          params: paramsNode?.text ?? "()",
          returnType: returnTypeNode?.text ?? "",
          body: bodyNode?.text ?? "",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: !nameNode?.text?.startsWith("_"),
          isAsync: node.text.includes("async"),
        });
        return; // Don't recurse into function body
      }

      // -- classes --------------------------------------------------------
      case "class_definition": {
        const nameNode = node.childForFieldName("name");
        const bodyNode = node.childForFieldName("body") ??
          node.namedChildren.find((c: any) => c.type === "class_body");

        let extendsName: string | undefined;
        const implementsList: string[] = [];

        // Look for extends / implements / with clauses
        const superclassNode = node.namedChildren.find(
          (c: any) => c.type === "superclass",
        );
        const interfacesNode = node.namedChildren.find(
          (c: any) => c.type === "interfaces",
        );
        const mixinsNode = node.namedChildren.find(
          (c: any) => c.type === "mixins",
        );

        if (superclassNode) {
          extendsName = superclassNode.namedChildren[0]?.text;
        }
        // Also try to parse from the raw text
        if (!extendsName) {
          const extendsMatch = node.text.match(/\bextends\s+(\w+)/);
          if (extendsMatch) extendsName = extendsMatch[1];
        }
        if (interfacesNode) {
          for (const child of interfacesNode.namedChildren) {
            implementsList.push(child.text);
          }
        }
        const implementsMatch = node.text.match(/\bimplements\s+([\w,\s]+)/);
        if (implementsMatch && implementsList.length === 0) {
          const names = implementsMatch[1]!.split(",").map((s: string) => s.trim()).filter(Boolean);
          implementsList.push(...names);
        }
        if (mixinsNode) {
          for (const child of mixinsNode.namedChildren) {
            implementsList.push(child.text);
          }
        }

        const methods: FunctionInfo[] = [];
        const properties: { name: string; type: string }[] = [];

        if (bodyNode) {
          for (const member of bodyNode.namedChildren) {
            if (
              member.type === "method_signature" ||
              member.type === "function_definition" ||
              member.type === "method_definition"
            ) {
              const mNameNode = member.childForFieldName("name");
              const mParamsNode = member.childForFieldName("parameters") ??
                member.namedChildren.find((c: any) => c.type === "formal_parameter_list");
              const mReturnNode = member.childForFieldName("return_type");
              const mBodyNode = member.childForFieldName("body") ??
                member.namedChildren.find((c: any) => c.type === "function_body");

              methods.push({
                name: mNameNode?.text ?? "<anonymous>",
                params: mParamsNode?.text ?? "()",
                returnType: mReturnNode?.text ?? "",
                body: mBodyNode?.text ?? "",
                startLine: member.startPosition.row + 1,
                endLine: member.endPosition.row + 1,
                isExported: false,
                isAsync: member.text.includes("async"),
              });
            } else if (member.type === "declaration" || member.type === "field_declaration") {
              const typeNode = member.namedChildren.find(
                (c: any) => c.type === "type_identifier" || c.type === "built_in_type",
              );
              const nameN = member.namedChildren.find(
                (c: any) => c.type === "identifier",
              );
              properties.push({
                name: nameN?.text ?? "",
                type: typeNode?.text ?? "",
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
          isExported: !nameNode?.text?.startsWith("_"),
          extends: extendsName,
          implements: implementsList.length > 0 ? implementsList : undefined,
        });
        return; // Don't recurse into class body
      }

      default:
        break;
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(root);

  return {
    filePath,
    language: "dart",
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
  const importRe = /^import\s+['"]([^'"]+)['"](?:\s+as\s+(\w+))?(?:\s+show\s+([\w,\s]+))?(?:\s+hide\s+[\w,\s]+)?\s*;/;
  const exportRe = /^export\s+['"]([^'"]+)['"]\s*;/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    const exportMatch = exportRe.exec(line);
    if (exportMatch) {
      exports.push({
        name: exportMatch[1]!,
        isDefault: false,
        line: i + 1,
      });
      continue;
    }

    const importMatch = importRe.exec(line);
    if (importMatch) {
      const source = importMatch[1]!;
      const alias = importMatch[2];
      const showList = importMatch[3];
      const specifiers: ImportInfo["specifiers"] = [];

      if (showList) {
        const names = showList.split(",").map((s: string) => s.trim()).filter(Boolean);
        for (const name of names) {
          specifiers.push({ name, isDefault: false });
        }
      } else if (alias) {
        specifiers.push({ name: "*", alias, isDefault: false });
      } else {
        const lastSlash = source.lastIndexOf("/");
        const fileName = lastSlash >= 0 ? source.slice(lastSlash + 1) : source;
        specifiers.push({ name: fileName.replace(".dart", ""), isDefault: true });
      }

      imports.push({ source, specifiers, line: i + 1 });
    }
  }

  // -- Top-level functions ------------------------------------------------
  // e.g.: Future<void> myFunc(String arg) async { ... }
  // e.g.: void main() { ... }
  const funcRe =
    /^(?:(?:static|final|const|external)\s+)*(?:([\w<>,\s?]+?)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?(?:\{|=>)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Skip lines inside classes (indented), imports, and class declarations
    if (lines[i]!.match(/^\s{2,}/) || line.startsWith("import") || line.startsWith("export")) continue;
    if (line.startsWith("class ") || line.startsWith("abstract ") || line.startsWith("mixin ")) continue;
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;

    const funcMatch = funcRe.exec(line);
    if (funcMatch) {
      const returnType = funcMatch[1]?.trim() ?? "";
      const name = funcMatch[2]!;
      // Skip if this looks like a class constructor or control flow
      if (["if", "for", "while", "switch", "catch", "class", "return", "new"].includes(name)) continue;

      const endLine = findClosingBrace(lines, i);
      functions.push({
        name,
        params: `(${funcMatch[3] ?? ""})`,
        returnType,
        body: lines.slice(i, endLine + 1).join("\n"),
        startLine: i + 1,
        endLine: endLine + 1,
        isExported: !name.startsWith("_"),
        isAsync: line.includes("async"),
      });
    }
  }

  // -- Classes (including Widget subclasses) ------------------------------
  const classRe =
    /^(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+with\s+([\w,\s]+))?(?:\s+implements\s+([\w,\s]+))?\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const classMatch = classRe.exec(line);
    if (classMatch) {
      const endLine = findClosingBrace(lines, i);
      const className = classMatch[1]!;
      const extendsName = classMatch[2];
      const mixins = classMatch[3]
        ? classMatch[3].split(",").map((s: string) => s.trim()).filter(Boolean)
        : [];
      const implementsNames = classMatch[4]
        ? classMatch[4].split(",").map((s: string) => s.trim()).filter(Boolean)
        : [];
      const allImplements = [...mixins, ...implementsNames];

      // Extract methods and properties inside the class
      const methods: FunctionInfo[] = [];
      const properties: { name: string; type: string }[] = [];

      const methodRe =
        /^\s+(?:@\w+\s*(?:\([^)]*\))?\s*)*(?:(?:static|final|const|external)\s+)*(?:([\w<>,\s?]+?)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?(?:\{|=>)/;
      const propRe =
        /^\s+(?:(?:static|final|const|late)\s+)*(?:(\w[\w<>,\s?]*?)\s+)?(\w+)\s*[;=]/;

      for (let j = i + 1; j < endLine; j++) {
        const memberLine = lines[j]!;
        const memberTrimmed = memberLine.trim();
        if (memberTrimmed.startsWith("//") || memberTrimmed.startsWith("/*") || memberTrimmed.startsWith("*")) continue;

        const methodMatch = methodRe.exec(memberLine);
        if (methodMatch) {
          const mName = methodMatch[2]!;
          if (["if", "for", "while", "switch", "catch", "return", "new"].includes(mName)) continue;

          const mEndLine = findClosingBrace(lines, j);
          methods.push({
            name: mName,
            params: `(${methodMatch[3] ?? ""})`,
            returnType: methodMatch[1]?.trim() ?? "",
            body: lines.slice(j, mEndLine + 1).join("\n"),
            startLine: j + 1,
            endLine: mEndLine + 1,
            isExported: false,
            isAsync: memberLine.includes("async"),
          });
          j = mEndLine;
          continue;
        }

        const propMatch = propRe.exec(memberLine);
        if (propMatch && !memberTrimmed.includes("(")) {
          properties.push({
            name: propMatch[2]!,
            type: propMatch[1]?.trim() ?? "",
          });
        }
      }

      classes.push({
        name: className,
        methods,
        properties,
        startLine: i + 1,
        endLine: endLine + 1,
        isExported: !className.startsWith("_"),
        extends: extendsName,
        implements: allImplements.length > 0 ? allImplements : undefined,
      });
    }
  }

  return {
    filePath,
    language: "dart",
    functions,
    classes,
    imports,
    exports,
  };
}

// ---------------------------------------------------------------------------
// Brace-matching utility
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
  return Math.min(startIdx + 100, lines.length - 1);
}

// ---------------------------------------------------------------------------
// Exported parser
// ---------------------------------------------------------------------------

export const dartParser: CodeParser = {
  language: "dart",
  fileExtensions: [".dart"],

  parse(code: string, filePath: string): ParsedFile {
    if (treeSitterAvailable) {
      try {
        return parseWithTreeSitter(code, filePath);
      } catch {
        // Fall through to regex
      }
    }
    return parseWithRegex(code, filePath);
  },
};

/**
 * Ensure tree-sitter loading has completed before first parse.
 */
export async function ensureTreeSitterLoaded(): Promise<boolean> {
  await _loadPromise;
  return treeSitterAvailable;
}
