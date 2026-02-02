export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreakerError extends Error {
  constructor(
    public readonly breakerName: string,
    message?: string,
  ) {
    super(message ?? `Circuit breaker "${breakerName}" is OPEN`);
    this.name = "CircuitBreakerError";
  }
}

interface CircuitBreakerOptions {
  name: string;
  failureThreshold?: number;
  resetTimeout?: number;
  monitorWindow?: number;
}

interface CircuitBreakerStats {
  state: CircuitBreakerState;
  failures: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private failures: number = 0;
  private lastFailure: Date | null = null;
  private lastSuccess: Date | null = null;
  private openedAt: Date | null = null;
  private failureTimestamps: number[] = [];

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly monitorWindow: number;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 30000;
    this.monitorWindow = options.monitorWindow ?? 60000;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    switch (this.state) {
      case "OPEN":
        return this.handleOpen(fn);
      case "HALF_OPEN":
        return this.handleHalfOpen(fn);
      case "CLOSED":
      default:
        return this.handleClosed(fn);
    }
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
    };
  }

  private async handleClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private async handleOpen<T>(fn: () => Promise<T>): Promise<T> {
    if (this.openedAt && Date.now() - this.openedAt.getTime() >= this.resetTimeout) {
      this.transitionTo("HALF_OPEN");
      return this.handleHalfOpen(fn);
    }
    throw new CircuitBreakerError(this.name);
  }

  private async handleHalfOpen<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.onSuccess();
      this.transitionTo("CLOSED");
      return result;
    } catch (error) {
      this.onFailure();
      this.transitionTo("OPEN");
      throw error;
    }
  }

  private onSuccess(): void {
    this.lastSuccess = new Date();
    if (this.state === "CLOSED") {
      this.failures = 0;
      this.failureTimestamps = [];
    }
  }

  private onFailure(): void {
    const now = Date.now();
    this.lastFailure = new Date(now);
    this.failures++;
    this.failureTimestamps.push(now);

    // Remove failures outside the monitor window
    const windowStart = now - this.monitorWindow;
    this.failureTimestamps = this.failureTimestamps.filter((ts) => ts >= windowStart);

    if (this.state === "CLOSED" && this.failureTimestamps.length >= this.failureThreshold) {
      this.transitionTo("OPEN");
    }
  }

  private transitionTo(newState: CircuitBreakerState): void {
    this.state = newState;
    if (newState === "OPEN") {
      this.openedAt = new Date();
    } else if (newState === "CLOSED") {
      this.failures = 0;
      this.failureTimestamps = [];
      this.openedAt = null;
    }
  }
}
