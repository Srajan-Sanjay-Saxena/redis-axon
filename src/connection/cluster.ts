import { Cluster } from "ioredis";
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
} from "#circuit/circuitBreaker.js";
import { RedisLogger } from "../logger.js";
import type { RedisClusterOptions } from "#helper/types.helper.js";

export interface IRedisClusterConnection {
  clusterConnection: Cluster | null;
  ConnectToService(): Promise<void>;
  onReconnect(cb: () => Promise<void>): void;
  gracefulShutdown(): void;
}

export class RedisClusterConnectionHandler implements IRedisClusterConnection {
  public clusterConnection: Cluster | null = null;
  private breaker: CircuitBreaker;
  private clusterOptions: RedisClusterOptions;
  private logger: RedisLogger;
  private isShuttingDown = false;
  private reconnectCallbacks: (() => Promise<void>)[] = [];

  public constructor(
    clusterOptions: RedisClusterOptions,
    breakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    this.breaker = new CircuitBreaker(breakerOptions);
    this.logger = new RedisLogger();
    this.clusterOptions = clusterOptions;
  }

  public addLogger(logger: RedisLogger): void {
    this.logger = logger;
  }

  public async ConnectToService(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cluster = new Cluster(
        this.clusterOptions.nodes.map((n) => ({ host: n.host, port: n.port })),
        {
          redisOptions: {
            password: this.clusterOptions.password,
            username: this.clusterOptions.username,
            tls: this.clusterOptions.tls,
            commandTimeout: this.clusterOptions.commandTimeout,
            keepAlive: this.clusterOptions.keepAlive,
            connectTimeout: this.clusterOptions.connectTimeout,
            enableReadyCheck: this.clusterOptions.enableReadyCheck ?? true,
          },
          scaleReads: this.clusterOptions.scaleReads ?? "master",
          maxRedirections: this.clusterOptions.maxRedirections ?? 16,
          retryDelayOnFailover: this.clusterOptions.retryDelayOnFailover ?? 300,
          retryDelayOnClusterDown:
            this.clusterOptions.retryDelayOnClusterDown ?? 300,
          retryDelayOnTryAgain: this.clusterOptions.retryDelayOnTryAgain ?? 300,
          slotsRefreshTimeout: this.clusterOptions.slotsRefreshTimeout ?? 5000,
          slotsRefreshInterval:
            this.clusterOptions.slotsRefreshInterval ?? 15000,
          enableAutoPipelining:
            this.clusterOptions.enableAutoPipelining ?? false,
          clusterRetryStrategy: () => null, // circuit breaker owns reconnection
          natMap: this.clusterOptions.natMap,
        },
      );

      cluster.once("ready", () => {
        this.clusterConnection = cluster;
        this.logger.info("Cluster connection ready", "ClusterConnection");
        resolve();
      });
      cluster.once("error", (err) => {
        this.logger.error("Cluster connection error", "ClusterConnection", {
          err,
        });
        reject(err);
      });
      cluster.on("close", () => {
        this.logger.warn("Cluster connection closed", "ClusterConnection");
        this.clusterConnection = null;
        if (!this.isShuttingDown) this.Reconnect();
      });
      cluster.on("node error", (err, address) => {
        this.logger.warn("Cluster node error", "ClusterConnection", {
          err,
          address,
        });
      });
    });
  }

  private async Reconnect(): Promise<void> {
    if (!this.breaker.canAttempt()) {
      this.logger.warn(
        "Reconnect blocked by circuit breaker",
        "ClusterConnection",
        {
          circuitState: this.breaker.getState(),
        },
      );
      this.breaker.scheduleProbe(() => this.Reconnect());
      return;
    }

    const delay = this.breaker.getBackoffDelay(
      this.breaker.consecutiveFailures,
      30000,
    );
    this.logger.info("Attempting cluster reconnect", "ClusterConnection", {
      attempt: this.breaker.consecutiveFailures + 1,
      delayMs: delay,
      circuitState: this.breaker.getState(),
    });

    await new Promise((r) => setTimeout(r, delay));

    try {
      await this.ConnectToService();
      this.breaker.recordSuccess();
      this.logger.info("Cluster reconnected successfully", "ClusterConnection");
      for (const cb of this.reconnectCallbacks) await cb();
    } catch (err) {
      this.breaker.recordFailure();
      this.logger.error(
        "Cluster reconnect attempt failed",
        "ClusterConnection",
        {
          attempt: this.breaker.consecutiveFailures,
          circuitState: this.breaker.getState(),
          err,
        },
      );
      if (this.breaker.getState() === "OPEN") {
        this.logger.warn(
          "Circuit opened — pausing reconnect",
          "ClusterConnection",
        );
        this.breaker.scheduleProbe(() => this.Reconnect());
      } else {
        await this.Reconnect();
      }
    }
  }

  public onReconnect(cb: () => Promise<void>): void {
    this.reconnectCallbacks.push(cb);
  }

  public gracefulShutdown(): void {
    this.isShuttingDown = true;
    this.breaker.reset();
    this.clusterConnection?.disconnect();
    this.clusterConnection = null;
    this.logger.info("Cluster connection shut down", "ClusterConnection");
  }

  // --- BASIC KEY-VALUE ---

  public async set(
    key: string,
    value: string,
    mode?: "EX",
    duration?: number,
  ): Promise<void> {
    if (!this.clusterConnection) throw new Error("Cluster not connected");
    if (mode === "EX" && duration) {
      await this.clusterConnection.set(key, value, mode, duration);
    } else {
      await this.clusterConnection.set(key, value);
    }
  }

  public async get(key: string): Promise<string | null> {
    if (!this.clusterConnection) throw new Error("Cluster not connected");
    return this.clusterConnection.get(key);
  }

  public async delete(key: string): Promise<void> {
    if (!this.clusterConnection) throw new Error("Cluster not connected");
    await this.clusterConnection.del(key);
  }

  // --- SET OPERATIONS ---

  public async sadd(key: string, value: string): Promise<void> {
    if (!this.clusterConnection) throw new Error("Cluster not connected");
    await this.clusterConnection.sadd(key, value);
  }

  public async srem(key: string, value: string): Promise<void> {
    if (!this.clusterConnection) throw new Error("Cluster not connected");
    await this.clusterConnection.srem(key, value);
  }

  public async smembers(key: string): Promise<string[]> {
    if (!this.clusterConnection) throw new Error("Cluster not connected");
    return this.clusterConnection.smembers(key);
  }

  // --- UTILITY ---

  public async expire(key: string, seconds: number): Promise<void> {
    if (!this.clusterConnection) throw new Error("Cluster not connected");
    await this.clusterConnection.expire(key, seconds);
  }

  public async incr(key: string): Promise<number> {
    if (!this.clusterConnection) throw new Error("Cluster not connected");
    return this.clusterConnection.incr(key);
  }

  public async ttl(key: string): Promise<number> {
    if (!this.clusterConnection) throw new Error("Cluster not connected");
    return this.clusterConnection.ttl(key);
  }

  public async eval(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<unknown> {
    if (!this.clusterConnection) throw new Error("Cluster not connected");
    return this.clusterConnection.eval(script, keys.length, ...keys, ...args);
  }
}
