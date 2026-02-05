/**
 * Data Flow Tracing Tools
 *
 * Tools for tracing where data originates and flows to across multiple languages.
 * Supports: TypeScript, JavaScript, Java, Spring Boot, React, Flutter, FreeMarker, etc.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createLogger } from "../config/logger.ts";
import { getRepoContext } from "./repo-context.ts";
import { resolve, dirname, basename } from "path";
import * as fs from "fs";
import type {
  DataSourceType,
  LanguageFramework,
  DataFlowTrace,
  DataFlowStep,
  DataFlowSink,
  SinkType,
} from "../types/data-flow.ts";
import {
  USER_INPUT_PATTERNS,
  DATABASE_PATTERNS,
  SINK_PATTERNS,
  detectLanguageFramework,
  isUserControlled,
} from "../types/data-flow.ts";

const log = createLogger("tools:data-flow");

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Read file content safely
 */
async function readFileContent(filePath: string, repoPath?: string): Promise<string | null> {
  let fullPath = filePath;
  if (repoPath && !filePath.startsWith(repoPath)) {
    fullPath = resolve(repoPath, filePath.replace(/^\/+/, ""));
  }

  try {
    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, "utf-8");
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * Find related files (e.g., .bsh file for .ftl template)
 */
function findRelatedFiles(filePath: string, repoPath: string): string[] {
  const related: string[] = [];
  const dir = dirname(filePath);
  const baseName = basename(filePath).replace(/\.[^.]+$/, "");

  // For FreeMarker templates, look for corresponding .bsh files
  if (filePath.endsWith(".ftl")) {
    // Common OFBiz pattern: templates use actions in WEB-INF/actions/
    const actionPaths = [
      resolve(repoPath, dir, "../WEB-INF/actions", `${baseName}.bsh`),
      resolve(repoPath, dir, "WEB-INF/actions", `${baseName}.bsh`),
      resolve(repoPath, dir, `${baseName}.bsh`),
    ];

    for (const actionPath of actionPaths) {
      if (fs.existsSync(actionPath)) {
        related.push(actionPath);
      }
    }

    // Also search for any .bsh file that might set context for this template
    try {
      const actionsDir = resolve(repoPath, dir, "../WEB-INF/actions");
      if (fs.existsSync(actionsDir)) {
        const files = fs.readdirSync(actionsDir);
        for (const file of files) {
          if (file.endsWith(".bsh")) {
            related.push(resolve(actionsDir, file));
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  // For Java controllers, look for corresponding service files
  if (filePath.endsWith("Controller.java")) {
    const serviceName = baseName.replace("Controller", "Service");
    // Search in common locations
    const searchDirs = [dir, resolve(dir, "../service"), resolve(dir, "../services")];
    for (const searchDir of searchDirs) {
      const servicePath = resolve(searchDir, `${serviceName}.java`);
      if (fs.existsSync(servicePath)) {
        related.push(servicePath);
      }
    }
  }

  return related;
}

/**
 * Classify data source based on expression and language
 */
function classifyDataSource(
  expression: string,
  language: LanguageFramework
): DataSourceType {
  // Check user input patterns
  const userPatterns = USER_INPUT_PATTERNS[language] ?? [];
  for (const pattern of userPatterns) {
    if (pattern.test(expression)) {
      return "USER_INPUT";
    }
  }

  // Check database patterns
  const dbPatterns = DATABASE_PATTERNS[language] ?? [];
  for (const pattern of dbPatterns) {
    if (pattern.test(expression)) {
      return "DATABASE";
    }
  }

  // Additional language-specific checks
  if (language === "freemarker" || language === "beanshell") {
    if (/context\.put|request\.setAttribute/i.test(expression)) {
      return "SERVER_GENERATED";
    }
    if (/UtilProperties|\.properties/i.test(expression)) {
      return "CONFIG";
    }
    if (/session\.|getSession/i.test(expression)) {
      return "SESSION";
    }
  }

  if (language === "java" || language === "spring-boot") {
    if (/@Value|Environment\.getProperty/i.test(expression)) {
      return "CONFIG";
    }
    if (/HttpSession|session\./i.test(expression)) {
      return "SESSION";
    }
    if (/RestTemplate|WebClient|HttpClient/i.test(expression)) {
      return "EXTERNAL_API";
    }
  }

  if (language === "typescript" || language === "javascript" || language === "react") {
    if (/process\.env|config\./i.test(expression)) {
      return "CONFIG";
    }
    if (/fetch\s*\(|axios|http\.get/i.test(expression)) {
      return "EXTERNAL_API";
    }
    if (/sessionStorage|session\./i.test(expression)) {
      return "SESSION";
    }
  }

  return "UNKNOWN";
}

/**
 * Trace FreeMarker variable back to BeanShell context
 */
async function traceFreeMarkerVariable(
  variable: string,
  templatePath: string,
  repoPath: string
): Promise<{ sourceType: DataSourceType; sourcePath: DataFlowStep[] }> {
  const sourcePath: DataFlowStep[] = [];

  // Extract root variable (e.g., "schedule" from "schedule.blobUri")
  const rootVar = variable.split(".")[0]!.replace(/[?!].*$/, "");

  // Find related .bsh files
  const relatedFiles = findRelatedFiles(templatePath, repoPath);

  for (const bshFile of relatedFiles) {
    const content = await readFileContent(bshFile, repoPath);
    if (!content) continue;

    // Search for context.put("variableName", value)
    const contextPutPattern = new RegExp(
      `context\\.put\\s*\\(\\s*["']${rootVar}["']\\s*,\\s*([^)]+)\\)`,
      "gi"
    );

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = contextPutPattern.exec(line);
      if (match) {
        const valueExpr = match[1]!.trim();

        sourcePath.push({
          file: bshFile.replace(repoPath + "/", ""),
          line: i + 1,
          expression: `context.put("${rootVar}", ${valueExpr})`,
          operation: "source",
          language: "beanshell",
        });

        // Classify based on value expression
        const sourceType = classifyDataSource(valueExpr, "beanshell");
        return { sourceType, sourcePath };
      }
    }

    // Also check for direct variable assignment (BeanShell implicit context)
    const assignPattern = new RegExp(`^\\s*${rootVar}\\s*=\\s*(.+);?$`, "gm");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = assignPattern.exec(line);
      if (match) {
        const valueExpr = match[1]!.trim();

        sourcePath.push({
          file: bshFile.replace(repoPath + "/", ""),
          line: i + 1,
          expression: `${rootVar} = ${valueExpr}`,
          operation: "source",
          language: "beanshell",
        });

        const sourceType = classifyDataSource(valueExpr, "beanshell");
        return { sourceType, sourcePath };
      }
    }
  }

  // If variable looks like a loop variable, check the template itself
  const templateContent = await readFileContent(templatePath, repoPath);
  if (templateContent) {
    const listPattern = new RegExp(`<#list\\s+(\\w+)\\s+as\\s+${rootVar}>`);
    const listMatch = templateContent.match(listPattern);
    if (listMatch) {
      // It's a loop variable from another context variable
      const parentVar = listMatch[1]!;
      // Recursively trace the parent
      return traceFreeMarkerVariable(parentVar, templatePath, repoPath);
    }
  }

  return { sourceType: "UNKNOWN", sourcePath };
}

/**
 * Trace JavaScript/TypeScript variable
 */
async function traceJavaScriptVariable(
  variable: string,
  filePath: string,
  line: number,
  repoPath: string
): Promise<{ sourceType: DataSourceType; sourcePath: DataFlowStep[] }> {
  const sourcePath: DataFlowStep[] = [];
  const content = await readFileContent(filePath, repoPath);
  if (!content) return { sourceType: "UNKNOWN", sourcePath };

  const lines = content.split("\n");
  const language = detectLanguageFramework(filePath, content);

  // Look backwards from the usage line to find assignment
  for (let i = Math.min(line - 1, lines.length - 1); i >= 0; i--) {
    const currentLine = lines[i]!;

    // Check for various assignment patterns
    const assignPatterns = [
      new RegExp(`(?:const|let|var)\\s+${variable}\\s*=\\s*(.+)`),
      new RegExp(`${variable}\\s*=\\s*(.+)`),
      new RegExp(`\\{[^}]*${variable}[^}]*\\}\\s*=\\s*(.+)`), // Destructuring
    ];

    for (const pattern of assignPatterns) {
      const match = currentLine.match(pattern);
      if (match) {
        const valueExpr = match[1]!.trim().replace(/;$/, "");

        sourcePath.push({
          file: filePath.replace(repoPath + "/", ""),
          line: i + 1,
          expression: currentLine.trim(),
          operation: "source",
          language,
        });

        const sourceType = classifyDataSource(valueExpr, language);
        return { sourceType, sourcePath };
      }
    }

    // Check for function parameter (trace to call site would be more complex)
    const funcParamPattern = new RegExp(`function\\s*\\w*\\s*\\([^)]*\\b${variable}\\b`);
    const arrowParamPattern = new RegExp(`\\(([^)]*\\b${variable}\\b[^)]*)\\)\\s*=>`);
    if (funcParamPattern.test(currentLine) || arrowParamPattern.test(currentLine)) {
      sourcePath.push({
        file: filePath.replace(repoPath + "/", ""),
        line: i + 1,
        expression: `Parameter: ${variable}`,
        operation: "propagate",
        language,
      });

      // Function parameters could come from anywhere - mark as unknown for now
      // A more sophisticated implementation would trace call sites
      return { sourceType: "UNKNOWN", sourcePath };
    }
  }

  return { sourceType: "UNKNOWN", sourcePath };
}

/**
 * Trace Java variable
 */
async function traceJavaVariable(
  variable: string,
  filePath: string,
  line: number,
  repoPath: string
): Promise<{ sourceType: DataSourceType; sourcePath: DataFlowStep[] }> {
  const sourcePath: DataFlowStep[] = [];
  const content = await readFileContent(filePath, repoPath);
  if (!content) return { sourceType: "UNKNOWN", sourcePath };

  const lines = content.split("\n");
  const language = detectLanguageFramework(filePath, content);

  // Look backwards from the usage line
  for (let i = Math.min(line - 1, lines.length - 1); i >= 0; i--) {
    const currentLine = lines[i]!;

    // Check for assignment patterns
    const assignPatterns = [
      new RegExp(`\\b${variable}\\s*=\\s*(.+);`),
      new RegExp(`\\w+\\s+${variable}\\s*=\\s*(.+);`), // Type variable = value;
    ];

    for (const pattern of assignPatterns) {
      const match = currentLine.match(pattern);
      if (match) {
        const valueExpr = match[1]!.trim();

        sourcePath.push({
          file: filePath.replace(repoPath + "/", ""),
          line: i + 1,
          expression: currentLine.trim(),
          operation: "source",
          language,
        });

        const sourceType = classifyDataSource(valueExpr, language);
        return { sourceType, sourcePath };
      }
    }

    // Check for method parameter
    const methodParamPattern = new RegExp(`\\b\\w+\\s+${variable}\\b[,)]`);
    if (methodParamPattern.test(currentLine) && currentLine.includes("(")) {
      // Check for Spring annotations that indicate user input
      const prevLines = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
      if (/@RequestParam|@PathVariable|@RequestBody|@RequestHeader/.test(prevLines)) {
        sourcePath.push({
          file: filePath.replace(repoPath + "/", ""),
          line: i + 1,
          expression: `Spring-annotated parameter: ${variable}`,
          operation: "source",
          language,
        });
        return { sourceType: "USER_INPUT", sourcePath };
      }

      sourcePath.push({
        file: filePath.replace(repoPath + "/", ""),
        line: i + 1,
        expression: `Method parameter: ${variable}`,
        operation: "propagate",
        language,
      });
      return { sourceType: "UNKNOWN", sourcePath };
    }
  }

  return { sourceType: "UNKNOWN", sourcePath };
}

/**
 * Find dangerous sinks where the variable is used
 */
async function findSinks(
  variable: string,
  filePath: string,
  repoPath: string
): Promise<DataFlowSink[]> {
  const sinks: DataFlowSink[] = [];
  const content = await readFileContent(filePath, repoPath);
  if (!content) return sinks;

  const lines = content.split("\n");
  const language = detectLanguageFramework(filePath, content);

  // Get sink patterns for this language
  const allSinkPatterns = Object.entries(SINK_PATTERNS) as [SinkType, Record<LanguageFramework, RegExp[]>][];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Skip if variable isn't mentioned
    if (!line.includes(variable)) continue;

    // Check each sink type
    for (const [sinkType, languagePatterns] of allSinkPatterns) {
      const patterns = languagePatterns[language] ?? [];
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          sinks.push({
            file: filePath.replace(repoPath + "/", ""),
            line: i + 1,
            sinkType,
            expression: line.trim(),
            dangerous: true, // Assume dangerous unless we find sanitization
          });
        }
      }
    }
  }

  return sinks;
}

/**
 * Check if validation/sanitization exists between source and sink
 */
async function checkForSanitization(
  variable: string,
  sourceFile: string,
  sourceLine: number,
  sinkFile: string,
  sinkLine: number,
  repoPath: string
): Promise<{ validationFound: boolean; sanitizationFound: boolean }> {
  let validationFound = false;
  let sanitizationFound = false;

  const content = await readFileContent(sinkFile, repoPath);
  if (!content) return { validationFound, sanitizationFound };

  const lines = content.split("\n");
  const language = detectLanguageFramework(sinkFile, content);

  // Check lines between source and sink (if in same file)
  const startLine = sourceFile === sinkFile ? sourceLine : 0;
  const endLine = sinkLine;

  const relevantCode = lines.slice(startLine, endLine).join("\n");

  // Language-specific sanitization patterns
  const sanitizationPatterns: Record<LanguageFramework, RegExp[]> = {
    typescript: [/escape|sanitize|encode|DOMPurify|xss/i, /parameterized|prepared/i],
    javascript: [/escape|sanitize|encode|DOMPurify|xss/i, /textContent/i],
    react: [/DOMPurify|sanitize/i],
    java: [/PreparedStatement|setParameter|StringEscapeUtils|HtmlUtils\.htmlEscape/i],
    "spring-boot": [/PreparedStatement|@Valid|Validated|HtmlUtils/i],
    flutter: [/HtmlEscape|sanitize/i],
    dart: [/HtmlEscape/i],
    freemarker: [/\?html|\?url|\?js_string/i],
    beanshell: [/UtilCodec|encode/i],
    python: [/escape|bleach|sanitize|parameterized/i],
    unknown: [],
  };

  const validationPatterns: Record<LanguageFramework, RegExp[]> = {
    typescript: [/if\s*\([^)]*match|if\s*\([^)]*test|validate|isValid/i],
    javascript: [/if\s*\([^)]*match|if\s*\([^)]*test|validate/i],
    react: [/validate|isValid|yup|zod/i],
    java: [/if\s*\([^)]*!=\s*null|Pattern\.matches|@NotNull|@Valid/i],
    "spring-boot": [/@Valid|@NotNull|@NotBlank|BindingResult/i],
    flutter: [/validate|validator/i],
    dart: [/validate/i],
    freemarker: [/\?has_content|\?\?/i],
    beanshell: [/if\s*\([^)]*!=\s*null/i],
    python: [/if\s+\w+|validate|pydantic/i],
    unknown: [],
  };

  // Check for sanitization
  const sanitPatterns = sanitizationPatterns[language] ?? [];
  for (const pattern of sanitPatterns) {
    if (pattern.test(relevantCode)) {
      sanitizationFound = true;
      break;
    }
  }

  // Check for validation
  const valPatterns = validationPatterns[language] ?? [];
  for (const pattern of valPatterns) {
    if (pattern.test(relevantCode)) {
      validationFound = true;
      break;
    }
  }

  return { validationFound, sanitizationFound };
}

// =============================================================================
// Tool Definitions
// =============================================================================

/**
 * Main data flow tracing tool
 */
export const traceDataFlowTool = createTool({
  id: "trace_data_flow",
  description:
    "Trace where a variable's value originates (source) and where it's used (sinks). " +
    "Classifies data sources as USER_INPUT, SERVER_GENERATED, DATABASE, CONFIG, etc. " +
    "Works across multiple languages: TypeScript, JavaScript, Java, Spring Boot, " +
    "React, Flutter, FreeMarker, BeanShell, Python.",
  inputSchema: z.object({
    variable: z
      .string()
      .describe("Variable or expression to trace (e.g., 'userId', 'schedule.blobUri')"),
    filePath: z.string().describe("File path where the variable is used"),
    line: z.number().optional().describe("Line number where the variable is used (1-based)"),
  }),
  outputSchema: z.object({
    sourceType: z.enum([
      "USER_INPUT",
      "SERVER_GENERATED",
      "DATABASE",
      "CONFIG",
      "EXTERNAL_API",
      "SESSION",
      "FILE_SYSTEM",
      "UNKNOWN",
    ]),
    sourcePath: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        expression: z.string(),
        operation: z.enum(["source", "transform", "propagate", "sink", "validate", "sanitize"]),
        language: z.string(),
      })
    ),
    sinks: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        sinkType: z.string(),
        expression: z.string(),
        dangerous: z.boolean(),
      })
    ),
    validationFound: z.boolean(),
    sanitizationFound: z.boolean(),
    confidence: z.number(),
    language: z.string(),
    isDangerous: z.boolean().describe("True if user input reaches a dangerous sink without sanitization"),
  }),
  execute: async (input) => {
    const repoPath = getRepoContext()?.repoPath ?? "";
    const { variable, filePath, line } = input;

    log.debug({ variable, filePath, line }, "Tracing data flow");

    try {
      // Detect language
      const content = await readFileContent(filePath, repoPath);
      const language = detectLanguageFramework(filePath, content ?? undefined);

      // Trace based on file type
      let traceResult: { sourceType: DataSourceType; sourcePath: DataFlowStep[] };

      if (language === "freemarker") {
        traceResult = await traceFreeMarkerVariable(variable, filePath, repoPath);
      } else if (language === "typescript" || language === "javascript" || language === "react") {
        traceResult = await traceJavaScriptVariable(variable, filePath, line ?? 1, repoPath);
      } else if (language === "java" || language === "spring-boot") {
        traceResult = await traceJavaVariable(variable, filePath, line ?? 1, repoPath);
      } else {
        // Generic fallback
        traceResult = await traceJavaScriptVariable(variable, filePath, line ?? 1, repoPath);
      }

      // Find sinks
      const sinks = await findSinks(variable, filePath, repoPath);

      // Check for sanitization between source and sinks
      let validationFound = false;
      let sanitizationFound = false;

      if (traceResult.sourcePath.length > 0 && sinks.length > 0) {
        const sourceStep = traceResult.sourcePath[0]!;
        for (const sink of sinks) {
          const sanitCheck = await checkForSanitization(
            variable,
            sourceStep.file,
            sourceStep.line,
            sink.file,
            sink.line,
            repoPath
          );
          if (sanitCheck.validationFound) validationFound = true;
          if (sanitCheck.sanitizationFound) sanitizationFound = true;

          // Mark sink as not dangerous if sanitization found
          if (sanitizationFound) {
            sink.dangerous = false;
          }
        }
      }

      // Calculate confidence
      let confidence = 0.5; // Base confidence
      if (traceResult.sourcePath.length > 0) confidence += 0.3;
      if (traceResult.sourceType !== "UNKNOWN") confidence += 0.2;

      // Determine if flow is dangerous
      const isDangerous =
        isUserControlled(traceResult.sourceType) &&
        !sanitizationFound &&
        sinks.some((s) => s.dangerous);

      log.debug(
        {
          variable,
          sourceType: traceResult.sourceType,
          sinksCount: sinks.length,
          isDangerous,
        },
        "Data flow trace complete"
      );

      return {
        sourceType: traceResult.sourceType,
        sourcePath: traceResult.sourcePath,
        sinks,
        validationFound,
        sanitizationFound,
        confidence,
        language,
        isDangerous,
      };
    } catch (error) {
      log.error({ error, variable, filePath }, "Failed to trace data flow");
      return {
        sourceType: "UNKNOWN" as DataSourceType,
        sourcePath: [],
        sinks: [],
        validationFound: false,
        sanitizationFound: false,
        confidence: 0,
        language: "unknown",
        isDangerous: false,
      };
    }
  },
});

