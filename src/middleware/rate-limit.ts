/**
 * Simple in-memory rate limiter for the API.
 *
 * Uses a sliding window counter per IP address. Requests that exceed the
 * limit receive a 429 response with a Retry-After header.
 */

import { createLogger } from "../config/logger.ts";

const log = createLogger("rate-limit");

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const store = new Map<string, RateLimitEntry>();

/** Periodically clean stale entries to prevent memory leaks. */
const CLEANUP_INTERVAL_MS = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.windowStart > CLEANUP_INTERVAL_MS * 2) {
      store.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);

interface RateLimitOptions {
  /** Maximum number of requests per window. */
  maxRequests?: number;
  /** Window size in milliseconds. */
  windowMs?: number;
}

/**
 * Rate limiting middleware for Elysia.
 *
 * Returns `null` when the request is allowed, or a Response-like object
 * when the limit has been exceeded.
 */
export function checkRateLimit(
  ip: string,
  options?: RateLimitOptions,
): { limited: true; retryAfter: number } | null {
  const maxRequests = options?.maxRequests ?? 100;
  const windowMs = options?.windowMs ?? 60_000;
  const now = Date.now();

  let entry = store.get(ip);

  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { count: 1, windowStart: now };
    store.set(ip, entry);
    return null;
  }

  entry.count++;

  if (entry.count > maxRequests) {
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    log.warn({ ip, count: entry.count, maxRequests }, "Rate limit exceeded");
    return { limited: true, retryAfter };
  }

  return null;
}
