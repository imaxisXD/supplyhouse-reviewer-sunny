/**
 * FreeMarker Template Language (FTL) parser.
 *
 * FTL isn't a typical programming language, so we use a lightweight
 * regex-based parser that extracts macro blocks when available and falls
 * back to treating the entire template as a single snippet.
 */

import type { CodeParser, ParsedFile, FunctionInfo } from "./base.ts";

function findMacroEnd(lines: string[], startIndex: number): number {
  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i]?.includes("</#macro>")) {
      return i;
    }
  }
  return lines.length - 1;
}

export const ftlParser: CodeParser = {
  language: "ftl",
  fileExtensions: [".ftl"],
  parse(code: string, filePath: string): ParsedFile {
    const lines = code.split(/\r?\n/);
    const functions: FunctionInfo[] = [];

    const macroRegex = /<#macro\s+([A-Za-z0-9_]+)([^>]*)>/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const match = macroRegex.exec(line);
      if (!match) continue;

      const macroName = match[1] ?? "macro";
      const params = (match[2] ?? "").trim();
      const endLine = findMacroEnd(lines, i);

      functions.push({
        name: `macro:${macroName}`,
        params: params.length > 0 ? params : "()",
        returnType: "template",
        body: lines.slice(i, endLine + 1).join("\n"),
        startLine: i + 1,
        endLine: endLine + 1,
        isExported: false,
        isAsync: false,
      });

      i = endLine;
    }

    if (functions.length === 0) {
      functions.push({
        name: filePath.split("/").pop() ?? "template",
        params: "()",
        returnType: "template",
        body: code,
        startLine: 1,
        endLine: lines.length,
        isExported: false,
        isAsync: false,
      });
    }

    return {
      filePath,
      language: "ftl",
      functions,
      classes: [],
      imports: [],
      exports: [],
    };
  },
};
