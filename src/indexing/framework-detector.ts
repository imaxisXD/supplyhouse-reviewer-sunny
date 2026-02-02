/**
 * Framework / stack detector.
 *
 * Inspects a cloned repository's file system to determine which framework
 * (React, TypeScript, Java, Flutter, FTL) is being used.
 * Returns a sorted list of detections ordered by confidence (highest first).
 */

import { createLogger } from "../config/logger.ts";
import * as fs from "fs";
import * as path from "path";

const log = createLogger("framework-detector");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FrameworkDetection {
  framework: string;
  confidence: number;
  /** Indicator files/patterns that were found. */
  filePatterns: string[];
  /** Directories / files to exclude from parsing for this framework. */
  excludePatterns: string[];
}

// ---------------------------------------------------------------------------
// Framework indicator definitions
// ---------------------------------------------------------------------------

interface FrameworkIndicator {
  framework: string;
  /** Files whose presence increases the score. */
  indicatorFiles: string[];
  /** File extensions whose presence increases the score. */
  indicatorExtensions?: string[];
  /** Weight added per indicator file found (default 0.2). */
  weight?: number;
  /** Weight added when any extension match is found (defaults to weight). */
  extensionWeight?: number;
  /** Additional content-based checks (file, substring). */
  contentChecks?: { file: string; substring: string; weight: number }[];
  /** Patterns to exclude when parsing this framework's repo. */
  excludePatterns: string[];
}

const FRAMEWORK_INDICATORS: FrameworkIndicator[] = [
  // -- React / TypeScript -----------------------------------------------
  {
    framework: "react",
    indicatorFiles: ["package.json", "tsconfig.json"],
    weight: 0.15,
    contentChecks: [
      { file: "package.json", substring: '"react"', weight: 0.3 },
      { file: "package.json", substring: '"react-dom"', weight: 0.2 },
    ],
    excludePatterns: ["node_modules", "build", "dist"],
  },
  {
    framework: "typescript",
    indicatorFiles: ["tsconfig.json"],
    indicatorExtensions: [".ts", ".tsx"],
    weight: 0.3,
    contentChecks: [
      { file: "package.json", substring: '"typescript"', weight: 0.2 },
    ],
    excludePatterns: ["node_modules", "build", "dist"],
  },

  // -- Java --------------------------------------------------------------
  {
    framework: "java",
    indicatorFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
    indicatorExtensions: [".java"],
    weight: 0.2,
    contentChecks: [
      { file: "pom.xml", substring: "spring", weight: 0.2 },
      { file: "build.gradle", substring: "spring", weight: 0.2 },
      { file: "build.gradle.kts", substring: "spring", weight: 0.2 },
    ],
    excludePatterns: ["target", "build", ".gradle", ".mvn"],
  },

  // -- Flutter -----------------------------------------------------------
  {
    framework: "flutter",
    indicatorFiles: ["pubspec.yaml"],
    weight: 0.25,
    contentChecks: [
      { file: "pubspec.yaml", substring: "flutter:", weight: 0.4 },
      { file: "pubspec.yaml", substring: "flutter_test:", weight: 0.1 },
    ],
    excludePatterns: [".dart_tool", "build", ".flutter-plugins"],
  },

  // -- FTL (FreeMarker templates) ---------------------------------------
  {
    framework: "ftl",
    indicatorFiles: [],
    indicatorExtensions: [".ftl"],
    weight: 0.2,
    extensionWeight: 0.4,
    excludePatterns: ["build", "target", "node_modules"],
  },
];

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

/**
 * Read a file's text content. Returns `null` if the file does not exist or is
 * not readable (e.g. binary).
 */
function safeReadText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

const SCAN_EXCLUDES = new Set([
  "node_modules", ".git", ".svn", ".hg",
  ".idea", ".vscode", ".next", ".dart_tool",
  "dist", "build", "target",
]);