/**
 * Tool to verify if a file exists
 */
export const verifyFileExistsTool = createTool({
  id: "verify_file_exists",
  description:
    "Verify if a file exists at the given path. Useful for validating findings " +
    "that reference files.",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the file to verify"),
  }),
  outputSchema: z.object({
    exists: z.boolean(),
    actualPath: z.string().optional(),
    similarFiles: z.array(z.string()),
  }),
  execute: async (input) => {
    const repoPath = getRepoContext()?.repoPath ?? "";
    const { filePath } = input;

    let fullPath = filePath;
    if (repoPath && !filePath.startsWith(repoPath)) {
      fullPath = resolve(repoPath, filePath.replace(/^\/+/, ""));
    }

    const exists = fs.existsSync(fullPath);
    const similarFiles: string[] = [];

    // If file doesn't exist, look for similar files
    if (!exists) {
      const dir = dirname(fullPath);
      const baseName = basename(fullPath);

      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            // Check for similar names (case-insensitive, similar extensions)
            if (
              file.toLowerCase().includes(baseName.toLowerCase().replace(/\.[^.]+$/, "")) ||
              baseName.toLowerCase().includes(file.toLowerCase().replace(/\.[^.]+$/, ""))
            ) {
              similarFiles.push(resolve(dir, file).replace(repoPath + "/", ""));
            }
          }
        } catch {
          // Ignore directory read errors
        }
      }
    }

    return {
      exists,
      actualPath: exists ? fullPath.replace(repoPath + "/", "") : undefined,
      similarFiles: similarFiles.slice(0, 5), // Limit to 5 similar files
    };
  },
});

