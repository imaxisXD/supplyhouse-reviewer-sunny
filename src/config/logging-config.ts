/**
 * Logging configuration loader with Zod validation.
 *
 * Loads session logging settings from logging.config.json with sensible defaults.
 */

import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const sessionLoggingSchema = z.object({
  enabled: z.boolean().default(true),
  logDirectory: z.string().default("logs/sessions"),
  globalLogEnabled: z.boolean().default(true),
});

const reviewLoggingSchema = z.object({
  enabled: z.boolean().default(true),
  filePattern: z.string().default("review-{workspace}-{repoSlug}-PR{prNumber}-{timestamp}.log"),
  subdirectory: z.string().default("reviews"),
});

const indexLoggingSchema = z.object({
  enabled: z.boolean().default(true),
  filePattern: z.string().default("index-{repoId}-{branch}-{timestamp}.log"),
  subdirectory: z.string().default("indexing"),
});

const formattingSchema = z.object({
  timestampFormat: z.string().default("YYYYMMDD-HHmmss"),
  sanitizePattern: z.string().default("[^a-zA-Z0-9-_]"),
});

export const loggingConfigSchema = z.object({
  sessionLogging: sessionLoggingSchema.default({
    enabled: true,
    logDirectory: "logs/sessions",
    globalLogEnabled: true,
  }),
  review: reviewLoggingSchema.default({
    enabled: true,
    filePattern: "review-{workspace}-{repoSlug}-PR{prNumber}-{timestamp}.log",
    subdirectory: "reviews",
  }),
  index: indexLoggingSchema.default({
    enabled: true,
    filePattern: "index-{repoId}-{branch}-{timestamp}.log",
    subdirectory: "indexing",
  }),
  formatting: formattingSchema.default({
    timestampFormat: "YYYYMMDD-HHmmss",
    sanitizePattern: "[^a-zA-Z0-9-_]",
  }),
});

export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.resolve(import.meta.dir, "logging.config.json");

let cachedConfig: LoggingConfig | null = null;

/**
 * Load the logging configuration from disk.
 *
 * - Reads from src/config/logging.config.json
 * - Validates with Zod schema
 * - Returns sensible defaults if file is missing or invalid
 * - Caches result after first load
 */
export function loadLoggingConfig(): LoggingConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      cachedConfig = loggingConfigSchema.parse(parsed);
    } else {
      // Use defaults if config file doesn't exist
      cachedConfig = loggingConfigSchema.parse({});
    }
  } catch (error) {
    console.warn(
      `[logging-config] Failed to load logging config from ${CONFIG_PATH}, using defaults:`,
      error instanceof Error ? error.message : String(error)
    );
    cachedConfig = loggingConfigSchema.parse({});
  }

  return cachedConfig;
}

/**
 * Clear the cached config (useful for testing or hot-reloading).
 */
export function clearLoggingConfigCache(): void {
  cachedConfig = null;
}
