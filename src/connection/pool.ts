import type { Redis } from "ioredis";
import {
  type IRedisConnection,
  RedisSingleConnectionHandler,
} from "./connection.js";
import { RedisLogger } from "../logger.js";
import type { RedisConnectionObjectOptions } from "#helper/types.helper.js";
import type { CircuitBreakerOptions } from "#circuit/circuitBreaker.js";

export class RedisConnectionPoolHandler implements IRedisConnection {
  private connections: RedisSingleConnectionHandler[] = [];
  private roundRobinIndex = 0;
  private poolSize: number;
  private connOptions: RedisConnectionObjectOptions;
  private breakerOptions?: Partial<CircuitBreakerOptions>;
  private logger: RedisLogger;

  public constructor(
    connOptions: RedisConnectionObjectOptions,
    poolSize: number = 3,
    breakerOptions?: Partial<CircuitBreakerOptions>,
  ) {
    this.connOptions = connOptions;
    this.poolSize = poolSize;
    this.breakerOptions = breakerOptions;
    this.logger = new RedisLogger();
  }

  public addLogger(logger: RedisLogger): void {
    this.logger = logger;
    for (const conn of this.connections) conn.addLogger(logger);
  }

  public async ConnectToService(): Promise<void> {
    this.logger.info("Initializing connection pool", "ConnectionPool", {
      size: this.poolSize,
    });
    for (let i = 0; i < this.poolSize; i++) {
      const conn = new RedisSingleConnectionHandler(
        this.connOptions,
        this.breakerOptions,
      );
      conn.addLogger(this.logger);
      await conn.ConnectToService();
      this.connections.push(conn);

      conn.onReconnect(async () => {
        this.logger.debug("Connection reconnected in pool", "ConnectionPool", {
          index: i,
        });
      });

      this.logger.debug("Connection added to pool", "ConnectionPool", {
        index: i,
      });
    }
    this.logger.info("Connection pool ready", "ConnectionPool", {
      size: this.poolSize,
    });
  }

  // round-robins across active connections
  private acquire(): RedisSingleConnectionHandler {
    if (this.connections.length === 0)
      throw new Error("[ConnectionPool] No connections available");
    const total = this.connections.length;
    for (let i = 0; i < total; i++) {
      const index = this.roundRobinIndex % total;
      this.roundRobinIndex++;
      const conn = this.connections[index];
      if (conn.redisConnection) return conn;
      this.logger.warn(
        "Skipping dropped connection during round-robin",
        "ConnectionPool",
        { index },
      );
    }
    throw new Error("[ConnectionPool] No active connections available");
  }

  public get redisConnection(): Redis | null {
    try {
      return this.acquire().redisConnection;
    } catch {
      return null;
    }
  }

  private async run<T>(fn: (client: Redis) => Promise<T>): Promise<T> {
    const conn = this.acquire();
    if (!conn.redisConnection)
      throw new Error("[ConnectionPool] No active connection");
    return fn(conn.redisConnection);
  }

  public onReconnect(cb: () => Promise<void>): void {
    for (const conn of this.connections) conn.onReconnect(cb);
  }

  public gracefulShutdown(): void {
    this.logger.info("Shutting down connection pool", "ConnectionPool", {
      size: this.connections.length,
    });
    for (const conn of this.connections) conn.gracefulShutdown();
    this.connections = [];
    this.roundRobinIndex = 0;
    this.logger.info("Connection pool shut down", "ConnectionPool");
  }

  // --- BASIC KEY-VALUE ---

  public async set(
    key: string,
    value: string,
    mode?: "EX",
    duration?: number,
  ): Promise<void> {
    await this.run((c) =>
      mode === "EX" && duration
        ? c.set(key, value, mode, duration)
        : c.set(key, value),
    );
  }

  public async get(key: string): Promise<string | null> {
    return this.run((c) => c.get(key));
  }

  public async delete(key: string): Promise<void> {
    await this.run((c) => c.del(key));
  }

  // --- SET OPERATIONS ---

  public async sadd(key: string, value: string): Promise<void> {
    await this.run((c) => c.sadd(key, value));
  }

  public async srem(key: string, value: string): Promise<void> {
    await this.run((c) => c.srem(key, value));
  }

  public async smembers(key: string): Promise<string[]> {
    return this.run((c) => c.smembers(key));
  }

  // --- UTILITY ---

  public async expire(key: string, seconds: number): Promise<void> {
    await this.run((c) => c.expire(key, seconds));
  }

  public async incr(key: string): Promise<number> {
    return this.run((c) => c.incr(key));
  }

  public async ttl(key: string): Promise<number> {
    return this.run((c) => c.ttl(key));
  }

  public async eval(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<unknown> {
    return this.run((c) => c.eval(script, keys.length, ...keys, ...args));
  }
}
