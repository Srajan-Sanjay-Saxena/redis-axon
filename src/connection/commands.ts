import type { Redis, Cluster } from "ioredis";

export type RedisClient = Redis | Cluster;

export abstract class RedisCommandHandler {
  protected abstract getClient(): RedisClient;

  async set(key: string, value: string, mode?: "EX", duration?: number): Promise<void> {
    mode === "EX" && duration
      ? await this.getClient().set(key, value, mode, duration)
      : await this.getClient().set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.getClient().get(key);
  }

  async delete(key: string): Promise<void> {
    await this.getClient().del(key);
  }

  async sadd(key: string, value: string): Promise<void> {
    await this.getClient().sadd(key, value);
  }

  async srem(key: string, value: string): Promise<void> {
    await this.getClient().srem(key, value);
  }

  async smembers(key: string): Promise<string[]> {
    return this.getClient().smembers(key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.getClient().expire(key, seconds);
  }

  async incr(key: string): Promise<number> {
    return this.getClient().incr(key);
  }

  async ttl(key: string): Promise<number> {
    return this.getClient().ttl(key);
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.getClient().eval(script, keys.length, ...keys, ...args);
  }
}
