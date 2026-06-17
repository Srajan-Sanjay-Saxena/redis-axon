import type { Redis, Cluster } from "ioredis";

export type RedisClient = Redis | Cluster;

/**
 * Expiry mode for the SET command.
 * - `"EX"` — expire in seconds
 * - `"PX"` — expire in milliseconds
 * - `"EXAT"` — expire at unix timestamp (seconds)
 * - `"PXAT"` — expire at unix timestamp (milliseconds)
 * - `"KEEPTTL"` — retain the existing TTL on overwrite
 */
export type SetMode = "EX" | "PX" | "EXAT" | "PXAT" | "KEEPTTL";

/**
 * Conditional flag for the SET command.
 * - `"NX"` — only set if key does NOT exist (create-only)
 * - `"XX"` — only set if key DOES exist (update-only)
 */
export type SetFlag = "NX" | "XX";

/**
 * Abstract base class providing Redis commands. All connection handlers
 * (Single, Pool, Cluster) extend this class and implement `getClient()`.
 *
 * Every command throws if the underlying client is not connected.
 */
export abstract class RedisCommandHandler {
  protected abstract getClient(): RedisClient;

  /**
   * Store a string value under a key.
   *
   * @param key - The Redis key name.
   * @param value - The string value to store.
   * @param options - Optional combination of expiry mode + duration and/or conditional flag.
   *
   * Valid option patterns:
   * - `()` — set with no expiry, no condition
   * - `("EX", 60)` — expire in 60 seconds
   * - `("PX", 5000)` — expire in 5000 milliseconds
   * - `("EXAT", 1718000000)` — expire at specific unix timestamp (seconds)
   * - `("PXAT", 1718000000000)` — expire at specific unix timestamp (ms)
   * - `("KEEPTTL")` — keep existing TTL when overwriting
   * - `("NX")` — only set if key doesn't exist
   * - `("XX")` — only set if key exists
   * - `("EX", 60, "NX")` — expire in 60s AND only if key doesn't exist
   * - `("NX", "EX", 60)` — same as above, order doesn't matter
   */
  async set(
    key: string,
    value: string,
    ...options: [] | [SetMode, number] | [SetFlag] | [SetMode, number, SetFlag] | [SetFlag, SetMode, number]
  ): Promise<void> {
    const args: (string | number)[] = [key, value];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (opt === "NX" || opt === "XX") {
        args.push(opt);
      } else if (opt === "KEEPTTL") {
        args.push(opt);
      } else if (opt === "EX" || opt === "PX" || opt === "EXAT" || opt === "PXAT") {
        args.push(opt, options[++i] as number);
      }
    }
    await (this.getClient() as Redis).call("SET", ...args);
  }

  /**
   * Retrieve the value stored at a key.
   *
   * @param key - The key to look up.
   * @returns The value, or `null` if the key doesn't exist or has expired.
   */
  async get(key: string): Promise<string | null> {
    return this.getClient().get(key);
  }

  /**
   * Delete one or more keys.
   *
   * @param keys - One or more keys to delete.
   * @returns The number of keys that were actually deleted (0 if none existed).
   */
  async delete(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.getClient().del(...keys);
  }

  /**
   * Add one or more members to a Redis Set.
   *
   * @param key - The set key.
   * @param members - One or more members to add. Duplicates are ignored by Redis.
   * @returns The number of members that were newly added (not already in the set).
   */
  async sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.getClient().sadd(key, ...members);
  }

  /**
   * Remove one or more members from a Redis Set.
   *
   * @param key - The set key.
   * @param members - One or more members to remove.
   * @returns The number of members that were actually removed (0 if none were in the set).
   */
  async srem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.getClient().srem(key, ...members);
  }

  /**
   * Get all members of a Redis Set.
   *
   * @param key - The set key.
   * @returns Array of all members, or empty array if key doesn't exist.
   */
  async smembers(key: string): Promise<string[]> {
    return this.getClient().smembers(key);
  }

  /**
   * Set a time-to-live on an existing key. The key is deleted after TTL expires.
   *
   * @param key - The key to set TTL on.
   * @param seconds - TTL in seconds.
   */
  async expire(key: string, seconds: number): Promise<void> {
    await this.getClient().expire(key, seconds);
  }

  /**
   * Atomically increment a key's integer value by 1.
   * If the key doesn't exist, it's initialized to 0 before incrementing.
   *
   * @param key - The key to increment.
   * @returns The value after incrementing.
   */
  async incr(key: string): Promise<number> {
    return this.getClient().incr(key);
  }

  /**
   * Get the remaining time-to-live of a key.
   *
   * @param key - The key to check.
   * @returns Seconds remaining, `-1` if key has no expiry, `-2` if key doesn't exist.
   */
  async ttl(key: string): Promise<number> {
    return this.getClient().ttl(key);
  }

  /**
   * Execute a Lua script atomically on the Redis server.
   *
   * @param script - Lua source code. Access keys via `KEYS[1]`, `KEYS[2]`, etc.
   *                 Access args via `ARGV[1]`, `ARGV[2]`, etc.
   * @param keys - Redis keys the script will access.
   * @param args - Additional arguments passed to the script.
   * @returns Whatever the Lua script returns.
   */
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.getClient().eval(script, keys.length, ...keys, ...args);
  }
}
