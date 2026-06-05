import { Redis } from "ioredis";
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
} from "#circuit/circuitBreaker.js";
import { RedisLogger } from "../logger.js";
import type { RedisConnectionObjectOptions } from "#helper/types.helper.js";

export interface IRedisConnection {
  redisConnection: Redis | null;
  ConnectToService(): Promise<void>;
  onReconnect(cb: () => Promise<void>): void;
  gracefulShutdown(): void;
}

export class RedisSingleConnectionHandler implements IRedisConnection {
  public redisConnection: Redis | null = null;
  private breaker: CircuitBreaker;
  private connOptions: RedisConnectionObjectOptions;
  private logger: RedisLogger;
  private isShuttingDown = false;
  private reconnectCallbacks: (() => Promise<void>)[] = [];

  public constructor(
    connOptions: RedisConnectionObjectOptions,
    breakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    this.breaker = new CircuitBreaker(breakerOptions);
    this.logger = new RedisLogger();
    this.connOptions = {
      ...connOptions,
      host: connOptions.host ?? "localhost",
      port: connOptions.port ?? 6379,
    };
  }

  public addLogger(logger: RedisLogger): void {
    this.logger = logger;
  }

  public async ConnectToService(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Redis({
        ...this.connOptions,
        retryStrategy: () => null, // circuit breaker owns reconnection
        lazyConnect: false,
      });

      client.once("ready", () => {
        this.redisConnection = client;
        this.logger.info("Connection ready", "SingleConnection");
        resolve();
      });
      client.once("error", (err) => {
        this.logger.error("Connection error", "SingleConnection", { err });
        reject(err);
      });
      client.on("close", () => {
        this.logger.warn("Connection closed", "SingleConnection");
        this.redisConnection = null;
        if (!this.isShuttingDown) this.Reconnect();
      });
    });
  }

  private async Reconnect(): Promise<void> {
   if (!this.breaker.canAttempt()) return;


    const delay = this.breaker.getBackoffDelay(
      this.breaker.consecutiveFailures,
      30000,
    );
    this.logger.info("Attempting reconnect", "SingleConnection", {
      attempt: this.breaker.consecutiveFailures + 1,
      delayMs: delay,
      circuitState: this.breaker.getState(),
    });

    await new Promise((r) => setTimeout(r, delay));

    try {
      await this.ConnectToService();
      this.breaker.recordSuccess();
      this.logger.info("Reconnected successfully", "SingleConnection", {
        attempt: this.breaker.consecutiveFailures,
      });
      for (const cb of this.reconnectCallbacks) await cb();
    } catch (err) {
      this.breaker.recordFailure();
      this.logger.error("Reconnect attempt failed", "SingleConnection", {
        attempt: this.breaker.consecutiveFailures,
        circuitState: this.breaker.getState(),
        err,
      })
       if (this.breaker.getState() === "OPEN") {
        this.logger.warn(
          "Circuit opened — pausing reconnect",
          "SingleConnection",
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
    this.redisConnection?.disconnect();
    this.redisConnection = null;
    this.logger.info("Connection shut down", "SingleConnection");
  }
}
