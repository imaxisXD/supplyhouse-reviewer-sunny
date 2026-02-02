import { describe, it, expect } from "bun:test";
import { CircuitBreaker, CircuitBreakerError } from "../utils/circuit-breaker.ts";

function makeBreaker(
  failureThreshold = 3,
  resetTimeout = 100,
  monitorWindow = 60_000,
) {
  return new CircuitBreaker({
    name: "test-breaker",
    failureThreshold,
    resetTimeout,
    monitorWindow,
  });
}

const succeed = () => Promise.resolve("ok");
const fail = () => Promise.reject(new Error("boom"));

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("CircuitBreaker - initial state", () => {
  it("starts in CLOSED state", () => {
    const breaker = makeBreaker();
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("reports zero failures initially", () => {
    const breaker = makeBreaker();
    const stats = breaker.getStats();
    expect(stats.failures).toBe(0);
    expect(stats.lastFailure).toBeNull();
    expect(stats.lastSuccess).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLOSED -> OPEN transition
// ---------------------------------------------------------------------------

describe("CircuitBreaker - CLOSED to OPEN", () => {
  it("stays CLOSED if failures are below threshold", async () => {
    const breaker = makeBreaker(3);
    // Fail twice (threshold is 3)
    for (let i = 0; i < 2; i++) {
      try {
        await breaker.execute(fail);
      } catch {
        // expected
      }
    }
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("transitions to OPEN after reaching the failure threshold", async () => {
    const breaker = makeBreaker(3);
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(fail);
      } catch {
        // expected
      }
    }
    expect(breaker.getState()).toBe("OPEN");
  });

  it("passes through successful calls while CLOSED", async () => {
    const breaker = makeBreaker();
    const result = await breaker.execute(succeed);
    expect(result).toBe("ok");
    expect(breaker.getState()).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// OPEN state behavior
// ---------------------------------------------------------------------------

describe("CircuitBreaker - OPEN state", () => {
  it("fast-rejects calls without invoking the function", async () => {
    const breaker = makeBreaker(2, 5000); // long timeout so it stays OPEN
    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      try {
        await breaker.execute(fail);
      } catch {
        // expected
      }
    }
    expect(breaker.getState()).toBe("OPEN");

    let fnCalled = false;
    try {
      await breaker.execute(async () => {
        fnCalled = true;
        return "should not run";
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitBreakerError);
      expect((error as CircuitBreakerError).breakerName).toBe("test-breaker");
    }
    expect(fnCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OPEN -> HALF_OPEN transition
// ---------------------------------------------------------------------------

describe("CircuitBreaker - OPEN to HALF_OPEN", () => {
  it("transitions to HALF_OPEN after the reset timeout", async () => {
    const breaker = makeBreaker(2, 100); // 100ms reset timeout
    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      try {
        await breaker.execute(fail);
      } catch {
        // expected
      }
    }
    expect(breaker.getState()).toBe("OPEN");

    // Wait for the reset timeout to elapse
    await new Promise((r) => setTimeout(r, 150));

    // The next call should trigger HALF_OPEN internally.
    // A successful call should transition back to CLOSED.
    const result = await breaker.execute(succeed);
    expect(result).toBe("ok");
    expect(breaker.getState()).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------
// HALF_OPEN -> CLOSED (success)
// ---------------------------------------------------------------------------

describe("CircuitBreaker - HALF_OPEN to CLOSED on success", () => {
  it("returns to CLOSED after a successful call in HALF_OPEN", async () => {
    const breaker = makeBreaker(2, 100);
    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      try {
        await breaker.execute(fail);
      } catch {
        // expected
      }
    }
    expect(breaker.getState()).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 150));

    // Successful call in HALF_OPEN
    await breaker.execute(succeed);
    expect(breaker.getState()).toBe("CLOSED");

    // Verify failures reset
    const stats = breaker.getStats();
    expect(stats.failures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HALF_OPEN -> OPEN (failure)
// ---------------------------------------------------------------------------

describe("CircuitBreaker - HALF_OPEN to OPEN on failure", () => {
  it("returns to OPEN if the call fails in HALF_OPEN", async () => {
    const breaker = makeBreaker(2, 100);
    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      try {
        await breaker.execute(fail);
      } catch {
        // expected
      }
    }
    expect(breaker.getState()).toBe("OPEN");

    await new Promise((r) => setTimeout(r, 150));

    // Failing call in HALF_OPEN should go back to OPEN
    try {
      await breaker.execute(fail);
    } catch {
      // expected
    }
    expect(breaker.getState()).toBe("OPEN");
  });
});

// ---------------------------------------------------------------------------
// Stats tracking
// ---------------------------------------------------------------------------

describe("CircuitBreaker - stats", () => {
  it("tracks lastSuccess after a successful call", async () => {
    const breaker = makeBreaker();
    await breaker.execute(succeed);
    const stats = breaker.getStats();
    expect(stats.lastSuccess).toBeInstanceOf(Date);
  });

  it("tracks lastFailure after a failed call", async () => {
    const breaker = makeBreaker();
    try {
      await breaker.execute(fail);
    } catch {
      // expected
    }
    const stats = breaker.getStats();
    expect(stats.lastFailure).toBeInstanceOf(Date);
    expect(stats.failures).toBe(1);
  });
});
