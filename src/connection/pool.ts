import type { Redis } from "ioredis";
import {
  type IRedisConnection,
  RedisSingleConnectionHandler,
} from "@connection/connection";
import { RedisLogger } from "@log/logger";
import type { RedisConnectionObjectOptions } from "@helper/types.helper";
import type { CircuitBreakerOptions } from "@circuit/circuitBreaker";
import { RedisCommandHandler, type RedisClient } from "@connection/commands";

export class RedisConnectionPoolHandler
  extends RedisCommandHandler
  implements IRedisConnection
{
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
    private readonly warmup: boolean = true,
  ) {
    super();
    this.connOptions = connOptions;
    this.poolSize = poolSize;
    this.breakerOptions = breakerOptions;
    this.logger = new RedisLogger();
  }

  protected getClient(): RedisClient {
    const conn = this.acquire();
    if (!conn.redisConnection)
      throw new Error("[ConnectionPool] No active connection");
    return conn.redisConnection;
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
        this.warmup,
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

  public getCircuitState(): string {
    return this.connections
      .map((c, i) => `[${i}]:${c.getCircuitState()}`)
      .join(", ");
  }
}
