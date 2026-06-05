import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CircuitBreaker } from "../src/circuit/circuitBreaker"

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker({
      threshold: 3,
      resetTimeout: 1000,
      maxResetTimeout: 8000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    breaker.reset();
  });

  describe("initial state", () => {
    it("starts in CLOSED state", () => {
      expect(breaker.getState()).toBe("CLOSED");
    });

    it("starts with 0 consecutive failures", () => {
      expect(breaker.consecutiveFailures).toBe(0);
    });

    it("allows attempts when CLOSED", () => {
      expect(breaker.canAttempt()).toBe(true);
    });
  });

  describe("recordFailure", () => {
    it("increments consecutive failures", () => {
      breaker.recordFailure();
      expect(breaker.consecutiveFailures).toBe(1);
    });

    it("stays CLOSED below threshold", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe("CLOSED");
      expect(breaker.canAttempt()).toBe(true);
    });

    it("opens circuit at threshold", () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.getState()).toBe("OPEN");
      expect(breaker.canAttempt()).toBe(false);
    });
  });

  describe("recordSuccess", () => {
    it("resets consecutive failures to 0", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();
      expect(breaker.consecutiveFailures).toBe(0);
    });

    it("transitions to CLOSED from any state", () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.getState()).toBe("OPEN");
      breaker.recordSuccess();
      expect(breaker.getState()).toBe("CLOSED");
    });
  });

  describe("scheduleProbe", () => {
    it("does nothing if state is not OPEN", () => {
      const cb = vi.fn();
      breaker.scheduleProbe(cb);
      vi.advanceTimersByTime(10000);
      expect(cb).not.toHaveBeenCalled();
    });

    it("transitions to HALF_OPEN after resetTimeout when OPEN", () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.getState()).toBe("OPEN");

      const cb = vi.fn();
      breaker.scheduleProbe(cb);
      vi.advanceTimersByTime(1000);

      expect(breaker.getState()).toBe("HALF_OPEN");
      expect(cb).toHaveBeenCalledOnce();
      expect(breaker.canAttempt()).toBe(true);
    });

    it("doubles resetTimeout each time probe fires", () => {
      // first open
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      const cb1 = vi.fn();
      breaker.scheduleProbe(cb1);
      vi.advanceTimersByTime(1000); // fires at 1000ms
      expect(cb1).toHaveBeenCalledOnce();

      // fail again in HALF_OPEN → opens again
      breaker.recordFailure();
      expect(breaker.getState()).toBe("OPEN");

      const cb2 = vi.fn();
      breaker.scheduleProbe(cb2);
      vi.advanceTimersByTime(1999);
      expect(cb2).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); // fires at 2000ms
      expect(cb2).toHaveBeenCalledOnce();
    });

    it("caps resetTimeout at maxResetTimeout", () => {
      // drive resetTimeout to max: 1000 → 2000 → 4000 → 8000 → capped at 8000
      for (let doublings = 0; doublings < 5; doublings++) {
        for (let i = 0; i < 3; i++) breaker.recordFailure();
        const cb = vi.fn();
        breaker.scheduleProbe(cb);
        vi.advanceTimersByTime(8000);
        if (!cb.mock.calls.length) continue;
        breaker.recordFailure(); // re-open
      }
      // after capping, next probe should still fire at 8000ms max
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      const finalCb = vi.fn();
      breaker.scheduleProbe(finalCb);
      vi.advanceTimersByTime(8000);
      expect(finalCb).toHaveBeenCalledOnce();
    });
  });

  describe("clearProbeTimer", () => {
    it("cancels a scheduled probe", () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      const cb = vi.fn();
      breaker.scheduleProbe(cb);
      breaker.clearProbeTimer();
      vi.advanceTimersByTime(10000);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("getBackoffDelay", () => {
    it("returns a value between 0 and exponential cap", () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const delay = breaker.getBackoffDelay(attempt, 30000);
        const expectedMax = Math.min(1000 * 2 ** attempt, 30000);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(expectedMax);
      }
    });

    it("respects maxInterval cap", () => {
      const delay = breaker.getBackoffDelay(100, 5000);
      expect(delay).toBeLessThanOrEqual(5000);
    });
  });

  describe("reset", () => {
    it("resets all state to initial values", () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      breaker.scheduleProbe(vi.fn());
      breaker.reset();

      expect(breaker.getState()).toBe("CLOSED");
      expect(breaker.consecutiveFailures).toBe(0);
      expect(breaker.canAttempt()).toBe(true);
    });
  });

  describe("HALF_OPEN behavior", () => {
    it("single failure in HALF_OPEN immediately opens circuit", () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      breaker.scheduleProbe(vi.fn());
      vi.advanceTimersByTime(1000);
      expect(breaker.getState()).toBe("HALF_OPEN");

      breaker.recordFailure();
      expect(breaker.getState()).toBe("OPEN");
    });
  });
});
