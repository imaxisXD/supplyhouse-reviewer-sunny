/**
 * Syntax Validators Module
 *
 * Pre-agent syntax validation for catching obvious errors without LLM.
 * Validates FreeMarker (.ftl), CSS (.css), and JavaScript (.js) files.
 */

import type { DiffFile } from "../types/bitbucket.ts";
import type { Finding, Severity, Category } from "../types/findings.ts";
import * as fs from "fs";
import * as path from "path";

// =============================================================================
// Types
// =============================================================================

export interface SyntaxError {
  file: string;
  line: number;
  column?: number;
  message: string;
  errorType: "freemarker" | "css" | "javascript" | "beanshell";
  severity: Severity;
  suggestion?: string;
}

// =============================================================================
// FreeMarker Syntax Validation
// =============================================================================

const FTL_DIRECTIVE_PAIRS = new Map<string, string>([
  ["#if", "/#if"],
  ["#list", "/#list"],
  ["#macro", "/#macro"],
  ["#function", "/#function"],
  ["#switch", "/#switch"],
  ["#attempt", "/#attempt"],
  ["#compress", "/#compress"],
]);

/**
 * Validate FreeMarker template syntax
 */
export function validateFreeMarkerSyntax(
  content: string,
  filePath: string
): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const lines = content.split("\n");

  // Track directive stack for balance checking
  const directiveStack: { directive: string; line: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Check for <##directive> typo (double hash)
    const doubleHashMatches = line.matchAll(/<##(\w+)/g);
    for (const match of doubleHashMatches) {
      const directive = match[1];
      errors.push({
        file: filePath,
        line: lineNum,
        column: match.index,
        message: `Malformed FreeMarker directive: <##${directive}> should be <#${directive}>`,
        errorType: "freemarker",
        severity: "high",
        suggestion: `Replace <##${directive} with <#${directive}`,
      });
    }

    // Check for space after hash: <# if> instead of <#if>
    const spaceAfterHashMatches = line.matchAll(/<#\s+(\w+)/g);
    for (const match of spaceAfterHashMatches) {
      const directive = match[1];
      // Skip if it's a comment <#-- -->
      if (directive === "-") continue;
      errors.push({
        file: filePath,
        line: lineNum,
        column: match.index,
        message: `Space in FreeMarker directive: <# ${directive}> should be <#${directive}>`,
        errorType: "freemarker",
        severity: "medium",
        suggestion: `Remove space: <#${directive}>`,
      });
    }

    // Check for unclosed interpolation: ${foo without closing }
    const unclosedInterpolation = line.match(/\$\{[^}]*$/);
    if (unclosedInterpolation && !line.includes("<!--") && !line.includes("<#--")) {
      // Check if it's closed on the next line (multi-line interpolation)
      const nextLine = lines[i + 1] ?? "";
      if (!nextLine.includes("}")) {
        errors.push({
          file: filePath,
          line: lineNum,
          message: `Potentially unclosed interpolation: missing closing }`,
          errorType: "freemarker",
          severity: "medium",
          suggestion: `Ensure the interpolation \${...} is properly closed`,
        });
      }
    }

    // Track opening directives for balance checking
    for (const [openDir] of FTL_DIRECTIVE_PAIRS) {
      const openPattern = new RegExp(`<${openDir}[\\s>]`, "g");
      const selfClosingPattern = new RegExp(`<${openDir}[^>]*/>`);

      if (openPattern.test(line) && !selfClosingPattern.test(line)) {
        directiveStack.push({ directive: openDir, line: lineNum });
      }
    }

    // Track closing directives
    for (const [openDir, closeDir] of FTL_DIRECTIVE_PAIRS) {
      const closePattern = new RegExp(`<${closeDir}>`, "g");
      if (closePattern.test(line)) {
        // Find matching open directive
        let found = false;
        for (let j = directiveStack.length - 1; j >= 0; j--) {
          if (directiveStack[j]!.directive === openDir) {
            directiveStack.splice(j, 1);
            found = true;
            break;
          }
        }
        if (!found) {
          errors.push({
            file: filePath,
            line: lineNum,
            message: `Unmatched closing directive: <${closeDir}> without corresponding <${openDir}>`,
            errorType: "freemarker",
            severity: "high",
            suggestion: `Remove orphan <${closeDir}> or add matching <${openDir}>`,
          });
        }
      }
    }

    // Check for deprecated ?exists (should use ?? or ?has_content)
    if (/\?\s*exists\b/.test(line) && !line.includes("<#--")) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `Deprecated FreeMarker syntax: ?exists is deprecated`,
        errorType: "freemarker",
        severity: "low",
        suggestion: `Use ?? for null check or ?has_content for non-empty check`,
      });
    }
  }

  // Report unclosed directives at end of file
  for (const unclosed of directiveStack) {
    const closeDir = FTL_DIRECTIVE_PAIRS.get(unclosed.directive);
    errors.push({
      file: filePath,
      line: unclosed.line,
      message: `Unclosed FreeMarker directive: <${unclosed.directive}> opened here but never closed`,
      errorType: "freemarker",
      severity: "high",
      suggestion: `Add <${closeDir}> to close the directive`,
    });
  }

  return errors;
}

