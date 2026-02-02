import { describe, it, expect } from "bun:test";
import { checkRateLimit } from "../middleware/rate-limit.ts";

// Use a unique IP prefix per test to avoid cross-test contamination from the
// shared in-memory store.
let ipCounter = 0;
function uniqueIp(): string {
  return `10.0.0.${++ipCounter}`;
}

// ---------------------------------------------------------------------------
// Requests under the limit
// ---------------------------------------------------------------------------

describe("checkRateLimit - under limit", () => {
  it("allows the first request", () => {
    const ip = uniqueIp();
    const result = checkRateLimit(ip, { maxRequests: 5, windowMs: 60_000 });
    expect(result).toBeNull();
  });

  it("allows requests up to the max", () => {
    const ip = uniqueIp();
    const opts = { maxRequests: 5, windowMs: 60_000 };
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit(ip, opts);
      expect(result).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Requests over the limit
// ---------------------------------------------------------------------------

describe("checkRateLimit - over limit", () => {
  it("blocks requests that exceed the limit", () => {
    const ip = uniqueIp();
    const opts = { maxRequests: 3, windowMs: 60_000 };
    // First 3 should pass
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(ip, opts)).toBeNull();
    }
    // 4th should be limited
    const result = checkRateLimit(ip, opts);
    expect(result).not.toBeNull();
    expect(result!.limited).toBe(true);
  });

  it("continues blocking subsequent requests", () => {
    const ip = uniqueIp();
    const opts = { maxRequests: 2, windowMs: 60_000 };
    checkRateLimit(ip, opts); // 1
    checkRateLimit(ip, opts); // 2
    expect(checkRateLimit(ip, opts)!.limited).toBe(true); // 3 - blocked
    expect(checkRateLimit(ip, opts)!.limited).toBe(true); // 4 - still blocked
  });
});

// ---------------------------------------------------------------------------
// retryAfter
// ---------------------------------------------------------------------------

describe("checkRateLimit - retryAfter", () => {
  it("returns a positive retryAfter value when limited", () => {
    const ip = uniqueIp();
    const opts = { maxRequests: 1, windowMs: 30_000 };
    checkRateLimit(ip, opts); // 1 - allowed
    const result = checkRateLimit(ip, opts); // 2 - blocked
    expect(result).not.toBeNull();
    expect(result!.retryAfter).toBeGreaterThan(0);
    // retryAfter is in seconds, with a 30s window it should be <= 30
    expect(result!.retryAfter).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// Independent IP tracking
// ---------------------------------------------------------------------------

describe("checkRateLimit - independent IPs", () => {
  it("tracks different IPs independently", () => {
    const ip1 = uniqueIp();
    const ip2 = uniqueIp();
    const opts = { maxRequests: 2, windowMs: 60_000 };

    // Exhaust IP1's allowance
    checkRateLimit(ip1, opts);
    checkRateLimit(ip1, opts);
    const blocked = checkRateLimit(ip1, opts);
    expect(blocked).not.toBeNull();
    expect(blocked!.limited).toBe(true);

    // IP2 should still be allowed
    const result = checkRateLimit(ip2, opts);
    expect(result).toBeNull();
  });

  it("does not leak state between different IPs", () => {
    const ipA = uniqueIp();
    const ipB = uniqueIp();
    const opts = { maxRequests: 1, windowMs: 60_000 };

    checkRateLimit(ipA, opts); // 1 allowed
    expect(checkRateLimit(ipA, opts)!.limited).toBe(true); // blocked

    // ipB should be independently allowed
    expect(checkRateLimit(ipB, opts)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

describe("checkRateLimit - defaults", () => {
  it("uses default options when none are provided", () => {
    const ip = uniqueIp();
    // Default is maxRequests=100, windowMs=60_000
    const result = checkRateLimit(ip);
    expect(result).toBeNull();
  });
});