function hasFileWithExtension(
  dir: string,
  extensions: string[],
  excludePatterns: string[],
  maxFiles = 5000,
): boolean {
  let checked = 0;
  const normalized = extensions.map((ext) => ext.toLowerCase());

  function walk(current: string): boolean {
    if (checked >= maxFiles) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (checked >= maxFiles) return false;
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (SCAN_EXCLUDES.has(entry.name) || excludePatterns.includes(entry.name)) {
          continue;
        }
        if (walk(fullPath)) return true;
      } else if (entry.isFile()) {
        checked++;
        const ext = path.extname(entry.name).toLowerCase();
        if (normalized.includes(ext)) {
          return true;
        }
      }
    }

    return false;
  }

  return walk(dir);
}

/**
 * Detect frameworks used in the given repository directory.
 *
 * @param repoDir  Absolute path to the cloned repository root.
 * @returns Array of detections sorted by confidence (highest first). Only
 *          frameworks with confidence > 0 are included.
 */
export async function detectFrameworks(
  repoDir: string,
): Promise<FrameworkDetection[]> {
  const detections: FrameworkDetection[] = [];

  for (const indicator of FRAMEWORK_INDICATORS) {
    let confidence = 0;
    const matchedFiles: string[] = [];

    // Check indicator files
    for (const file of indicator.indicatorFiles) {
      const fullPath = path.join(repoDir, file);
      if (fileExists(fullPath)) {
        confidence += indicator.weight ?? 0.2;
        matchedFiles.push(file);
      }
    }

    // Content checks
    if (indicator.contentChecks) {
      for (const check of indicator.contentChecks) {
        const fullPath = path.join(repoDir, check.file);
        const content = safeReadText(fullPath);
        if (content && content.toLowerCase().includes(check.substring.toLowerCase())) {
          confidence += check.weight;
          if (!matchedFiles.includes(check.file)) {
            matchedFiles.push(check.file);
          }
        }
      }
    }

    // Extension checks (e.g., .ftl templates)
    if (indicator.indicatorExtensions && indicator.indicatorExtensions.length > 0) {
      const hit = hasFileWithExtension(repoDir, indicator.indicatorExtensions, indicator.excludePatterns);
      if (hit) {
        confidence += indicator.extensionWeight ?? indicator.weight ?? 0.2;
        for (const ext of indicator.indicatorExtensions) {
          const label = `*${ext}`;
          if (!matchedFiles.includes(label)) {
            matchedFiles.push(label);
          }
        }
      }
    }

    if (confidence > 0) {
      // Cap at 1.0
      confidence = Math.min(confidence, 1.0);
      detections.push({
        framework: indicator.framework,
        confidence: Math.round(confidence * 100) / 100,
        filePatterns: matchedFiles,
        excludePatterns: indicator.excludePatterns,
      });
    }
  }

  // Sort by confidence descending
  detections.sort((a, b) => b.confidence - a.confidence);

  // De-duplicate: if a specific framework already matches (e.g. "spring-boot"),
  // lower the confidence of the generic variant (e.g. "java-generic").
  const genericPairs: Record<string, string[]> = {
    typescript: ["react"],
  };

  for (const [generic, specifics] of Object.entries(genericPairs)) {
    const hasSpecific = detections.some(
      (d) => specifics.includes(d.framework) && d.confidence > 0.3,
    );
    if (hasSpecific) {
      const idx = detections.findIndex((d) => d.framework === generic);
      if (idx >= 0 && detections[idx] !== undefined) {
        detections[idx].confidence = Math.max(detections[idx].confidence - 0.3, 0);
      }
    }
  }

  // Re-sort after adjustment and filter out zero-confidence
  const result = detections
    .filter((d) => d.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);

  log.info(
    { detected: result.map((d) => `${d.framework}(${d.confidence})`) },
    "Framework detection complete",
  );

  return result;
}

/**
 * Convenience helper: returns the single most likely framework name, or
 * "unknown" if nothing matched above the given threshold.
 */
export async function detectPrimaryFramework(
  repoDir: string,
  threshold = 0.2,
): Promise<string> {
  const detections = await detectFrameworks(repoDir);
  const first = detections[0];
  if (detections.length > 0 && first !== undefined && first.confidence >= threshold) {
    return first.framework;
  }
  return "unknown";
}
