import type { Cluster } from "ioredis";
import type { RedisClusterConnectionHandler } from "@connection/cluster";
import type { HealthCheckResult, HealthCheckStrategy } from "@helper/types.helper";

export class ClusterConnectionHealthStrategy implements HealthCheckStrategy {
  constructor(private handler: RedisClusterConnectionHandler) {}

  async check(): Promise<HealthCheckResult> {
    const timestamp = Date.now();
    const circuitState = this.handler.getCircuitState();

    if (!this.handler.clusterConnection) {
      return { status: "unhealthy", latencyMs: -1, circuitState, connected: false, timestamp };
    }

    return this.ping(this.handler.clusterConnection, circuitState, timestamp);
  }

  private async ping(client: Cluster, circuitState: string, timestamp: number): Promise<HealthCheckResult> {
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
