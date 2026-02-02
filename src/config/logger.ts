import pino from "pino";
import type { Logger } from "pino";
import { env } from "./env.ts";

const baseLogger: Logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? {
          target: "pino/file",
          options: { destination: 1 },
        }
      : undefined,
  formatters: {
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
