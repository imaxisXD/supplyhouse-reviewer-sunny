/**
 * Base interfaces for language-agnostic code parsing.
 *
 * Every language-specific parser (TypeScript, Java, Python, Dart, etc.)
 * implements the {@link CodeParser} interface and returns a {@link ParsedFile}
 * with the extracted structural information.
 */

export interface FunctionInfo {
  name: string;
  params: string;
  returnType: string;
  body: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isAsync: boolean;
}

export interface ClassInfo {
  name: string;
  methods: FunctionInfo[];
  properties: { name: string; type: string }[];
  startLine: number;
  endLine: number;
  isExported: boolean;
  extends?: string;
  implements?: string[];
}

export interface ImportInfo {
  source: string;
  specifiers: { name: string; alias?: string; isDefault: boolean }[];
  line: number;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  line: number;
}

export interface ParsedFile {
  filePath: string;
  language: string;
  functions: FunctionInfo[];
  classes: ClassInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
}

export interface CodeParser {
  language: string;
  fileExtensions: string[];
  parse(code: string, filePath: string): ParsedFile;
}
