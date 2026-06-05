# redis-axon

A resilient Redis client library with built-in circuit breaker, automatic reconnection with exponential backoff, connection pooling, and Redis Cluster support.

Built on top of [ioredis](https://github.com/redis/ioredis).

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Connection Modes](#connection-modes)
  - [Single Connection](#single-connection)
  - [Connection Pool](#connection-pool)
  - [Cluster](#cluster)
- [Circuit Breaker](#circuit-breaker)
  - [How It Works](#how-it-works)
  - [Options](#circuit-breaker-options)
  - [State Diagram](#state-diagram)
- [Connection Options](#connection-options)
  - [Single/Pool Options](#singlepool-options)
  - [Cluster Options](#cluster-options)
- [API Reference](#api-reference)
  - [Commands](#commands)
  - [Lifecycle Methods](#lifecycle-methods)
- [Connection Warmup](#connection-warmup)
- [Health Check](#health-check)
- [Reconnection Behavior](#reconnection-behavior)
- [Logging](#logging)
- [Testing](#testing)
- [Examples](#examples)

---

## Installation

```bash
pnpm add redis-axon
```

Requires Node.js >= 18.

---

## Quick Start

```typescript
import { RedisSingleConnectionHandler } from "redis-axon/connection/connection.js";

const redis = new RedisSingleConnectionHandler({
  host: "localhost",
  port: 6379,
  password: "your-password",
});

await redis.ConnectToService();

// use it
await redis.redisConnection!.set("hello", "world");
const value = await redis.redisConnection!.get("hello");
console.log(value); // "world"

// when done
redis.gracefulShutdown();
```

---

## Connection Modes

### Single Connection

One TCP connection to one Redis server. Use this for simple setups, local dev, or low-throughput services.

```typescript
import { RedisSingleConnectionHandler } from "redis-axon/connection/connection.js";

const redis = new RedisSingleConnectionHandler(
  // connection options (required)
  {
    host: "redis.example.com",
    port: 6379,
    password: "your-password",
  },
  // circuit breaker options (optional)
  {
    threshold: 5,
    resetTimeout: 30000,
    maxResetTimeout: 300000,
  },
  // warmup (optional, default true)
  true
);

await redis.ConnectToService();
```

---

### Connection Pool

Multiple TCP connections to the same Redis server, with round-robin load balancing. Use this for high-throughput services where one connection becomes a bottleneck.

```typescript
import { RedisConnectionPoolHandler } from "redis-axon/connection/pool.js";

const pool = new RedisConnectionPoolHandler(
  // connection options (required)
  {
    host: "redis.example.com",
    port: 6379,
    password: "your-password",
  },
  // pool size (optional, default 3)
  5,
  // circuit breaker options (optional — applied to each connection individually)
  {
    threshold: 5,
    resetTimeout: 30000,
    maxResetTimeout: 300000,
  },
  // warmup (optional, default true)
  true
);

await pool.ConnectToService();

// commands are automatically routed to healthy connections via round-robin
await pool.set("key", "value");
const val = await pool.get("key");
```

**How round-robin works:**

Each command call picks the next connection in the pool. If a connection is dead (dropped/reconnecting), it's skipped. If ALL connections are dead, an error is thrown.

```
Request 1 → Connection 0
Request 2 → Connection 1
Request 3 → Connection 2
Request 4 → Connection 0 (wraps around)
Request 5 → Connection 1 is dead → skipped → Connection 2
```

---

### Cluster

Connects to a Redis Cluster (multiple masters, each owning a subset of 16384 hash slots). ioredis handles slot routing, MOVED/ASK redirections, and failover automatically.

```typescript
import { RedisClusterConnectionHandler } from "redis-axon/connection/cluster.js";

const cluster = new RedisClusterConnectionHandler(
  // cluster options (required)
  {
    nodes: [
      { host: "redis-node-1", port: 6379 },
      { host: "redis-node-2", port: 6379 },
      { host: "redis-node-3", port: 6379 },
    ],
    password: "your-password",
    scaleReads: "slave",
    enableAutoPipelining: true,
  },
  // circuit breaker options (optional)
  {
    threshold: 5,
    resetTimeout: 30000,
    maxResetTimeout: 300000,
  },
  // warmup (optional, default true)
  true
);

await cluster.ConnectToService();

await cluster.set("key", "value", "EX", 60);
const val = await cluster.get("key");
```

**When to use Cluster vs Pool:**

| Scenario | Use |
|----------|-----|
| Single Redis instance, need more throughput | Pool |
| Data doesn't fit in one server's RAM | Cluster |
| Need high availability with auto-failover | Cluster |
| Simple app, one Redis, low traffic | Single |

---

## Circuit Breaker

### How It Works

The circuit breaker prevents your application from hammering a dead Redis server with reconnection attempts. It sits between your code and the connection layer.

**Without circuit breaker:**
```
Connection dies → reconnect immediately → fails → reconnect immediately → fails → reconnect immediately → ...
(floods the network, burns CPU, logs fill up)
```

**With circuit breaker:**
```
Connection dies → reconnect → fails → reconnect → fails (threshold hit) → 
STOP for 30s → try once → fails → STOP for 60s → try once → fails → 
STOP for 120s → try once → succeeds → resume normal operation
```

### State Diagram

```
                    ┌──────────────────────────────────┐
                    │                                  │
                    ▼                                  │
              ┌──────────┐                            │
              │  CLOSED  │ ← success ─────────────────┤
              └──────────┘                            │
                    │                                  │
          failure × threshold                         │
                    │                                  │
                    ▼                                  │
              ┌──────────┐        resetTimeout        │
              │   OPEN   │ ─────────────────────► ┌───┴──────┐
              └──────────┘                        │ HALF_OPEN │
                    ▲                             └───────────┘
                    │                                  │
                    └────────── failure ───────────────┘
```

- **CLOSED** — everything is fine. Connections proceed normally.
- **OPEN** — too many consecutive failures. All connection attempts are blocked. A probe timer is scheduled.
- **HALF_OPEN** — probe timer fired. One single connection attempt is allowed. If it succeeds → CLOSED. If it fails → back to OPEN with a doubled wait time.

### Circuit Breaker Options

```typescript
interface CircuitBreakerOptions {
  threshold: number;
  resetTimeout: number;
  maxResetTimeout: number;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `threshold` | `number` | `5` | Number of consecutive failures before the circuit opens. Lower = more sensitive (opens faster). Higher = more tolerant of transient blips. |
| `resetTimeout` | `number` | `30000` | Milliseconds to wait in OPEN state before allowing a probe attempt. This is the initial wait time — it doubles after each failed probe. |
| `maxResetTimeout` | `number` | `300000` | Maximum cap on the doubling resetTimeout (in ms). Prevents the wait from growing infinitely. Default is 5 minutes. |

**Doubling sequence example (default values):**

```
Failure 1-5: circuit stays CLOSED, reconnecting immediately with backoff
Failure 5:   circuit OPENS
Wait 30s  → probe → fails → OPEN
Wait 60s  → probe → fails → OPEN
Wait 120s → probe → fails → OPEN
Wait 240s → probe → fails → OPEN
Wait 300s → probe → fails → OPEN  (capped at maxResetTimeout)
Wait 300s → probe → succeeds → CLOSED (everything resets)
```

**Choosing values:**

- Low-latency app that can't tolerate 30s of downtime? Use `resetTimeout: 5000`
- Redis is on a flaky network that goes down for minutes at a time? Use `threshold: 3, resetTimeout: 10000`
- Serverless function that cold-starts often? Use `threshold: 10` to be more tolerant

---

## Connection Options

### Single/Pool Options

```typescript
interface RedisConnectionObjectOptions {
  host: string;
  port: number;
  password: string;
  username?: string;
  tls?: {
    rejectUnauthorized: boolean;
    ca?: string;
  };
  commandTimeout?: number;
  keepAlive?: number;
  connectTimeout?: number;
  enableAutoPipelining?: boolean;
  enableReadyCheck?: boolean;
  maxRetriesPerRequest?: number;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | `"localhost"` | Redis server hostname or IP address. Can be a private IP, public domain, or ElastiCache endpoint. |
| `port` | `number` | `6379` | TCP port Redis is listening on. ElastiCache with TLS typically uses `6380`. |
| `password` | `string` | — | AUTH password. Sent immediately after TCP connect. Required if Redis has `requirepass` set. |
| `username` | `string` | — | ACL username (Redis 6+). If your Redis uses ACLs, provide the username here. Combined with password for `AUTH <username> <password>`. |
| `tls` | `object` | — | TLS configuration. If provided, the connection uses TLS encryption. Required for ElastiCache in-transit encryption. |
| `tls.rejectUnauthorized` | `boolean` | — | If `true`, verifies the server certificate against trusted CAs. Set to `false` only for self-signed certs in development. **Never set to `false` in production.** |
| `tls.ca` | `string` | — | Custom CA certificate (PEM string). Used when Redis has a certificate signed by a private CA not in the system trust store. |
| `commandTimeout` | `number` | — | Maximum milliseconds to wait for a command response. If Redis takes longer (e.g. a slow `KEYS *`), the command rejects with a timeout error. Prevents hanging. |
| `keepAlive` | `number` | — | TCP keepalive interval in milliseconds. Sends periodic probes to detect silently dead connections. Without this, a dead connection isn't detected until the next command times out. Recommended: `10000` (10 seconds). |
| `connectTimeout` | `number` | — | Maximum milliseconds to wait for the initial TCP connection (handshake + AUTH). If Redis is unreachable, fail fast instead of hanging. Recommended: `5000`. |
| `enableAutoPipelining` | `boolean` | — | Automatically batches commands issued in the same event loop tick into a single pipeline. Free throughput improvement — no code changes needed. Recommended: `true` for high-throughput apps. |
| `enableReadyCheck` | `boolean` | — | After connecting, sends `INFO` to verify Redis is ready (not still loading data from disk). Prevents sending commands to a loading Redis. Recommended: `true`. |
| `maxRetriesPerRequest` | `number` | — | How many times ioredis retries a single failed command. Set to `0` if you want failed commands to reject immediately (let your application logic handle retries). |

**Full example with all options:**

```typescript
const redis = new RedisSingleConnectionHandler({
  host: "redis.example.com",
  port: 6380,
  password: "your-password",
  username: "app-user",
  tls: {
    rejectUnauthorized: true,
    ca: fs.readFileSync("/path/to/ca.pem", "utf8"),
  },
  commandTimeout: 3000,
  keepAlive: 10000,
  connectTimeout: 5000,
  enableAutoPipelining: true,
  enableReadyCheck: true,
  maxRetriesPerRequest: 0,
});
```

**Minimal example (local dev):**

```typescript
const redis = new RedisSingleConnectionHandler({
  host: "localhost",
  port: 6379,
  password: "",
});
```

---

### Cluster Options

```typescript
interface RedisClusterOptions {
  nodes: RedisClusterNode[];
  password?: string;
  username?: string;
  tls?: {
    rejectUnauthorized: boolean;
    ca?: string;
  };
  scaleReads?: "master" | "slave" | "all";
  maxRedirections?: number;
  retryDelayOnFailover?: number;
  retryDelayOnClusterDown?: number;
  retryDelayOnTryAgain?: number;
  slotsRefreshTimeout?: number;
  slotsRefreshInterval?: number;
  enableAutoPipelining?: boolean;
  enableReadyCheck?: boolean;
  commandTimeout?: number;
  keepAlive?: number;
  connectTimeout?: number;
  natMap?: Record<string, { host: string; port: number }>;
}

interface RedisClusterNode {
  host: string;
  port: number;
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `nodes` | `RedisClusterNode[]` | — | **Required.** Seed nodes for cluster discovery. You don't need to list ALL nodes — ioredis discovers the full topology from any seed node. But list 2-3 for redundancy in case one seed is down at startup. |
| `password` | `string` | — | AUTH password. Applied to ALL nodes (cluster-wide). Every node in a Redis Cluster must have the same password. |
| `username` | `string` | — | ACL username (Redis 6+). Applied to all nodes. |
| `tls` | `object` | — | TLS config applied to every node connection. The entire cluster must be TLS or non-TLS — you can't mix. |
| `scaleReads` | `string` | `"master"` | Where to route read commands. See [Scale Reads](#scale-reads) section below. |
| `maxRedirections` | `number` | `16` | Maximum MOVED/ASK redirections to follow before failing. If you hit 16 redirections, something is broken (bad slot map, infinite loop). |
| `retryDelayOnFailover` | `number` | `300` | Milliseconds to wait before retrying a command during a failover (master died, replica being promoted). Gives the cluster time to elect a new master. |
| `retryDelayOnClusterDown` | `number` | `300` | Milliseconds to wait when cluster responds with `CLUSTERDOWN` (not all slots covered). Retries until cluster self-heals. |
| `retryDelayOnTryAgain` | `number` | `300` | Milliseconds to wait when cluster responds with `TRYAGAIN` (multi-key command during slot migration). Rare in practice. |
| `slotsRefreshTimeout` | `number` | `5000` | Max milliseconds to wait for `CLUSTER SLOTS` response when refreshing topology. Prevents hanging on a slow node. |
| `slotsRefreshInterval` | `number` | `15000` | How often (ms) to proactively refresh the slot→node mapping. Catches topology changes (new nodes, rebalancing) even without MOVED errors. |
| `enableAutoPipelining` | `boolean` | `false` | Batch commands per-node in the same tick. In cluster mode, commands are grouped by target node, then pipelined per-node. |
| `enableReadyCheck` | `boolean` | `true` | Send `INFO` to each node after connecting to verify it's ready. |
| `commandTimeout` | `number` | — | Max ms to wait for any command response from any node. |
| `keepAlive` | `number` | — | TCP keepalive for each node connection. |
| `connectTimeout` | `number` | — | Max ms to wait for TCP connect to each node. |
| `natMap` | `object` | — | Network Address Translation mapping. See [NAT Map](#nat-map) section below. |

#### Scale Reads

Redis Cluster has masters (handle writes + reads) and replicas (copies of masters, handle reads only).

```typescript
// All reads go to master — strongest consistency, higher load on masters
{ scaleReads: "master" }

// Reads go to replicas — offloads masters, but replicas might be slightly behind
{ scaleReads: "slave" }

// Reads go to any node — best throughput, weakest consistency
{ scaleReads: "all" }
```

**When to use `"slave"`:**
- Read-heavy workloads (90% reads, 10% writes)
- You can tolerate reading slightly stale data (ms-level lag typically)
- You want to free up master CPU for writes

**When to use `"master"`:**
- You need strong consistency (read-after-write must return the written value)
- Your cluster has few replicas
- Write-heavy workload (masters aren't bottlenecked on reads anyway)

#### NAT Map

When running Redis Cluster behind NAT (Docker, Kubernetes, or VPN), nodes advertise their internal IPs. But your app connects from outside that network.

**The problem:**
```
Your app → connects to localhost:7000 (seed node)
Cluster says: "Slot 5000 lives at 172.17.0.3:6379"  (internal Docker IP)
Your app → tries to connect to 172.17.0.3:6379 → UNREACHABLE
```

**The fix:**
```typescript
const cluster = new RedisClusterConnectionHandler({
  nodes: [{ host: "localhost", port: 7000 }],
  natMap: {
    "172.17.0.2:6379": { host: "localhost", port: 7000 },
    "172.17.0.3:6379": { host: "localhost", port: 7001 },
    "172.17.0.4:6379": { host: "localhost", port: 7002 },
  },
});
```

Now when ioredis gets a `MOVED` redirect to `172.17.0.3:6379`, it translates it to `localhost:7001` before connecting.

**Full cluster example:**

```typescript
const cluster = new RedisClusterConnectionHandler(
  {
    nodes: [
      { host: "redis-1.example.com", port: 6379 },
      { host: "redis-2.example.com", port: 6379 },
      { host: "redis-3.example.com", port: 6379 },
    ],
    password: "your-password",
    tls: { rejectUnauthorized: true },
    scaleReads: "slave",
    maxRedirections: 16,
    retryDelayOnFailover: 500,
    retryDelayOnClusterDown: 500,
    slotsRefreshInterval: 10000,
    enableAutoPipelining: true,
    enableReadyCheck: true,
    keepAlive: 10000,
    connectTimeout: 5000,
    commandTimeout: 3000,
  },
  {
    threshold: 5,
    resetTimeout: 30000,
    maxResetTimeout: 300000,
  }
);

await cluster.ConnectToService();
```

---

## API Reference

### Commands

All three connection modes (Single, Pool, Cluster) expose the same commands:

| Method | Signature | Description |
|--------|-----------|-------------|
| `set` | `set(key, value, mode?, duration?)` | Set a key. Optionally pass `"EX"` mode with duration in seconds for auto-expiry. |
| `get` | `get(key)` → `string \| null` | Get a key's value. Returns `null` if key doesn't exist. |
| `delete` | `delete(key)` | Delete a key. |
| `sadd` | `sadd(key, value)` | Add a member to a set. |
| `srem` | `srem(key, value)` | Remove a member from a set. |
| `smembers` | `smembers(key)` → `string[]` | Get all members of a set. |
| `expire` | `expire(key, seconds)` | Set a TTL (time-to-live) on an existing key. |
| `incr` | `incr(key)` → `number` | Atomically increment a key's numeric value by 1. |
| `ttl` | `ttl(key)` → `number` | Get remaining TTL in seconds. Returns `-1` if no expiry, `-2` if key doesn't exist. |
| `eval` | `eval(script, keys, args)` → `unknown` | Execute a Lua script on the server. |

**Examples:**

```typescript
// Key-Value
await pool.set("user:123:name", "Alice");
await pool.set("session:abc", "token-xyz", "EX", 3600); // expires in 1 hour
const name = await pool.get("user:123:name"); // "Alice"
await pool.delete("session:abc");

// Sets
await pool.sadd("user:123:roles", "admin");
await pool.sadd("user:123:roles", "editor");
const roles = await pool.smembers("user:123:roles"); // ["admin", "editor"]
await pool.srem("user:123:roles", "editor");

// Utility
await pool.expire("user:123:name", 86400); // expire in 24 hours
const remaining = await pool.ttl("user:123:name"); // seconds left
const count = await pool.incr("page:views"); // atomic counter

// Lua scripting
const result = await pool.eval(
  "return redis.call('GET', KEYS[1])",
  ["my-key"],
  []
);
```

### Lifecycle Methods

| Method | Description |
|--------|-------------|
| `ConnectToService()` | Establishes the Redis connection(s). Must be called before using any commands. Returns a Promise that resolves when ready. |
| `gracefulShutdown()` | Cleanly disconnects, resets the circuit breaker, and nulls all references. Call this on process exit (SIGTERM/SIGINT). |
| `onReconnect(cb)` | Register a callback that fires after a successful reconnection. Useful for re-subscribing to channels or invalidating local caches. |
| `addLogger(logger)` | Replace the default logger with a custom `RedisLogger` instance. |

**Graceful shutdown example:**

```typescript
const pool = new RedisConnectionPoolHandler(connOptions, 3);
await pool.ConnectToService();

process.on("SIGTERM", () => {
  pool.gracefulShutdown();
  process.exit(0);
});

process.on("SIGINT", () => {
  pool.gracefulShutdown();
  process.exit(0);
});
```

**onReconnect example:**

```typescript
const redis = new RedisSingleConnectionHandler(connOptions);
await redis.ConnectToService();

redis.onReconnect(async () => {
  console.log("Redis reconnected — re-subscribing to channels");
  // re-do any setup that depends on the connection being alive
});
```

---

## Connection Warmup

By default, redis-axon runs a `PING` command after establishing each connection to verify Redis is truly responsive — not just TCP-connected.

**Why warmup matters:**

A TCP connection can succeed (`ready` event fires) even when:
- Redis is overloaded and responding slowly
- A network proxy is intercepting traffic but not forwarding to Redis
- The connection is technically open but about to be killed by a timeout

The warmup `PING` ensures your app doesn't accept traffic before Redis can actually serve commands.

**Default behavior (warmup enabled):**

```typescript
const redis = new RedisSingleConnectionHandler(connOptions, breakerOpts, true);
await redis.ConnectToService(); // resolves only after PING succeeds
```

```
TCP connect → ready event → PING → PONG → resolve
                                  → error → disconnect, cleanup, reject
```

**Disabling warmup:**

```typescript
// skip PING — resolve as soon as TCP + AUTH succeeds
const redis = new RedisSingleConnectionHandler(connOptions, breakerOpts, false);
await redis.ConnectToService(); // resolves on ready event without PING
```

**When to disable:**
- Local dev where you know Redis is always running
- Extremely latency-sensitive startup where 1 extra round-trip matters
- Testing environments

**Cleanup on failure:**

If the warmup PING fails, redis-axon doesn't leave a zombie connection behind:
1. Disconnects the TCP socket
2. Removes all event listeners
3. Nulls the connection reference
4. Rejects the promise with the error

This prevents leaked connections that would trigger phantom `close` events and unwanted reconnection cycles.

**Pool warmup:**

In pool mode, warmup is applied to each connection individually. All N connections must pass their PING before `ConnectToService()` resolves:

```typescript
const pool = new RedisConnectionPoolHandler(connOptions, 5, breakerOpts, true);
await pool.ConnectToService();
// all 5 connections have been PING'd and are confirmed responsive
```

**Cluster warmup:**

In cluster mode, warmup sends a PING through the cluster (routed to the connected node). If any node is unresponsive during initial connect, it fails fast:

```typescript
const cluster = new RedisClusterConnectionHandler(clusterOpts, breakerOpts, true);
await cluster.ConnectToService();
// cluster is verified responsive
```

---

## Health Check

redis-axon provides a standalone `RedisHealthCheck` class that works with any connection mode. It uses the strategy pattern internally — one strategy per handler type — so the check logic is tailored to each.

**Basic usage:**

```typescript
import { RedisSingleConnectionHandler } from "redis-axon/connection/connection.js";
import { RedisHealthCheck } from "redis-axon/health.js";

const redis = new RedisSingleConnectionHandler(connOptions);
await redis.ConnectToService();

const health = RedisHealthCheck.forSingle(redis);
```

**Factory methods (one per handler type):**

```typescript
// Single connection
const health = RedisHealthCheck.forSingle(handler);

// Connection pool
const health = RedisHealthCheck.forPool(pool);

// Cluster
const health = RedisHealthCheck.forCluster(cluster);
```

**The check() method:**

```typescript
const result = await health.check();
// {
//   status: "healthy",         // "healthy" | "degraded" | "unhealthy"
//   latencyMs: 1.23,           // PING round-trip time in ms
//   circuitState: "CLOSED",    // current circuit breaker state
//   connected: true,           // is the connection alive?
//   timestamp: 1718000000000   // when the check was performed
// }
```

**Status meanings:**

| Status | Meaning |
|--------|---------|
| `healthy` | Connection alive, PING responded, circuit CLOSED |
| `degraded` | PING responded but circuit is not fully CLOSED (recovering from failures) |
| `unhealthy` | No connection or PING failed |

**Quick boolean check:**

```typescript
const ok = await health.isHealthy(); // true | false
```

### Kubernetes Liveness/Readiness Probe

```typescript
import express from "express";
import { RedisConnectionPoolHandler } from "redis-axon/connection/pool.js";
import { RedisHealthCheck } from "redis-axon/health.js";

const pool = new RedisConnectionPoolHandler(connOptions, 3);
await pool.ConnectToService();

const health = RedisHealthCheck.forPool(pool);
const app = express();

// readiness probe — is Redis ready to serve traffic?
app.get("/health/ready", async (req, res) => {
  const result = await health.check();
  const code = result.status === "unhealthy" ? 503 : 200;
  res.status(code).json(result);
});

// liveness probe — is the process alive and able to check Redis?
app.get("/health/live", (req, res) => {
  res.status(200).json({ status: "alive" });
});
```

### Prometheus Metrics

```typescript
import { RedisHealthCheck } from "redis-axon/health.js";

const health = RedisHealthCheck.forSingle(redis);

setInterval(async () => {
  const result = await health.check();
  prometheus.gauge("redis_latency_ms", result.latencyMs);
  prometheus.gauge("redis_connected", result.connected ? 1 : 0);
  prometheus.gauge("redis_circuit_open", result.circuitState !== "CLOSED" ? 1 : 0);
}, 5000);
```

### AWS CloudWatch Custom Metrics

```typescript
import { CloudWatch } from "@aws-sdk/client-cloudwatch";
import { RedisHealthCheck } from "redis-axon/health.js";

const cw = new CloudWatch({});
const health = RedisHealthCheck.forPool(pool);

setInterval(async () => {
  const result = await health.check();
  await cw.putMetricData({
    Namespace: "MyApp/Redis",
    MetricData: [
      { MetricName: "Latency", Value: result.latencyMs, Unit: "Milliseconds" },
      { MetricName: "Connected", Value: result.connected ? 1 : 0, Unit: "None" },
    ],
  });
}, 10000);
```

### Pool-specific circuit state

For pools, `circuitState` returns per-connection state since each connection has its own circuit breaker:

```typescript
const result = await health.check();
console.log(result.circuitState);
// "[0]:CLOSED, [1]:CLOSED, [2]:OPEN"
// → connection 2 tripped, but 0 and 1 are healthy
```

---

## Reconnection Behavior

When a connection drops, here's exactly what happens:

```
1. "close" event fires
2. Reconnect() is called
3. Check: can circuit breaker attempt? (is state CLOSED or HALF_OPEN?)
   │
   ├── YES:
   │   ├── Calculate backoff delay using consecutiveFailures
   │   │   (formula: random(0, min(1000 × 2^failures, 30000)))
   │   ├── Wait the delay
   │   ├── Try ConnectToService()
   │   │   ├── SUCCESS → recordSuccess() → reset everything → fire onReconnect callbacks
   │   │   └── FAILURE → recordFailure() → increment consecutiveFailures
   │   │       ├── Circuit still CLOSED? → recurse (try again with bigger backoff)
   │   │       └── Circuit now OPEN? → schedule probe timer, stop retrying
   │   │
   └── NO (circuit is OPEN):
       └── scheduleProbe() → wait resetTimeout → transition to HALF_OPEN → Reconnect()
```

**Backoff formula:** `random(0, min(1000 × 2^attempt, 30000))`

This is exponential backoff with full jitter:
- Attempt 0: random between 0-1000ms
- Attempt 1: random between 0-2000ms
- Attempt 2: random between 0-4000ms
- Attempt 3: random between 0-8000ms
- Attempt 4: random between 0-16000ms
- Attempt 5+: random between 0-30000ms (capped)

The randomness (jitter) prevents thundering herd — if 100 services lose connection simultaneously, they won't all retry at the same instant.

---

## Logging

redis-axon uses [winston](https://github.com/winstonjs/winston) for structured logging.

**Default behavior:**
- Development (`NODE_ENV !== "production"`): colorized, human-readable output with timestamps
- Production (`NODE_ENV === "production"`): JSON format with timestamps

**Using the default logger:**

```typescript
// logger is created automatically — no configuration needed
const redis = new RedisSingleConnectionHandler(connOptions);
```

**Using a custom logger:**

```typescript
import { RedisLogger } from "redis-axon/logger.js";
import winston from "winston";

const customWinston = winston.createLogger({
  level: "warn", // only log warnings and errors
  transports: [new winston.transports.File({ filename: "redis.log" })],
});

const logger = new RedisLogger(customWinston);

const redis = new RedisSingleConnectionHandler(connOptions);
redis.addLogger(logger);

// for pools — propagates to all connections
const pool = new RedisConnectionPoolHandler(connOptions, 3);
pool.addLogger(logger);
```

**Log output examples:**

```
// Development
23:14:06 info [SingleConnection] Connection ready
23:14:07 warn [SingleConnection] Connection closed
23:14:07 info [SingleConnection] Attempting reconnect {"attempt":1,"delayMs":432,"circuitState":"CLOSED"}
23:14:08 info [SingleConnection] Reconnected successfully {"attempt":1}

// Production (JSON)
{"level":"info","message":"Connection ready","context":"SingleConnection","timestamp":"2024-01-15T23:14:06.000Z"}
```

---

## Testing

Tests use [vitest](https://vitest.dev/) and [testcontainers](https://testcontainers.com/) (spins up a real Redis in Docker).

**Prerequisites:** Docker must be running.

```bash
# run all tests
pnpm test

# run only circuit breaker unit tests (no Docker needed)
pnpm test:unit

# run integration tests (requires Docker)
pnpm test:integration

# watch mode
pnpm test:watch
```

---

## Examples

### Express.js Session Store

```typescript
import express from "express";
import { RedisConnectionPoolHandler } from "redis-axon/connection/pool.js";

const pool = new RedisConnectionPoolHandler({
  host: "localhost",
  port: 6379,
  password: "",
}, 3);

await pool.ConnectToService();

const app = express();

app.post("/login", async (req, res) => {
  const sessionId = crypto.randomUUID();
  await pool.set(`session:${sessionId}`, JSON.stringify({ userId: 123 }), "EX", 3600);
  res.json({ sessionId });
});

app.get("/me", async (req, res) => {
  const session = await pool.get(`session:${req.headers["x-session-id"]}`);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  res.json(JSON.parse(session));
});

process.on("SIGTERM", () => pool.gracefulShutdown());
```

### Rate Limiter

```typescript
import { RedisSingleConnectionHandler } from "redis-axon/connection/connection.js";

const redis = new RedisSingleConnectionHandler({
  host: "localhost",
  port: 6379,
  password: "",
});
await redis.ConnectToService();
const client = redis.redisConnection!;

async function isRateLimited(userId: string, limit: number, windowSeconds: number): Promise<boolean> {
  const key = `ratelimit:${userId}`;
  const current = await client.incr(key);
  if (current === 1) {
    await client.expire(key, windowSeconds);
  }
  return current > limit;
}

// usage
const limited = await isRateLimited("user:123", 100, 60); // 100 requests per 60 seconds
```

### Pub/Sub with Reconnection

```typescript
import { RedisSingleConnectionHandler } from "redis-axon/connection/connection.js";

const redis = new RedisSingleConnectionHandler({
  host: "localhost",
  port: 6379,
  password: "",
});
await redis.ConnectToService();

const subscriber = redis.redisConnection!.duplicate();

function subscribe() {
  subscriber.subscribe("notifications", (err) => {
    if (err) console.error("Subscribe failed:", err);
  });
  subscriber.on("message", (channel, message) => {
    console.log(`[${channel}] ${message}`);
  });
}

subscribe();

// re-subscribe after reconnection
redis.onReconnect(async () => {
  subscribe();
});
```

### AWS ElastiCache (TLS + Auth)

```typescript
import { RedisConnectionPoolHandler } from "redis-axon/connection/pool.js";
import fs from "fs";

const pool = new RedisConnectionPoolHandler({
  host: "my-cluster.abc123.use1.cache.amazonaws.com",
  port: 6380,
  password: "your-auth-token",
  tls: {
    rejectUnauthorized: true,
    // ElastiCache uses Amazon-trusted CAs — usually no custom CA needed
    // ca: fs.readFileSync("/path/to/AmazonRootCA1.pem", "utf8"),
  },
  keepAlive: 10000,
  connectTimeout: 5000,
  commandTimeout: 3000,
  enableAutoPipelining: true,
  enableReadyCheck: true,
}, 5, {
  threshold: 3,
  resetTimeout: 10000,
  maxResetTimeout: 120000,
});

await pool.ConnectToService();
```

### Redis Cluster on AWS ElastiCache

```typescript
import { RedisClusterConnectionHandler } from "redis-axon/connection/cluster.js";

const cluster = new RedisClusterConnectionHandler({
  nodes: [
    // ElastiCache cluster mode gives you a configuration endpoint
    // that returns all shard addresses. Just list 1-2 nodes:
    { host: "my-cluster.abc123.clustercfg.use1.cache.amazonaws.com", port: 6379 },
  ],
  password: "your-auth-token",
  tls: { rejectUnauthorized: true },
  scaleReads: "slave",       // offload reads to replicas
  enableAutoPipelining: true,
  keepAlive: 10000,
  connectTimeout: 5000,
  slotsRefreshInterval: 10000,
}, {
  threshold: 5,
  resetTimeout: 15000,
  maxResetTimeout: 180000,
});

await cluster.ConnectToService();
```

### Docker Compose Cluster (with NAT Map)

```yaml
# docker-compose.yml
services:
  redis-1:
    image: redis:7-alpine
    ports: ["7000:6379"]
  redis-2:
    image: redis:7-alpine
    ports: ["7001:6379"]
  redis-3:
    image: redis:7-alpine
    ports: ["7002:6379"]
```

```typescript
import { RedisClusterConnectionHandler } from "redis-axon/connection/cluster.js";

const cluster = new RedisClusterConnectionHandler({
  nodes: [
    { host: "localhost", port: 7000 },
    { host: "localhost", port: 7001 },
    { host: "localhost", port: 7002 },
  ],
  natMap: {
    // internal Docker IPs → external localhost ports
    "172.17.0.2:6379": { host: "localhost", port: 7000 },
    "172.17.0.3:6379": { host: "localhost", port: 7001 },
    "172.17.0.4:6379": { host: "localhost", port: 7002 },
  },
});

await cluster.ConnectToService();
```

### Caching with Fallback

```typescript
import { RedisConnectionPoolHandler } from "redis-axon/connection/pool.js";

const pool = new RedisConnectionPoolHandler({
  host: "localhost",
  port: 6379,
  password: "",
}, 3);

await pool.ConnectToService();

async function cachedFetch<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  // try cache first
  const cached = await pool.get(key);
  if (cached) return JSON.parse(cached) as T;

  // cache miss — fetch from source
  const data = await fetcher();
  await pool.set(key, JSON.stringify(data), "EX", ttl);
  return data;
}

// usage
const user = await cachedFetch("user:123", 300, async () => {
  return await db.users.findById(123);
});
```

---

## Project Structure

```
redis-axon/
├── src/
│   ├── circuit/
│   │   └── circuitBreaker.ts        # Circuit breaker state machine
│   ├── connection/
│   │   ├── connection.ts            # Single connection handler
│   │   ├── pool.ts                  # Connection pool (round-robin)
│   │   └── cluster.ts              # Redis Cluster handler
│   ├── health/
│   │   ├── health.ts               # RedisHealthCheck (strategy pattern)
│   │   ├── single.strategy.ts      # Health strategy for single connection
│   │   ├── pool.strategy.ts        # Health strategy for pool
│   │   └── cluster.strategy.ts     # Health strategy for cluster
│   ├── helper/
│   │   └── types.helper.ts         # All type definitions
│   └── log/
│       └── logger.ts               # Winston-based logger
├── tests/
│   ├── circuitBreaker.test.ts      # Unit tests
│   ├── connection.test.ts          # Integration tests (testcontainers)
│   └── health.test.ts             # Health check tests
├── tsup.config.ts
├── vitest.config.ts
├── package.json
└── tsconfig.json
```

---

## License

ISC
