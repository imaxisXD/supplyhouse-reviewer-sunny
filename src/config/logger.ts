import pino from "pino";
import type { Logger } from "pino";
import * as fs from "fs";
import * as path from "path";
import { env } from "./env.ts";

// Ensure logs directory exists
const LOG_DIR = path.resolve(import.meta.dir, "../../logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "app.log");

const useTransport = env.NODE_ENV === "development";

const baseLogger: Logger = pino({
  level: env.LOG_LEVEL,
  transport: useTransport
    ? {
        targets: [
          // stdout — so you still see logs in terminal
          { target: "pino/file", options: { destination: 1 }, level: env.LOG_LEVEL },
          // persistent log file
          { target: "pino/file", options: { destination: LOG_FILE }, level: env.LOG_LEVEL },
        ],
      }
    : undefined,
  // Pino does not allow custom level formatters with transport targets.
  formatters: useTransport
    ? undefined
    : {
        level(label) {
          return { level: label };
        },
      },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: "supplyhouse-reviewer",
    env: env.NODE_ENV,
  },
});

/**
 * Create a child logger scoped to a specific component.
 *
 * @param component - The name of the component (e.g. "api", "queue", "bitbucket")
 * @returns A pino child logger with the component name bound
 */
export function createLogger(component: string): Logger {
  return baseLogger.child({ component });
}

/**
 * Create a child logger that also carries a traceId for request correlation.
 *
 * @param component - The name of the component
 * @param traceId  - A unique identifier to correlate log lines across a single request
 * @returns A pino child logger with both component and traceId bound
 */
export function createTracedLogger(
  component: string,
  traceId: string,
): Logger {
  return baseLogger.child({ component, traceId });
}

export { baseLogger };