// =============================================================================
// CSS Syntax Validation
// =============================================================================

const CSS_VENDOR_PREFIXES = ["webkit", "moz", "ms", "o"];

/**
 * Validate CSS syntax
 */
export function validateCSSSyntax(
  content: string,
  filePath: string
): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const lines = content.split("\n");

  // Track brace balance
  let braceCount = 0;
  let inComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Handle multi-line comments
    if (line.includes("/*")) inComment = true;
    if (line.includes("*/")) inComment = false;
    if (inComment) continue;

    // Check for missing vendor prefix dash: webkit- instead of -webkit-
    for (const prefix of CSS_VENDOR_PREFIXES) {
      // Pattern: start of property (after whitespace or {) followed by vendor name without dash
      const badPrefixPattern = new RegExp(
        `(?:^|[{;\\s])\\s*(${prefix})-([a-z-]+)\\s*:`,
        "gi"
      );
      const matches = line.matchAll(badPrefixPattern);

      for (const match of matches) {
        const fullMatch = match[0];
        const prefixName = match[1];
        const property = match[2];

        // Verify it's not already correct (has leading dash)
        const correctPattern = new RegExp(`-${prefix}-${property}`, "i");
        if (!correctPattern.test(line)) {
          errors.push({
            file: filePath,
            line: lineNum,
            message: `Missing dash in CSS vendor prefix: "${prefixName}-${property}" should be "-${prefixName}-${property}"`,
            errorType: "css",
            severity: "medium",
            suggestion: `Change "${prefixName}-${property}" to "-${prefixName}-${property}"`,
          });
        }
      }
    }

    // Track brace balance
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    braceCount += opens - closes;

    // Check for negative balance (too many closes)
    if (braceCount < 0) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `Unmatched closing brace: found } without corresponding {`,
        errorType: "css",
        severity: "high",
        suggestion: `Remove extra } or add missing {`,
      });
      braceCount = 0; // Reset to continue checking
    }

    // Check for invalid property syntax (common typos)
    // Property without value: "color;" instead of "color: red;"
    const propertyWithoutValue = line.match(/^\s*([a-z-]+)\s*;/i);
    if (propertyWithoutValue && !line.includes(":")) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `CSS property without value: "${propertyWithoutValue[1]}" has no value`,
        errorType: "css",
        severity: "medium",
        suggestion: `Add a value: "${propertyWithoutValue[1]}: value;"`,
      });
    }
  }

  // Report unclosed braces at end of file
  if (braceCount > 0) {
    errors.push({
      file: filePath,
      line: lines.length,
      message: `Unclosed CSS rule block: ${braceCount} unclosed { brace(s)`,
      errorType: "css",
      severity: "high",
      suggestion: `Add ${braceCount} closing } brace(s)`,
    });
  }

  return errors;
}

// =============================================================================
// JavaScript Syntax Validation
// =============================================================================

/**
 * Validate JavaScript syntax (basic checks)
 */
