/**
 * Session-specific logger factory.
 *
 * Creates Pino loggers that write to session-specific log files for
 * PR reviews and repository indexing operations.
 */

import pino from "pino";
import type { Logger } from "pino";
import * as fs from "fs";
import * as path from "path";
import { env } from "./env.ts";
import { loadLoggingConfig } from "./logging-config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewSessionMetadata {
  reviewId: string;
  workspace: string;
  repoSlug: string;
  prNumber: number;
  branch?: string;
}

export interface IndexSessionMetadata {
  jobId: string;
  repoId: string;
  branch: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");
const GLOBAL_LOG_DIR = path.resolve(PROJECT_ROOT, "logs");
const GLOBAL_LOG_FILE = path.join(GLOBAL_LOG_DIR, "app.log");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for safe use in file names.
 */
function sanitize(value: string, pattern: string): string {
  const regex = new RegExp(pattern, "g");
  return value
    .replace(regex, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

/**
 * Format current timestamp according to the configured pattern.
 */
function formatTimestamp(format: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");

  return format
    .replace("YYYY", now.getFullYear().toString())
    .replace("MM", pad(now.getMonth() + 1))
    .replace("DD", pad(now.getDate()))
    .replace("HH", pad(now.getHours()))
    .replace("mm", pad(now.getMinutes()))
    .replace("ss", pad(now.getSeconds()));
}

/**
 * Replace template variables in a pattern string.
 */
function resolvePattern(pattern: string, vars: Record<string, string>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? key);
}

/**
 * Ensure a directory exists, creating it if necessary.
 */
function ensureDir(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (error) {
    console.error(
      `[session-logger] Failed to create directory ${dirPath}:`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/**
 * Build Pino transport targets for session logging.
 */
function buildTransportTargets(
  sessionLogPath: string | null,
  includeGlobal: boolean
): pino.TransportTargetOptions[] {
  const targets: pino.TransportTargetOptions[] = [];

  // Session-specific file
  if (sessionLogPath) {
    targets.push({
      target: "pino/file",
      options: { destination: sessionLogPath },
      level: env.LOG_LEVEL,
    });
  }

  // Global log file
  if (includeGlobal) {
    ensureDir(GLOBAL_LOG_DIR);
    targets.push({
      target: "pino/file",
      options: { destination: GLOBAL_LOG_FILE },
      level: env.LOG_LEVEL,
    });
  }

  // Console output in development
  if (env.NODE_ENV === "development") {
    targets.push({
      target: "pino/file",
      options: { destination: 1 }, // stdout
      level: env.LOG_LEVEL,
    });
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create a session-specific logger for PR review operations.
 *
 * The logger writes to a dedicated file named based on the PR metadata
 * (e.g., review-workspace-repo-PR123-20260204-143022.log).
 *
 * If session logging is disabled, returns a child of the base logger.
 */
export function createReviewSessionLogger(metadata: ReviewSessionMetadata): Logger {
  const config = loadLoggingConfig();

  const baseContext = {
    service: "supplyhouse-reviewer",
    env: env.NODE_ENV,
    sessionType: "review" as const,
    reviewId: metadata.reviewId,
    workspace: metadata.workspace,
    repoSlug: metadata.repoSlug,
    prNumber: metadata.prNumber,
    ...(metadata.branch && { branch: metadata.branch }),
  };

  // If session logging is disabled, return a simple logger to global file
  if (!config.sessionLogging.enabled || !config.review.enabled) {
    const targets = buildTransportTargets(null, true);
    if (targets.length === 0) {
      // Fallback: just use pino defaults
      return pino({ level: env.LOG_LEVEL, base: baseContext });
    }
    return pino({
      level: env.LOG_LEVEL,
      transport: { targets },
      timestamp: pino.stdTimeFunctions.isoTime,
      base: baseContext,
    });
  }

  // Sanitize metadata for file naming
  const sanitizePattern = config.formatting.sanitizePattern;
  const sanitized: Record<string, string> = {
    workspace: sanitize(metadata.workspace, sanitizePattern),
    repoSlug: sanitize(metadata.repoSlug, sanitizePattern),
    prNumber: String(metadata.prNumber),
    branch: metadata.branch ? sanitize(metadata.branch, sanitizePattern) : "",
    timestamp: formatTimestamp(config.formatting.timestampFormat),
  };

  // Resolve file path
  const fileName = resolvePattern(config.review.filePattern, sanitized);
  const sessionDir = path.resolve(
    PROJECT_ROOT,
    config.sessionLogging.logDirectory,
    config.review.subdirectory
  );

  let sessionLogPath: string | null = null;
  if (ensureDir(sessionDir)) {
    sessionLogPath = path.join(sessionDir, fileName);
  }

  const targets = buildTransportTargets(
    sessionLogPath,
    config.sessionLogging.globalLogEnabled
  );

  if (targets.length === 0) {
    return pino({ level: env.LOG_LEVEL, base: baseContext });
  }

  const logger = pino({
    level: env.LOG_LEVEL,
    transport: { targets },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: baseContext,
  });

  if (sessionLogPath) {
    logger.info({ sessionLogPath }, "Review session log started");
  }

  return logger;
}

/**
 * Create a session-specific logger for repository indexing operations.
 *
 * The logger writes to a dedicated file named based on the repo metadata
 * (e.g., index-workspace_repo-main-20260204-120000.log).
 *
 * If session logging is disabled, returns a child of the base logger.
 */
export function createIndexSessionLogger(metadata: IndexSessionMetadata): Logger {
  const config = loadLoggingConfig();

  const baseContext = {
    service: "supplyhouse-reviewer",
    env: env.NODE_ENV,
    sessionType: "index" as const,
    jobId: metadata.jobId,
    repoId: metadata.repoId,
    branch: metadata.branch,
  };

  // If session logging is disabled, return a simple logger to global file
  if (!config.sessionLogging.enabled || !config.index.enabled) {
    const targets = buildTransportTargets(null, true);
    if (targets.length === 0) {
      return pino({ level: env.LOG_LEVEL, base: baseContext });
    }
    return pino({
      level: env.LOG_LEVEL,
      transport: { targets },
      timestamp: pino.stdTimeFunctions.isoTime,
      base: baseContext,
    });
  }

  // Sanitize metadata for file naming
  const sanitizePattern = config.formatting.sanitizePattern;
  const sanitized: Record<string, string> = {
    repoId: sanitize(metadata.repoId, sanitizePattern),
    branch: sanitize(metadata.branch, sanitizePattern),
    jobId: metadata.jobId,
    timestamp: formatTimestamp(config.formatting.timestampFormat),
  };

  // Resolve file path
  const fileName = resolvePattern(config.index.filePattern, sanitized);
  const sessionDir = path.resolve(
    PROJECT_ROOT,
    config.sessionLogging.logDirectory,
    config.index.subdirectory
  );

  let sessionLogPath: string | null = null;
  if (ensureDir(sessionDir)) {
    sessionLogPath = path.join(sessionDir, fileName);
  }

  const targets = buildTransportTargets(
    sessionLogPath,
    config.sessionLogging.globalLogEnabled
  );

  if (targets.length === 0) {
    return pino({ level: env.LOG_LEVEL, base: baseContext });
  }

  const logger = pino({
    level: env.LOG_LEVEL,
    transport: { targets },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: baseContext,
  });

  if (sessionLogPath) {
    logger.info({ sessionLogPath }, "Index session log started");
  }

  return logger;
}
