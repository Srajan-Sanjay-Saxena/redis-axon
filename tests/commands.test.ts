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

    it("sets with PX mode (milliseconds)", async () => {
      await handler.set("cmd:px", "milli", "PX", 10000);
      const val = await handler.get("cmd:px");
      expect(val).toBe("milli");
      const ttl = await handler.ttl("cmd:px");
      expect(ttl).toBeGreaterThan(0);
    });

    it("sets with NX flag (only if not exists)", async () => {
      await handler.set("cmd:nx", "first");
      await handler.set("cmd:nx", "second", "NX");
      const val = await handler.get("cmd:nx");
      expect(val).toBe("first"); // NX should not overwrite
    });

    it("sets with XX flag (only if exists)", async () => {
      await handler.set("cmd:xx-exists", "original");
      await handler.set("cmd:xx-exists", "updated", "XX");
      const val = await handler.get("cmd:xx-exists");
      expect(val).toBe("updated");
    });

    it("XX does not set if key missing", async () => {
      await handler.set("cmd:xx-missing", "value", "XX");
      const val = await handler.get("cmd:xx-missing");
      expect(val).toBeNull();
    });

    it("sets with EX + NX combined", async () => {
      await handler.delete("cmd:exnx");
      await handler.set("cmd:exnx", "locked", "EX", 30, "NX");
      const val = await handler.get("cmd:exnx");
      expect(val).toBe("locked");
      const ttl = await handler.ttl("cmd:exnx");
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    });

    it("returns null for non-existent key", async () => {
      const val = await handler.get("cmd:nonexistent");
      expect(val).toBeNull();
    });
  });

  describe("delete", () => {
    it("deletes an existing key", async () => {
      await handler.set("cmd:del", "bye");
      const count = await handler.delete("cmd:del");
      expect(count).toBe(1);
      const val = await handler.get("cmd:del");
      expect(val).toBeNull();
    });

    it("returns 0 when deleting non-existent key", async () => {
      const count = await handler.delete("cmd:nope");
      expect(count).toBe(0);
    });

    it("deletes multiple keys at once", async () => {
      await handler.set("cmd:multi-del-1", "a");
      await handler.set("cmd:multi-del-2", "b");
      await handler.set("cmd:multi-del-3", "c");
      const count = await handler.delete("cmd:multi-del-1", "cmd:multi-del-2", "cmd:multi-del-3");
      expect(count).toBe(3);
    });

    it("returns 0 for empty args", async () => {
      const count = await handler.delete();
      expect(count).toBe(0);
    });
  });

  describe("sadd / srem / smembers", () => {
    it("adds members to a set", async () => {
      await handler.sadd("cmd:set", "a", "b", "c");
      const members = await handler.smembers("cmd:set");
      expect(members.sort()).toEqual(["a", "b", "c"]);
    });

    it("returns count of new members added", async () => {
      await handler.delete("cmd:set-count");
      const added = await handler.sadd("cmd:set-count", "x", "y", "z");
      expect(added).toBe(3);
      const again = await handler.sadd("cmd:set-count", "x", "w");
      expect(again).toBe(1); // only "w" is new
    });

    it("ignores duplicate adds", async () => {
      await handler.delete("cmd:set2");
      await handler.sadd("cmd:set2", "x");
      await handler.sadd("cmd:set2", "x");
      const members = await handler.smembers("cmd:set2");
      expect(members).toEqual(["x"]);
    });

    it("removes members from a set", async () => {
      await handler.delete("cmd:srem");
      await handler.sadd("cmd:srem", "a", "b", "c");
      const removed = await handler.srem("cmd:srem", "a", "c");
      expect(removed).toBe(2);
      const members = await handler.smembers("cmd:srem");
      expect(members).toEqual(["b"]);
    });

    it("returns 0 for empty sadd/srem args", async () => {
      expect(await handler.sadd("cmd:empty")).toBe(0);
      expect(await handler.srem("cmd:empty")).toBe(0);
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