/**
 * Tool to check for validation/sanitization patterns
 */
export const checkSanitizationTool = createTool({
  id: "check_sanitization",
  description:
    "Check if validation or sanitization exists for a variable in a code block. " +
    "Searches for common sanitization patterns like escaping, encoding, validation.",
  inputSchema: z.object({
    variable: z.string().describe("Variable name to check"),
    filePath: z.string().describe("File path to check"),
    startLine: z.number().optional().describe("Start line of code block"),
    endLine: z.number().optional().describe("End line of code block"),
  }),
  outputSchema: z.object({
    validationFound: z.boolean(),
    sanitizationFound: z.boolean(),
    patterns: z.array(
      z.object({
        type: z.enum(["validation", "sanitization"]),
        line: z.number(),
        expression: z.string(),
      })
    ),
  }),
  execute: async (input) => {
    const repoPath = getRepoContext()?.repoPath ?? "";
    const { variable, filePath, startLine = 1, endLine } = input;

    const content = await readFileContent(filePath, repoPath);
    if (!content) {
      return { validationFound: false, sanitizationFound: false, patterns: [] };
    }

    const lines = content.split("\n");
    const language = detectLanguageFramework(filePath, content);
    const relevantLines = lines.slice(startLine - 1, endLine ?? lines.length);
    const patterns: { type: "validation" | "sanitization"; line: number; expression: string }[] = [];

    // Common validation patterns
    const validationPatterns = [
      /if\s*\([^)]*\b\w+\b\s*[!=]==?\s*(null|undefined|""|''|0)\)/i,
      /if\s*\([^)]*\.match\s*\(|\.test\s*\(/i,
      /validate|isValid|@Valid|@NotNull|@NotBlank/i,
      /try\s*\{|catch\s*\(/i,
      /typeof\s+\w+\s*[!=]==?/i,
    ];

    // Common sanitization patterns
    const sanitizationPatterns = [
      /escape|sanitize|encode|purify|clean/i,
      /DOMPurify|xss/i,
      /PreparedStatement|setParameter/i,
      /HtmlUtils|StringEscapeUtils/i,
      /\?html|\?url|\?js_string/i, // FreeMarker
      /encodeURIComponent|encodeURI/i,
      /textContent/i, // Safe DOM property
    ];

    for (let i = 0; i < relevantLines.length; i++) {
      const line = relevantLines[i]!;
      if (!line.includes(variable)) continue;

      for (const pattern of validationPatterns) {
        if (pattern.test(line)) {
          patterns.push({
            type: "validation",
            line: startLine + i,
            expression: line.trim(),
          });
          break;
        }
      }

      for (const pattern of sanitizationPatterns) {
        if (pattern.test(line)) {
          patterns.push({
            type: "sanitization",
            line: startLine + i,
            expression: line.trim(),
          });
          break;
        }
      }
    }

    return {
      validationFound: patterns.some((p) => p.type === "validation"),
      sanitizationFound: patterns.some((p) => p.type === "sanitization"),
      patterns,
    };
  },
});