export function validateJavaScriptSyntax(
  content: string,
  filePath: string
): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const lines = content.split("\n");

  // Track bracket/brace/paren balance
  let braceCount = 0;
  let bracketCount = 0;
  let parenCount = 0;
  let inMultiLineComment = false;
  let inTemplateLiteral = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Track multi-line comments
    if (line.includes("/*") && !line.includes("*/")) {
      inMultiLineComment = true;
    }
    if (line.includes("*/")) {
      inMultiLineComment = false;
      continue;
    }
    if (inMultiLineComment) continue;

    // Remove strings and single-line comments for counting
    let codeOnly = line
      .replace(/\/\/.*/g, "") // Remove single-line comments
      .replace(/"(?:[^"\\]|\\.)*"/g, '""') // Remove double-quoted strings
      .replace(/'(?:[^'\\]|\\.)*'/g, "''") // Remove single-quoted strings
      .replace(/`(?:[^`\\]|\\.)*`/g, "``"); // Remove template literals (simple)

    // Count brackets
    braceCount += (codeOnly.match(/\{/g) || []).length;
    braceCount -= (codeOnly.match(/\}/g) || []).length;
    bracketCount += (codeOnly.match(/\[/g) || []).length;
    bracketCount -= (codeOnly.match(/\]/g) || []).length;
    parenCount += (codeOnly.match(/\(/g) || []).length;
    parenCount -= (codeOnly.match(/\)/g) || []).length;

    // Check for common syntax issues

    // Double semicolon (except in for loops)
    if (/;;(?!\s*\))/.test(codeOnly) && !/for\s*\(/.test(line)) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `Double semicolon: possible typo`,
        errorType: "javascript",
        severity: "low",
        suggestion: `Remove extra semicolon`,
      });
    }

    // Assignment in condition (common mistake)
    const assignInCondition = codeOnly.match(/if\s*\(\s*\w+\s*=\s*[^=]/);
    if (assignInCondition && !/===?/.test(codeOnly.substring(codeOnly.indexOf("if")))) {
      // Only warn if it's clearly not a comparison
      const ifSection = codeOnly.substring(codeOnly.indexOf("if"));
      if (!/[!=]==?/.test(ifSection.substring(0, ifSection.indexOf(")")))) {
        errors.push({
          file: filePath,
          line: lineNum,
          message: `Assignment in condition: did you mean == or ===?`,
          errorType: "javascript",
          severity: "medium",
          suggestion: `Use == or === for comparison, or wrap in extra parentheses if intentional`,
        });
      }
    }
  }

  // Report unbalanced at end of file
  if (braceCount > 0) {
    errors.push({
      file: filePath,
      line: lines.length,
      message: `Unclosed braces: ${braceCount} more { than }`,
      errorType: "javascript",
      severity: "high",
      suggestion: `Add ${braceCount} closing } brace(s)`,
    });
  }
  if (braceCount < 0) {
    errors.push({
      file: filePath,
      line: lines.length,
      message: `Extra closing braces: ${-braceCount} more } than {`,
      errorType: "javascript",
      severity: "high",
      suggestion: `Remove ${-braceCount} extra } brace(s)`,
    });
  }
  if (bracketCount !== 0) {
    errors.push({
      file: filePath,
      line: lines.length,
      message: `Unbalanced brackets: ${bracketCount > 0 ? bracketCount + " unclosed [" : -bracketCount + " extra ]"}`,
      errorType: "javascript",
      severity: "high",
      suggestion: `Balance [ and ] brackets`,
    });
  }
  if (parenCount !== 0) {
    errors.push({
      file: filePath,
      line: lines.length,
      message: `Unbalanced parentheses: ${parenCount > 0 ? parenCount + " unclosed (" : -parenCount + " extra )"}`,
      errorType: "javascript",
      severity: "high",
      suggestion: `Balance ( and ) parentheses`,
    });
  }

  return errors;
}

// =============================================================================
// BeanShell Syntax Validation
// =============================================================================

/**
 * Validate BeanShell syntax (Java-like, used in OFBiz)
 */
export function validateBeanShellSyntax(
  content: string,
  filePath: string
): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Check for null key in Map operations (common OFBiz issue)
    // FastMap.put(null, ...) or similar
    const nullKeyMatch = line.match(/(\w+Map)\.put\s*\(\s*(\w+)\s*,/);
    if (nullKeyMatch) {
      const mapVar = nullKeyMatch[1];
      const keyVar = nullKeyMatch[2];

      // Check if there's a null check for the key variable before this line
      const precedingLines = lines.slice(Math.max(0, i - 10), i).join("\n");
      const hasNullCheck = new RegExp(`if\\s*\\(\\s*${keyVar}\\s*!=\\s*null|${keyVar}\\s*!=\\s*null`).test(precedingLines);

      if (!hasNullCheck && keyVar !== "null") {
        // This is a potential issue - we'll flag it but let the LLM agents handle verification
        // We're just noting this pattern exists
      }
    }
  }

  return errors;
}

// =============================================================================
// TypeScript/TSX Syntax Validation
// =============================================================================

/**
 * Validate TypeScript/TSX syntax
 */
export function validateTypeScriptSyntax(
  content: string,
  filePath: string
): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const lines = content.split("\n");
  const isTsx = filePath.endsWith(".tsx");

  // Track generics balance for TSX
  let genericDepth = 0;
  let jsxDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Check for common TypeScript errors

    // Missing type annotation in function parameters (when strict mode expected)
    // This is informational - won't catch all cases
    const implicitAny = line.match(/function\s+\w+\s*\(\s*(\w+)\s*[,)]/);
    if (implicitAny && !line.includes(":")) {
      // Only flag if there's no type annotation at all
      const hasTypeAnnotation = /:\s*\w+/.test(line);
      if (!hasTypeAnnotation && !line.includes("...")) {
        errors.push({
          file: filePath,
          line: lineNum,
          message: `Possible implicit 'any' type: parameter "${implicitAny[1]}" has no type annotation`,
          errorType: "javascript", // TypeScript is a superset
          severity: "info",
          suggestion: `Add type annotation: ${implicitAny[1]}: Type`,
        });
      }
    }

    // Check for TSX-specific issues
    if (isTsx) {
      // Unescaped < in JSX text (common mistake)
      // This is tricky because < is valid in comparisons
      const jsxTextWithLt = line.match(/>\s*[^<]*<[^/<]/);
      if (jsxTextWithLt && !line.includes("{") && !line.includes("//")) {
        // Might be unescaped < in text
        // Don't flag - too many false positives
      }

      // Self-closing tag without space before />
      const badSelfClose = line.match(/<(\w+)[^>]*[^\s/]\/>/);
      if (badSelfClose) {
        errors.push({
          file: filePath,
          line: lineNum,
          message: `JSX style: missing space before /> in self-closing tag`,
          errorType: "javascript",
          severity: "info",
          suggestion: `Add space: <${badSelfClose[1]} ... />`,
        });
      }
    }
  }

  // Also run JavaScript validation
  const jsErrors = validateJavaScriptSyntax(content, filePath);
  errors.push(...jsErrors);

  return errors;
}

// =============================================================================
// Java Syntax Validation
// =============================================================================

/**
 * Validate Java syntax
 */
export function validateJavaSyntax(
  content: string,
  filePath: string
): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const lines = content.split("\n");

  // Track brace balance
  let braceCount = 0;
  let inMultiLineComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Handle comments
    if (line.includes("/*")) inMultiLineComment = true;
    if (line.includes("*/")) {
      inMultiLineComment = false;
      continue;
    }
    if (inMultiLineComment || line.trim().startsWith("//")) continue;

    // Remove strings for counting
    const codeOnly = line
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");

    // Track braces
    braceCount += (codeOnly.match(/\{/g) || []).length;
    braceCount -= (codeOnly.match(/\}/g) || []).length;

    // Check for common Java errors

    // Missing semicolon after statement (heuristic)
    const needsSemicolon = /^\s*(return|throw|break|continue|[a-zA-Z_]\w*\s*=)\s+[^;{]*$/;
    if (needsSemicolon.test(line) && !line.trim().endsWith("{") && !line.trim().endsWith(",")) {
      const nextLine = lines[i + 1] ?? "";
      if (!nextLine.trim().startsWith(".") && !nextLine.trim().startsWith("+")) {
        errors.push({
          file: filePath,
          line: lineNum,
          message: `Possible missing semicolon at end of statement`,
          errorType: "javascript", // Using 'javascript' as generic syntax error
          severity: "medium",
          suggestion: `Add semicolon at the end of the line`,
        });
      }
    }

    // == instead of .equals() for String comparison
    const stringCompare = line.match(/(\w+)\s*==\s*"[^"]*"/);
    if (stringCompare) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `String comparison using ==: "${stringCompare[1]}" should use .equals()`,
        errorType: "javascript",
        severity: "medium",
        suggestion: `Use ${stringCompare[1]}.equals("...") or Objects.equals() for null-safe comparison`,
      });
    }

    // Catching Exception instead of specific exception
    if (/catch\s*\(\s*Exception\s+\w+\s*\)/.test(line)) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `Catching generic Exception: consider catching specific exception types`,
        errorType: "javascript",
        severity: "low",
        suggestion: `Catch specific exceptions like IOException, SQLException, etc.`,
      });
    }
  }

  // Report unbalanced braces
  if (braceCount !== 0) {
    errors.push({
      file: filePath,
      line: lines.length,
      message: `Unbalanced braces: ${braceCount > 0 ? braceCount + " unclosed {" : -braceCount + " extra }"}`,
      errorType: "javascript",
      severity: "high",
      suggestion: `Balance { and } braces`,
    });
  }

  return errors;
}

// =============================================================================
// Dart/Flutter Syntax Validation
// =============================================================================

/**
 * Validate Dart/Flutter syntax
 */
export function validateDartSyntax(
  content: string,
  filePath: string
): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Check for common Dart/Flutter errors

    // Using var when type could be inferred (style issue)
    // Don't flag - this is a style preference

    // Missing const for immutable widgets
    const widgetWithoutConst = line.match(/return\s+(Container|Text|Icon|SizedBox|Padding)\s*\(/);
    if (widgetWithoutConst && !line.includes("const")) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `Flutter: Consider using const for immutable widget ${widgetWithoutConst[1]}`,
        errorType: "javascript",
        severity: "info",
        suggestion: `Add const: return const ${widgetWithoutConst[1]}(...)`,
      });
    }

    // setState called outside build context (common mistake)
    // Can't reliably detect without full AST

    // Deprecated widgets
    const deprecatedWidgets = ["FlatButton", "RaisedButton", "OutlineButton"];
    for (const widget of deprecatedWidgets) {
      if (line.includes(widget)) {
        errors.push({
          file: filePath,
          line: lineNum,
          message: `Deprecated Flutter widget: ${widget}`,
          errorType: "javascript",
          severity: "medium",
          suggestion: `Use ElevatedButton, TextButton, or OutlinedButton instead`,
        });
      }
    }
  }

  // Also run JavaScript validation for basic syntax
  const jsErrors = validateJavaScriptSyntax(content, filePath);
  // Filter out JS-specific errors that don't apply to Dart
  const filteredJsErrors = jsErrors.filter(e =>
    !e.message.includes("semicolon") // Dart uses semicolons differently
  );
  errors.push(...filteredJsErrors);

  return errors;
}

// =============================================================================
// Python Syntax Validation
// =============================================================================

/**
 * Validate Python syntax
 */
export function validatePythonSyntax(
  content: string,
  filePath: string
): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const lines = content.split("\n");

  // Track indentation
  const indentStack: number[] = [0];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    // Check indentation
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;

    // Mixed tabs and spaces
    if (/^\t+ |\s+\t/.test(line)) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `Mixed tabs and spaces in indentation`,
        errorType: "javascript",
        severity: "high",
        suggestion: `Use consistent indentation (spaces recommended)`,
      });
    }

    // Check for common Python errors

    // Mutable default argument
    const mutableDefault = line.match(/def\s+\w+\s*\([^)]*(\w+)\s*=\s*(\[\]|\{\}|set\(\))/);
    if (mutableDefault) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `Mutable default argument: ${mutableDefault[1]}=${mutableDefault[2]}`,
        errorType: "javascript",
        severity: "high",
        suggestion: `Use None as default and initialize inside function: ${mutableDefault[1]}=None`,
      });
    }

    // except without specific exception
    if (/except\s*:/.test(line)) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `Bare except clause: catches all exceptions including KeyboardInterrupt`,
        errorType: "javascript",
        severity: "medium",
        suggestion: `Catch specific exceptions: except Exception: or except (TypeError, ValueError):`,
      });
    }

    // == None instead of is None
    if (/==\s*None|None\s*==/.test(line)) {
      errors.push({
        file: filePath,
        line: lineNum,
        message: `Use 'is None' instead of '== None' for None comparison`,
        errorType: "javascript",
        severity: "low",
        suggestion: `Replace == None with is None`,
      });
    }
  }

  return errors;
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Convert syntax errors to Finding format
 */
function syntaxErrorToFinding(error: SyntaxError): Finding {
  const categoryMap: Record<string, Category> = {
    freemarker: "bug",
    css: "bug",
    javascript: "bug",
    beanshell: "bug",
  };

  return {
    file: error.file,
    line: error.line,
    severity: error.severity,
    category: categoryMap[error.errorType] ?? "bug",
    title: `Syntax Error (${error.errorType.toUpperCase()})`,
    description: error.message,
    suggestion: error.suggestion,
    confidence: 0.95, // High confidence for syntax errors
    lineId: `L${error.line}`,
  };
}

/**
 * Run syntax validation on changed files
 *
 * @param repoPath - Path to the repository
 * @param diffFiles - List of changed files from the PR
 * @returns Array of findings for syntax errors
 */
export function runSyntaxValidation(
  repoPath: string,
  diffFiles: DiffFile[]
): Finding[] {
  const findings: Finding[] = [];

  for (const diffFile of diffFiles) {
    // Skip deleted files
    if (diffFile.status === "deleted") continue;

    const fullPath = path.join(repoPath, diffFile.path);

    // Check if file exists
    if (!fs.existsSync(fullPath)) continue;

    // Read file content
    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      continue; // Skip files we can't read
    }

    const ext = path.extname(diffFile.path).toLowerCase();
    let errors: SyntaxError[] = [];

    // Run appropriate validator based on file extension
    if (ext === ".ftl") {
      errors = validateFreeMarkerSyntax(content, diffFile.path);
    } else if (ext === ".css") {
      errors = validateCSSSyntax(content, diffFile.path);
    } else if (ext === ".js" || ext === ".jsx") {
      errors = validateJavaScriptSyntax(content, diffFile.path);
    } else if (ext === ".ts" || ext === ".tsx") {
      errors = validateTypeScriptSyntax(content, diffFile.path);
    } else if (ext === ".java") {
      errors = validateJavaSyntax(content, diffFile.path);
    } else if (ext === ".dart") {
      errors = validateDartSyntax(content, diffFile.path);
    } else if (ext === ".py") {
      errors = validatePythonSyntax(content, diffFile.path);
    } else if (ext === ".bsh") {
      errors = validateBeanShellSyntax(content, diffFile.path);
    }

    // Also check for inline JavaScript/CSS in FTL files
    if (ext === ".ftl") {
      // Extract and validate inline JavaScript
      const scriptMatches = content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
      for (const match of scriptMatches) {
        const scriptContent = match[1] ?? "";
        const scriptStart = content.substring(0, match.index).split("\n").length;
        const jsErrors = validateJavaScriptSyntax(scriptContent, diffFile.path);
        // Adjust line numbers to be relative to the file
        for (const jsError of jsErrors) {
          jsError.line += scriptStart - 1;
          errors.push(jsError);
        }
      }

      // Extract and validate inline CSS
      const styleMatches = content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
      for (const match of styleMatches) {
        const styleContent = match[1] ?? "";
        const styleStart = content.substring(0, match.index).split("\n").length;
        const cssErrors = validateCSSSyntax(styleContent, diffFile.path);
        // Adjust line numbers
        for (const cssError of cssErrors) {
          cssError.line += styleStart - 1;
          errors.push(cssError);
        }
      }
    }

    // Convert errors to findings
    for (const error of errors) {
      findings.push(syntaxErrorToFinding(error));
    }
  }

  return findings;
}

/**
 * Filter syntax findings to only include lines that were changed in the PR
 *
 * @param findings - All syntax findings
 * @param diffFiles - Changed files with diff information
 * @returns Filtered findings that are in changed lines
 */
export function filterSyntaxFindingsToChangedLines(
  findings: Finding[],
  diffFiles: DiffFile[]
): Finding[] {
  const changedLinesByFile = new Map<string, Set<number>>();

  // Build map of changed lines per file
  for (const diffFile of diffFiles) {
    if (!diffFile.hunks) continue;

    const lines = new Set<number>();
    for (const hunk of diffFile.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add" && change.lineNew) {
          lines.add(change.lineNew);
        }
      }
    }
    changedLinesByFile.set(diffFile.path, lines);
  }

  // Filter findings to only include changed lines
  return findings.filter((finding) => {
    const changedLines = changedLinesByFile.get(finding.file);
    if (!changedLines) return true; // If we don't have hunk info, include all
    return changedLines.has(finding.line);
  });
}
