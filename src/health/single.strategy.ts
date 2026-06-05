import type { Redis } from "ioredis";
import type { RedisSingleConnectionHandler } from "@connection/connection";
import type { HealthCheckResult, HealthCheckStrategy } from "@helper/types.helper";

export class SingleConnectionHealthStrategy implements HealthCheckStrategy {
  constructor(private handler: RedisSingleConnectionHandler) {}

  async check(): Promise<HealthCheckResult> {
    const timestamp = Date.now();
    const circuitState = this.handler.getCircuitState();

    if (!this.handler.redisConnection) {
      return { status: "unhealthy", latencyMs: -1, circuitState, connected: false, timestamp };
    }

    return this.ping(this.handler.redisConnection, circuitState, timestamp);
  }

  private async ping(client: Redis, circuitState: string, timestamp: number): Promise<HealthCheckResult> {
    const start = performance.now();
    try {
      await client.ping();
      const latencyMs = Math.round((performance.now() - start) * 100) / 100;
      const status = circuitState === "CLOSED" ? "healthy" : "degraded";
      return { status, latencyMs, circuitState, connected: true, timestamp };
    } catch {
      const latencyMs = Math.round((performance.now() - start) * 100) / 100;
      return { status: "unhealthy", latencyMs, circuitState, connected: false, timestamp };
    }
  }
}
