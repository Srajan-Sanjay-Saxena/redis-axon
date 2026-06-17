import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { RedisSingleConnectionHandler } from "../src/connection/connection";
import { RedisConnectionPoolHandler } from "../src/connection/pool";
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

describe("RedisSingleConnectionHandler", () => {
  let handler: RedisSingleConnectionHandler;

  beforeAll(async () => {
    handler = new RedisSingleConnectionHandler(connOptions);
    await handler.ConnectToService();
  });

  afterAll(() => {
    handler.gracefulShutdown();
  });

  it("establishes a connection", () => {
    expect(handler.redisConnection).not.toBeNull();
    expect(handler.redisConnection!.status).toBe("ready");
  });

  it("can set and get a key", async () => {
    await handler.redisConnection!.set("test:key", "hello");
    const value = await handler.redisConnection!.get("test:key");
    expect(value).toBe("hello");
  });

  it("can delete a key", async () => {
    await handler.redisConnection!.set("test:del", "bye");
    await handler.redisConnection!.del("test:del");
    const value = await handler.redisConnection!.get("test:del");
    expect(value).toBeNull();
  });

  it("can use set operations", async () => {
    await handler.redisConnection!.sadd("test:set", "a", "b", "c");
    const members = await handler.redisConnection!.smembers("test:set");
    expect(members.sort()).toEqual(["a", "b", "c"]);
  });

  it("can incr a key", async () => {
    await handler.redisConnection!.set("test:counter", "0");
    await handler.redisConnection!.incr("test:counter");
    await handler.redisConnection!.incr("test:counter");
    const val = await handler.redisConnection!.get("test:counter");
    expect(val).toBe("2");
  });

  it("can set TTL and retrieve it", async () => {
    await handler.redisConnection!.set("test:ttl", "temp", "EX", 60);
    const ttl = await handler.redisConnection!.ttl("test:ttl");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("fires onReconnect callback after reconnection", async () => {
    let reconnected = false;
    handler.onReconnect(async () => {
      reconnected = true;
    });

    // simulate disconnect — the handler should auto-reconnect
    handler.redisConnection!.disconnect();

    // wait for reconnection
    await new Promise((r) => setTimeout(r, 3000));
    expect(reconnected).toBe(true);
    expect(handler.redisConnection).not.toBeNull();
  });

  it("gracefulShutdown nulls the connection", () => {
    const tempHandler = new RedisSingleConnectionHandler(connOptions);
    tempHandler.gracefulShutdown();
    expect(tempHandler.redisConnection).toBeNull();
  });
});

describe("RedisConnectionPoolHandler", () => {
  let pool: RedisConnectionPoolHandler;

  beforeAll(async () => {
    pool = new RedisConnectionPoolHandler(connOptions, 3);
    await pool.ConnectToService();
  });

  afterAll(() => {
    pool.gracefulShutdown();
  });

  it("establishes pool connections", () => {
    expect(pool.redisConnection).not.toBeNull();
  });

  it("can set and get via pool", async () => {
    await pool.set("pool:key", "world");
    const value = await pool.get("pool:key");
    expect(value).toBe("world");
  });

  it("can set with EX mode", async () => {
    await pool.set("pool:ex", "temp", "EX", 30);
    const ttl = await pool.ttl("pool:ex");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it("can delete via pool", async () => {
    await pool.set("pool:del", "gone");
    const count = await pool.delete("pool:del");
    expect(count).toBe(1);
    const value = await pool.get("pool:del");
    expect(value).toBeNull();
  });

  it("can use set operations via pool", async () => {
    await pool.sadd("pool:set", "x", "y", "z");
    const members = await pool.smembers("pool:set");
    expect(members.sort()).toEqual(["x", "y", "z"]);
  });

  it("can srem via pool", async () => {
    await pool.sadd("pool:srem", "a", "b");
    await pool.srem("pool:srem", "a");
    const members = await pool.smembers("pool:srem");
    expect(members).toEqual(["b"]);
  });

  it("can incr via pool", async () => {
    await pool.set("pool:incr", "5");
    const result = await pool.incr("pool:incr");
    expect(result).toBe(6);
  });

  it("can expire via pool", async () => {
    await pool.set("pool:expire", "val");
    await pool.expire("pool:expire", 10);
    const ttl = await pool.ttl("pool:expire");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
  });

  it("can eval lua scripts via pool", async () => {
    await pool.set("pool:lua", "42");
    const result = await pool.eval("return redis.call('GET', KEYS[1])", ["pool:lua"], []);
    expect(result).toBe("42");
  });

  it("round-robins across connections", async () => {
    // set multiple keys — they should spread across pool connections
    for (let i = 0; i < 10; i++) {
      await pool.set(`pool:rr:${i}`, `val${i}`);
    }
    for (let i = 0; i < 10; i++) {
      const val = await pool.get(`pool:rr:${i}`);
      expect(val).toBe(`val${i}`);
    }
  });

  it("gracefulShutdown clears all connections", () => {
    const tempPool = new RedisConnectionPoolHandler(connOptions, 2);
    tempPool.gracefulShutdown();
    expect(tempPool.redisConnection).toBeNull();
  });
});

describe("CircuitBreaker integration with connection", () => {
  it("reconnects after transient failure", async () => {
    const handler = new RedisSingleConnectionHandler(connOptions, {
      threshold: 2,
      resetTimeout: 500,
      maxResetTimeout: 2000,
    });
    await handler.ConnectToService();
    expect(handler.redisConnection).not.toBeNull();

    // force disconnect
    handler.redisConnection!.disconnect();
    await new Promise((r) => setTimeout(r, 3000));

    // should have auto-reconnected
    expect(handler.redisConnection).not.toBeNull();
    expect(handler.redisConnection!.status).toBe("ready");

    handler.gracefulShutdown();
  });
});
