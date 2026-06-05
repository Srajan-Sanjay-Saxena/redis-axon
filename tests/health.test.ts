import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { RedisSingleConnectionHandler } from "@connection/connection";
import { RedisConnectionPoolHandler } from "@connection/pool";
import { RedisHealthCheck } from "@health/health";
import type { RedisConnectionObjectOptions } from "@helper/types.helper";

let container: StartedRedisContainer;
let connOptions: RedisConnectionObjectOptions;

beforeAll(async () => {
  container = await new RedisContainer("redis:7-alpine").start();
  connOptions = {
    host: container.getHost(),
    port: container.getPort(),
    password: "",
  } as RedisConnectionObjectOptions;
}, 60_000);

afterAll(async () => {
  await container?.stop();
});

describe("RedisHealthCheck with SingleConnection", () => {
  let handler: RedisSingleConnectionHandler;
  let healthCheck: RedisHealthCheck;

  beforeAll(async () => {
    handler = new RedisSingleConnectionHandler(connOptions);
    await handler.ConnectToService();
    healthCheck = RedisHealthCheck.forSingle(handler);
  });

  afterAll(() => {
    handler.gracefulShutdown();
  });

  it("returns healthy when connected", async () => {
    const result = await healthCheck.check();
    expect(result.status).toBe("healthy");
    expect(result.connected).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.circuitState).toBe("CLOSED");
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it("isHealthy returns true when connected", async () => {
    const ok = await healthCheck.isHealthy();
    expect(ok).toBe(true);
  });

  it("returns unhealthy after shutdown", async () => {
    const tempHandler = new RedisSingleConnectionHandler(connOptions);
    await tempHandler.ConnectToService();
    const tempHealth = RedisHealthCheck.forSingle(tempHandler);

    tempHandler.gracefulShutdown();

    const result = await tempHealth.check();
    expect(result.status).toBe("unhealthy");
    expect(result.connected).toBe(false);
    expect(result.latencyMs).toBe(-1);
  });

  it("isHealthy returns false after shutdown", async () => {
    const tempHandler = new RedisSingleConnectionHandler(connOptions);
    await tempHandler.ConnectToService();
    const tempHealth = RedisHealthCheck.forSingle(tempHandler);

    tempHandler.gracefulShutdown();

    const ok = await tempHealth.isHealthy();
    expect(ok).toBe(false);
  });

  it("latencyMs is a reasonable number", async () => {
    const result = await healthCheck.check();
    expect(result.latencyMs).toBeLessThan(1000); // PING to local container should be <1s
  });

  it("timestamp is current", async () => {
    const before = Date.now();
    const result = await healthCheck.check();
    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });
});

describe("RedisHealthCheck with ConnectionPool", () => {
  let pool: RedisConnectionPoolHandler;
  let healthCheck: RedisHealthCheck;

  beforeAll(async () => {
    pool = new RedisConnectionPoolHandler(connOptions, 3);
    await pool.ConnectToService();
    healthCheck = RedisHealthCheck.forPool(pool);
  });

  afterAll(() => {
    pool.gracefulShutdown();
  });

  it("returns healthy when pool is connected", async () => {
    const result = await healthCheck.check();
    expect(result.status).toBe("healthy");
    expect(result.connected).toBe(true);
    expect(result.circuitState).toContain("CLOSED");
  });

  it("isHealthy returns true for healthy pool", async () => {
    const ok = await healthCheck.isHealthy();
    expect(ok).toBe(true);
  });

  it("returns unhealthy after pool shutdown", async () => {
    const tempPool = new RedisConnectionPoolHandler(connOptions, 2);
    await tempPool.ConnectToService();
    const tempHealth = RedisHealthCheck.forPool(tempPool);

    tempPool.gracefulShutdown();

    const result = await tempHealth.check();
    expect(result.status).toBe("unhealthy");
    expect(result.connected).toBe(false);
  });
});
