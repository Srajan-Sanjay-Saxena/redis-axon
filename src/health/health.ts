import type { RedisSingleConnectionHandler } from "@connection/connection";
import type { RedisConnectionPoolHandler } from "@connection/pool";
import type { RedisClusterConnectionHandler } from "@connection/cluster";
import type { HealthCheckResult, HealthCheckStrategy } from "@helper/types.helper";
import { SingleConnectionHealthStrategy } from "@health/single.strategy";
import { PoolConnectionHealthStrategy } from "@health/pool.strategy";
import { ClusterConnectionHealthStrategy } from "@health/cluster.strategy";

export type { HealthCheckResult, HealthCheckStrategy };

export class RedisHealthCheck {
  private strategy: HealthCheckStrategy;

  private constructor(strategy: HealthCheckStrategy) {
    this.strategy = strategy;
  }

  public static forSingle(handler: RedisSingleConnectionHandler): RedisHealthCheck {
    return new RedisHealthCheck(new SingleConnectionHealthStrategy(handler));
  }

  public static forPool(handler: RedisConnectionPoolHandler): RedisHealthCheck {
    return new RedisHealthCheck(new PoolConnectionHealthStrategy(handler));
  }

  public static forCluster(handler: RedisClusterConnectionHandler): RedisHealthCheck {
    return new RedisHealthCheck(new ClusterConnectionHealthStrategy(handler));
  }

  public async check(): Promise<HealthCheckResult> {
    return this.strategy.check();
  }

  public async isHealthy(): Promise<boolean> {
    const result = await this.check();
    return result.status === "healthy";
  }
}
