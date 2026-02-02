/**
 * Java parser.
 *
 * Attempts to use tree-sitter-java for accurate AST-based extraction.
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
let JavaLang: any = null;

async function loadTreeSitter(): Promise<boolean> {
  try {
    const treeSitterModule = await import("tree-sitter");
    Parser = treeSitterModule.default ?? treeSitterModule;

    const javaModule = await import("tree-sitter-java");
    JavaLang = javaModule.default ?? javaModule;

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
  parser.setLanguage(JavaLang);
  const tree = parser.parse(code);
  const root = tree.rootNode;

  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];

  function walk(node: any): void {
    switch (node.type) {
      // -- imports --------------------------------------------------------
      case "import_declaration": {
        const pathParts: string[] = [];
        for (const child of node.namedChildren) {
          if (child.type === "scoped_identifier" || child.type === "identifier") {
            pathParts.push(child.text);
          }
        }
        const source = pathParts.join("") || node.text.replace(/^import\s+/, "").replace(/;$/, "").trim();
        const lastDot = source.lastIndexOf(".");
        const name = lastDot >= 0 ? source.slice(lastDot + 1) : source;

        imports.push({
          source,
          specifiers: [{ name, isDefault: false }],
          line: node.startPosition.row + 1,
        });
        break;
      }

      // -- class / interface / enum --------------------------------------
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration": {
        const nameNode = node.childForFieldName("name");
        const bodyNode = node.childForFieldName("body");

        const methods: FunctionInfo[] = [];
        const properties: { name: string; type: string }[] = [];
        let extendsName: string | undefined;
        const implementsList: string[] = [];

        // Superclass / interfaces
        const superclassNode = node.childForFieldName("superclass");
        if (superclassNode) {
          extendsName = superclassNode.text;
        }
        const interfacesNode = node.childForFieldName("interfaces");
        if (interfacesNode) {
          for (const child of interfacesNode.namedChildren) {
            implementsList.push(child.text);
          }
        }

        // Modifiers (public -> exported)
        const modifiers = node.childForFieldName("modifiers") ?? node.children.find((c: any) => c.type === "modifiers");
        const isPublic = modifiers?.text?.includes("public") ?? false;

        if (bodyNode) {
          for (const member of bodyNode.namedChildren) {
            if (member.type === "method_declaration" || member.type === "constructor_declaration") {
              const mNameNode = member.childForFieldName("name");
              const mParamsNode = member.childForFieldName("parameters");
              const mReturnNode = member.childForFieldName("type");
              const mBodyNode = member.childForFieldName("body");
              methods.push({
                name: mNameNode?.text ?? (member.type === "constructor_declaration" ? "<init>" : "<anonymous>"),
                params: mParamsNode?.text ?? "()",
                returnType: mReturnNode?.text ?? "void",
                body: mBodyNode?.text ?? "",
                startLine: member.startPosition.row + 1,
                endLine: member.endPosition.row + 1,
                isExported: false,
                isAsync: false,
              });
            } else if (member.type === "field_declaration") {
              const fTypeNode = member.childForFieldName("type");
              const declarators = member.namedChildren.filter(
                (c: any) => c.type === "variable_declarator",
              );
              for (const decl of declarators) {
                const fNameNode = decl.childForFieldName("name");
                properties.push({
                  name: fNameNode?.text ?? "",
                  type: fTypeNode?.text ?? "",
                });
              }
            }
          }
        }

        classes.push({
          name: nameNode?.text ?? "<anonymous>",
          methods,
          properties,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: isPublic,
          extends: extendsName,
          implements: implementsList.length > 0 ? implementsList : undefined,
        });
        // Don't recurse into the class body again to avoid double-counting
        return;
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
    language: "java",
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
  const importRe = /^import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const match = importRe.exec(line);
    if (match) {
      const source = match[2]!;
      const lastDot = source.lastIndexOf(".");
      const name = lastDot >= 0 ? source.slice(lastDot + 1) : source;
      imports.push({
        source,
        specifiers: [{ name, isDefault: false }],
        line: i + 1,
      });
    }
  }

  // -- Classes (with optional annotations) --------------------------------
  const classRe =
    /^(?:\s*@\w+(?:\([^)]*\))?\s*)*\s*(public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    // Collect annotations preceding the class
    let annotationStart = i;
    while (annotationStart > 0 && lines[annotationStart - 1]!.trim().startsWith("@")) {
      annotationStart--;
    }

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
      const isPublic = classMatch[1] === "public";

      // Extract methods within the class
      const methods: FunctionInfo[] = [];
      const properties: { name: string; type: string }[] = [];

      const methodRe =
        /^\s*(?:@\w+(?:\([^)]*\))?\s*)*\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[\w\s,?]+>\s+)?(\w[\w<>\[\],\s]*?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\s*\{/;
      const fieldRe =
        /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(\w[\w<>\[\],\s]*?)\s+(\w+)\s*[;=]/;

      for (let j = i + 1; j < endLine; j++) {
        const memberLine = lines[j]!.trim();
        const methodMatch = methodRe.exec(memberLine);
        if (methodMatch) {
          const mEndLine = findClosingBrace(lines, j);
          methods.push({
            name: methodMatch[2]!,
            params: `(${methodMatch[3]!})`,
            returnType: methodMatch[1]!,
            body: lines.slice(j, mEndLine + 1).join("\n"),
            startLine: j + 1,
            endLine: mEndLine + 1,
            isExported: false,
            isAsync: false,
          });
          j = mEndLine;
          continue;
        }

        const fieldMatch = fieldRe.exec(memberLine);
        if (fieldMatch && !memberLine.includes("(")) {
          properties.push({
            name: fieldMatch[2]!,
            type: fieldMatch[1]!,
          });
        }
      }

      classes.push({
        name: className!,
        methods,
        properties,
        startLine: annotationStart + 1,
        endLine: endLine + 1,
        isExported: isPublic,
        extends: extendsName,
        implements: implementsList,
      });
    }
  }

  return {
    filePath,
    language: "java",
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

export const javaParser: CodeParser = {
  language: "java",
  fileExtensions: [".java"],

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
