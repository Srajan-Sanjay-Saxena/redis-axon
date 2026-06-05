export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  threshold: number;      // consecutive failures before opening — default 5
  resetTimeout: number;   // ms to wait in OPEN before probing — default 30000
  maxResetTimeout: number; // cap on how much resetTimeout can double — default 300000 (5min)
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  public consecutiveFailures = 0;
  private currentResetTimeout: number;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  public readonly options: CircuitBreakerOptions;

  public constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = {
      threshold: options.threshold ?? 5,
      resetTimeout: options.resetTimeout ?? 30000,
      maxResetTimeout: options.maxResetTimeout ?? 300000,
    };
    this.currentResetTimeout = this.options.resetTimeout;
  }

  public getState(): CircuitState {
    return this.state;
  }

  // should Reconnect() even attempt a connection right now?
  public canAttempt(): boolean {
    return this.state === "CLOSED" || this.state === "HALF_OPEN";
  }

  // exponential backoff delay with full jitter — capped at maxInterval
  // full jitter: random(0, min(1000 * 2^attempt, maxInterval))
  // prevents thundering herd — multiple services won't retry at the exact same time
  public getBackoffDelay(attempt: number, maxInterval: number): number {
    const exponential = Math.min(1000 * 2 ** attempt, maxInterval);
    return Math.floor(Math.random() * exponential);
  }

  // called when a connect attempt succeeds
  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.currentResetTimeout = this.options.resetTimeout; // reset the doubling
    this.state = "CLOSED";
    this.clearProbeTimer();
  }

  // called when a connect attempt fails
  public recordFailure(): void {
    this.consecutiveFailures++;
    if (this.state === "HALF_OPEN" || this.consecutiveFailures >= this.options.threshold) {
      this.state = "OPEN";
    }
  }

  // after resetTimeout, transition to HALF_OPEN and fire the probe callback
  public scheduleProbe(onProbe: () => void): void {
    if (this.state !== "OPEN") return;
    this.clearProbeTimer();
    this.probeTimer = setTimeout(() => {
      this.state = "HALF_OPEN";
      // double the resetTimeout for next failure — capped at maxResetTimeout
      this.currentResetTimeout = Math.min(
        this.currentResetTimeout * 2,
        this.options.maxResetTimeout,
      );
      onProbe();
    }, this.currentResetTimeout);
  }

  public clearProbeTimer(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  // full reset — used on graceful shutdown
  public reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.currentResetTimeout = this.options.resetTimeout;
    this.clearProbeTimer();
  }
}
