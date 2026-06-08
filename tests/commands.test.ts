import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { RedisSingleConnectionHandler } from "@connection/connection";
import { RedisClusterConnectionHandler } from "@connection/cluster";
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

describe("RedisCommandHandler (via SingleConnection)", () => {
  let handler: RedisSingleConnectionHandler;

  beforeAll(async () => {
    handler = new RedisSingleConnectionHandler(connOptions);
    await handler.ConnectToService();
  });

  afterAll(() => {
    handler.gracefulShutdown();
  });

  describe("set / get", () => {
    it("sets and gets a value", async () => {
      await handler.set("cmd:key1", "hello");
      const val = await handler.get("cmd:key1");
      expect(val).toBe("hello");
    });

    it("sets with EX mode and respects TTL", async () => {
      await handler.set("cmd:ex", "temp", "EX", 10);
      const val = await handler.get("cmd:ex");
      expect(val).toBe("temp");
      const ttl = await handler.ttl("cmd:ex");
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);
    });

    it("returns null for non-existent key", async () => {
      const val = await handler.get("cmd:nonexistent");
      expect(val).toBeNull();
    });
  });

  describe("delete", () => {
    it("deletes an existing key", async () => {
      await handler.set("cmd:del", "bye");
      await handler.delete("cmd:del");
      const val = await handler.get("cmd:del");
      expect(val).toBeNull();
    });

    it("does not throw when deleting non-existent key", async () => {
      await expect(handler.delete("cmd:nope")).resolves.toBeUndefined();
    });
  });

  describe("sadd / srem / smembers", () => {
    it("adds members to a set", async () => {
      await handler.sadd("cmd:set", "a");
      await handler.sadd("cmd:set", "b");
      await handler.sadd("cmd:set", "c");
      const members = await handler.smembers("cmd:set");
      expect(members.sort()).toEqual(["a", "b", "c"]);
    });

    it("ignores duplicate adds", async () => {
      await handler.sadd("cmd:set2", "x");
      await handler.sadd("cmd:set2", "x");
      const members = await handler.smembers("cmd:set2");
      expect(members).toEqual(["x"]);
    });

    it("removes a member from a set", async () => {
      await handler.sadd("cmd:srem", "a");
      await handler.sadd("cmd:srem", "b");
      await handler.srem("cmd:srem", "a");
      const members = await handler.smembers("cmd:srem");
      expect(members).toEqual(["b"]);
    });

    it("returns empty array for non-existent set", async () => {
      const members = await handler.smembers("cmd:noset");
      expect(members).toEqual([]);
    });
  });

  describe("expire / ttl", () => {
    it("sets expiry on an existing key", async () => {
      await handler.set("cmd:expire", "val");
      await handler.expire("cmd:expire", 30);
      const ttl = await handler.ttl("cmd:expire");
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    });

    it("ttl returns -1 for key with no expiry", async () => {
      await handler.set("cmd:noexpiry", "forever");
      const ttl = await handler.ttl("cmd:noexpiry");
      expect(ttl).toBe(-1);
    });

    it("ttl returns -2 for non-existent key", async () => {
      const ttl = await handler.ttl("cmd:ghost");
      expect(ttl).toBe(-2);
    });
  });

  describe("incr", () => {
    it("increments an existing numeric key", async () => {
      await handler.set("cmd:counter", "5");
      const result = await handler.incr("cmd:counter");
      expect(result).toBe(6);
    });

    it("initializes to 1 when key does not exist", async () => {
      const result = await handler.incr("cmd:newcounter");
      expect(result).toBe(1);
    });

    it("increments multiple times correctly", async () => {
      await handler.incr("cmd:multi");
      await handler.incr("cmd:multi");
      const result = await handler.incr("cmd:multi");
      expect(result).toBe(3);
    });
  });

  describe("eval", () => {
    it("executes a lua script that returns a value", async () => {
      await handler.set("cmd:lua", "42");
      const result = await handler.eval(
        "return redis.call('GET', KEYS[1])",
        ["cmd:lua"],
        [],
      );
      expect(result).toBe("42");
    });

    it("executes a lua script with args", async () => {
      const result = await handler.eval(
        "redis.call('SET', KEYS[1], ARGV[1]); return redis.call('GET', KEYS[1])",
        ["cmd:luaset"],
        ["hello-lua"],
      );
      expect(result).toBe("hello-lua");
    });

    it("executes atomic compare-and-delete", async () => {
      await handler.set("cmd:lock", "owner1");
      // should delete because value matches
      const deleted = await handler.eval(
        `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`,
        ["cmd:lock"],
        ["owner1"],
      );
      expect(deleted).toBe(1);
      const val = await handler.get("cmd:lock");
      expect(val).toBeNull();
    });

    it("atomic compare-and-delete fails when value mismatches", async () => {
      await handler.set("cmd:lock2", "owner1");
      const deleted = await handler.eval(
        `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`,
        ["cmd:lock2"],
        ["wrong-owner"],
      );
      expect(deleted).toBe(0);
      const val = await handler.get("cmd:lock2");
      expect(val).toBe("owner1");
    });
  });

  describe("throws when not connected", () => {
    it("throws on set when disconnected", async () => {
      const temp = new RedisSingleConnectionHandler(connOptions);
      // never called ConnectToService
      await expect(temp.set("x", "y")).rejects.toThrow("Not connected");
    });

    it("throws on get when disconnected", async () => {
      const temp = new RedisSingleConnectionHandler(connOptions);
      await expect(temp.get("x")).rejects.toThrow("Not connected");
    });

    it("throws on incr when disconnected", async () => {
      const temp = new RedisSingleConnectionHandler(connOptions);
      await expect(temp.incr("x")).rejects.toThrow("Not connected");
    });
  });
});

describe("RedisClusterConnectionHandler", () => {
  it("throws when commands are called without connection", async () => {
    const cluster = new RedisClusterConnectionHandler({
      nodes: [{ host: "localhost", port: 9999 }],
    });
    await expect(cluster.set("x", "y")).rejects.toThrow("Not connected");
    await expect(cluster.get("x")).rejects.toThrow("Not connected");
    await expect(cluster.delete("x")).rejects.toThrow("Not connected");
    await expect(cluster.sadd("x", "y")).rejects.toThrow("Not connected");
    await expect(cluster.srem("x", "y")).rejects.toThrow("Not connected");
    await expect(cluster.smembers("x")).rejects.toThrow("Not connected");
    await expect(cluster.expire("x", 10)).rejects.toThrow("Not connected");
    await expect(cluster.incr("x")).rejects.toThrow("Not connected");
    await expect(cluster.ttl("x")).rejects.toThrow("Not connected");
    await expect(cluster.eval("return 1", [], [])).rejects.toThrow("Not connected");
  });

  it("getCircuitState returns CLOSED initially", () => {
    const cluster = new RedisClusterConnectionHandler({
      nodes: [{ host: "localhost", port: 9999 }],
    });
    expect(cluster.getCircuitState()).toBe("CLOSED");
  });

  it("gracefulShutdown nulls clusterConnection", () => {
    const cluster = new RedisClusterConnectionHandler({
      nodes: [{ host: "localhost", port: 9999 }],
    });
    cluster.gracefulShutdown();
    expect(cluster.clusterConnection).toBeNull();
  });
});
