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
await redis.set("hello", "world");
const value = await redis.get("hello");
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

All three connection modes (Single, Pool, Cluster) share the same command interface via the `RedisCommandHandler` base class. You never interact with `RedisCommandHandler` directly — your handler (Single, Pool, or Cluster) inherits these methods automatically.

```typescript
// works identically on all three:
await redis.set("key", "value");
await pool.set("key", "value");
await cluster.set("key", "value");
```

---

#### `set(key, value, ...options)`

Store a string value under a key. Supports all Redis SET options.

| Param | Type | Description |
|-------|------|-------------|
| `key` | `string` | The key name |
| `value` | `string` | The value to store |
| `options` | variadic | Optional combination of expiry mode, duration, and/or conditional flag |

**Expiry modes (pick one):**

| Mode | Arg | Description |
|------|-----|-------------|
| `"EX"` | seconds | Expire in N seconds |
| `"PX"` | milliseconds | Expire in N milliseconds |
| `"EXAT"` | unix timestamp (s) | Expire at specific unix time (seconds) |
| `"PXAT"` | unix timestamp (ms) | Expire at specific unix time (milliseconds) |
| `"KEEPTTL"` | — | Retain the existing TTL when overwriting a key |

**Conditional flags (pick one):**

| Flag | Description |
|------|-------------|
| `"NX"` | Only set if key does **not** exist (create-only). Use for distributed locks. |
| `"XX"` | Only set if key **does** exist (update-only). Use for safe overwrites. |

**Returns:** `Promise<void>`

**Valid call patterns:**

```typescript
// 1. Basic set — no options
// Saves the user's name. It will stay in Redis until manually deleted.
await redis.set("user:1001", "Alice");

// 2. Setting an expiration time
// "EX" means seconds. This caches a session token that auto-deletes after 1 hour.
await redis.set("session:abcde123", "active", "EX", 3600);

// "PX" means milliseconds. This caches data for exactly 500ms.
await redis.set("rate_limit:ip_127", "1", "PX", 500);

// "EXAT" means expire at a specific unix timestamp (seconds).
await redis.set("promo:banner", "summer-sale", "EXAT", 1718000000);

// "PXAT" means expire at a specific unix timestamp (milliseconds).
await redis.set("flash:deal", "active", "PXAT", 1718000000000);

// 3. Conditional saving (existence flags)
// "NX" (Not eXists) — only saves if the key DOES NOT exist yet.
// Great for ensuring only one server runs a background job (distributed lock).
await redis.set("lock:daily_job", "locked", "NX");

// "XX" (eXists) — only saves if the key ALREADY exists.
// Great for updating data only if it hasn't been wiped out by something else.
await redis.set("user:1001:status", "online", "XX");

// 4. Combining expiration + flags
// Saves a lock that automatically breaks after 30 seconds
// so the system doesn't freeze if a process crashes.
await redis.set("lock:process_video", "locked", "EX", 30, "NX");

// Same thing, reversed order — both are valid.
await redis.set("lock:process_video", "locked", "NX", "EX", 30);

// 5. Keeping the existing TTL (KEEPTTL)
// Updates the value to "Bob" but leaves the existing countdown timer exactly as it was.
// Use case: user's session expires in 30 minutes, you update their cached profile
// without resetting the 30-minute timer.
await redis.set("user:1001", "Bob", "KEEPTTL", 0);
```

**Use cases:**
- Caching API responses: `set(key, json, "EX", 300)`
- Session tokens: `set(sessionId, token, "EX", 3600)`
- Distributed locks: `set(lockKey, ownerId, "EX", 30, "NX")`
- Feature flags: `set("feature:dark-mode", "true")`
- Conditional updates: `set(key, value, "XX")` — only update if someone already created it

---

#### `get(key)`

Retrieve the value stored at a key.

| Param | Type | Description |
|-------|------|-------------|
| `key` | `string` | The key to look up |

**Returns:** `Promise<string | null>` — `null` if the key doesn't exist or has expired.

```typescript
// 1. Basic cache lookup
// Check if we already have the user's profile cached before hitting the database.
const cached = await redis.get("cache:user:1001");
if (cached) {
  return JSON.parse(cached); // cache hit — skip the DB query entirely
}

// 2. Session validation
// On every API request, verify the session token is still valid.
const session = await redis.get(`session:${req.headers["x-session-id"]}`);
if (!session) {
  // null means either: key never existed, or it expired.
  // Either way, user needs to re-authenticate.
  return res.status(401).json({ error: "session expired" });
}

// 3. Feature flag check
// Check if dark mode is enabled for this tenant.
const darkMode = await redis.get("feature:dark-mode:tenant-42");
if (darkMode === "true") {
  // render dark UI
}

// 4. Safe JSON parsing
// get() returns a string or null. Parse JSON safely with a fallback.
const user = JSON.parse((await redis.get("user:123")) ?? "null");
```

---

#### `delete(...keys)`

Delete one or more keys and their values in a single call.

| Param | Type | Description |
|-------|------|-------------|
| `keys` | `...string[]` | One or more keys to delete |

**Returns:** `Promise<number>` — the number of keys that were actually deleted (0 if none existed).

```typescript
// 1. Cache invalidation after a write
// User updated their profile — delete the stale cached version
// so the next read fetches fresh data from the database.
await db.users.update(1001, { name: "Bob" });
await redis.delete("cache:user:1001");

// 2. Logging out a user
// Destroy the session so any further requests with this token are rejected.
await redis.delete(`session:${sessionId}`);

// 3. Bulk cleanup in one round-trip
// User is being deleted — wipe all their related keys at once.
// This is ONE network call regardless of how many keys you pass.
const deleted = await redis.delete(
  `user:${id}:profile`,
  `user:${id}:settings`,
  `user:${id}:notifications`,
  `session:${id}`,
);
console.log(`Cleaned up ${deleted} keys`);

// 4. Releasing a lock (simple version)
// After finishing a background job, release the lock so others can run.
await redis.delete("lock:send-daily-emails");

// 5. Checking if something existed
// Returns 0 if the key wasn't there — useful for idempotency checks.
const count = await redis.delete("one-time-token:abc");
if (count === 0) {
  throw new Error("Token already used or expired");
}
```

---

#### `sadd(key, ...members)`

Add one or more members to a Redis Set. Sets are unordered collections of unique strings. Duplicates are silently ignored.

| Param | Type | Description |
|-------|------|-------------|
| `key` | `string` | The set key |
| `members` | `...string[]` | One or more members to add |

**Returns:** `Promise<number>` — the number of members that were newly added (excludes already-existing members).

```typescript
// 1. Assigning roles to a user
// If "admin" is already in the set, Redis silently ignores it — no duplicates ever.
await redis.sadd("user:123:roles", "admin");
await redis.sadd("user:123:roles", "admin"); // returns 0, no-op

// 2. Batch-adding multiple roles in one network call
// Only newly added members are counted in the return value.
const added = await redis.sadd("user:123:roles", "admin", "editor", "viewer");
console.log(`${added} new roles assigned`); // e.g. 2 if "admin" already existed

// 3. Tracking unique visitors per day
// Even if the same user hits 50 pages, they only count once in the set.
await redis.sadd(`visitors:2024-06-15`, userId);
// At end of day: smembers gives you unique visitor list,
// set size gives you unique visitor count.

// 4. Building a tag system
// Each post has a set of tags. Adding the same tag twice is harmless.
await redis.sadd(`post:${postId}:tags`, "typescript", "redis", "backend");

// 5. Online presence tracking
// When a user connects via WebSocket, add them to the online set.
await redis.sadd("online:users", `user:${userId}`);
```

---

#### `srem(key, ...members)`

Remove one or more members from a Redis Set.

| Param | Type | Description |
|-------|------|-------------|
| `key` | `string` | The set key |
| `members` | `...string[]` | One or more members to remove |

**Returns:** `Promise<number>` — the number of members that were actually removed (0 if none were in the set).

```typescript
// 1. Revoking a permission
// User no longer needs admin access. Remove it from their role set.
await redis.srem("user:123:roles", "admin");

// 2. Bulk permission revocation
// Employee leaving — strip all elevated roles in one call.
const removed = await redis.srem("user:123:roles", "admin", "editor", "moderator");
console.log(`${removed} roles revoked`); // only counts roles that actually existed

// 3. User going offline
// When WebSocket disconnects, remove from the online set.
await redis.srem("online:users", `user:${userId}`);

// 4. Un-tagging content
// Post no longer relevant to "redis" topic.
await redis.srem(`post:${postId}:tags`, "redis");

// 5. Idempotent removal
// Removing something that isn't in the set returns 0, doesn't throw.
const count = await redis.srem("user:123:roles", "nonexistent-role"); // 0
```

---

#### `smembers(key)`

Get all members of a Redis Set.

| Param | Type | Description |
|-------|------|-------------|
| `key` | `string` | The set key |

**Returns:** `Promise<string[]>` — empty array if key doesn't exist.

```typescript
// 1. Authorization check
// Get all roles, then decide if the user can perform this action.
const roles = await redis.smembers("user:123:roles");
if (!roles.includes("admin")) {
  throw new Error("Forbidden: admin role required");
}

// 2. Listing tags on a resource
// Show all tags on a blog post for the UI.
const tags = await redis.smembers(`post:${postId}:tags`);
// ["typescript", "redis", "backend"]

// 3. Getting all online users
// For a dashboard that shows who's currently connected.
const onlineUsers = await redis.smembers("online:users");
console.log(`${onlineUsers.length} users online`);

// 4. Non-existent key returns empty array (not null, not error)
// Safe to iterate immediately without null checks.
const empty = await redis.smembers("nonexistent:set"); // []
```

---

#### `expire(key, seconds)`

Set a time-to-live on an existing key. The key is automatically deleted after the TTL expires.

| Param | Type | Description |
|-------|------|-------------|
| `key` | `string` | The key to set TTL on |
| `seconds` | `number` | TTL in seconds |

**Returns:** `Promise<void>`

```typescript
// 1. Sliding session expiry
// Every time the user makes a request, reset their session timer to 1 hour.
// If they're inactive for 1 hour, it auto-deletes and they get logged out.
await redis.expire(`session:${sessionId}`, 3600);

// 2. Adding expiry AFTER creating a key
// Sometimes you set() without expiry first, then conditionally add one.
await redis.set("upload:token:abc", userId);
if (isTemporaryUpload) {
  await redis.expire("upload:token:abc", 600); // 10 minutes
}

// 3. Rate limit window cleanup
// After incrementing a counter, ensure it auto-deletes when the window ends.
const count = await redis.incr(`ratelimit:${ip}`);
if (count === 1) {
  // First request in this window — set the window duration.
  await redis.expire(`ratelimit:${ip}`, 60);
}

// 4. Auto-expiring feature flags
// Roll out a feature for 24 hours, then it automatically turns off.
await redis.set("feature:flash-sale", "true");
await redis.expire("feature:flash-sale", 86400); // 24 hours
```

---

#### `incr(key)`

Atomically increment a key's integer value by 1. If the key doesn't exist, it's initialized to `0` before incrementing (so the result is `1`).

| Param | Type | Description |
|-------|------|-------------|
| `key` | `string` | The key to increment |

**Returns:** `Promise<number>` — the value after incrementing.

```typescript
// 1. Rate limiter (most common use case)
// Count how many requests this user has made in the current minute.
// If it's their first request, set the window to expire in 60 seconds.
const key = `ratelimit:${userId}:${currentMinute}`;
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, 60); // start the 60s window
if (count > 100) throw new Error("Rate limited: 100 req/min exceeded");

// 2. Page view counter
// Every time someone loads /home, increment. No race conditions even
// if 1000 requests hit simultaneously — Redis INCR is atomic.
const views = await redis.incr("page:views:/home");

// 3. Generating sequential IDs
// Each call returns a unique incrementing number — no collisions.
const orderId = await redis.incr("counter:orders"); // 1, 2, 3, ...

// 4. Tracking API quota usage
// User gets 10,000 API calls per month. Track how many they've used.
const used = await redis.incr(`quota:${userId}:${currentMonth}`);
if (used > 10000) throw new Error("Monthly quota exceeded");

// 5. Error counting for alerting
// If errors exceed threshold, trigger an alert.
const errors = await redis.incr("errors:payment-service:5min");
if (errors === 1) await redis.expire("errors:payment-service:5min", 300);
if (errors > 50) alertOncall("Payment service error spike");
```

---

#### `ttl(key)`

Get the remaining time-to-live of a key in seconds.

| Param | Type | Description |
|-------|------|-------------|
| `key` | `string` | The key to check |

**Returns:** `Promise<number>`
- Positive number → seconds remaining
- `-1` → key exists but has no expiry
- `-2` → key doesn't exist

```typescript
// 1. Proactive cache refresh
// If the cache is about to expire, refresh it in the background
// so the next user doesn't experience a slow cache miss.
const remaining = await redis.ttl("cache:product-catalog");
if (remaining < 60 && remaining > 0) {
  // Less than 1 minute left — refresh in background
  refreshCacheInBackground();
}

// 2. Session sliding expiry check
// Only extend the session if it's close to expiring (avoid unnecessary writes).
const sessionTtl = await redis.ttl(`session:${sessionId}`);
if (sessionTtl < 300 && sessionTtl > 0) {
  // Less than 5 minutes left — extend by another hour
  await redis.expire(`session:${sessionId}`, 3600);
}

// 3. Checking if a key exists vs expired vs never had TTL
const ttl = await redis.ttl("some:key");
if (ttl === -2) {
  // Key doesn't exist at all — never created or already expired & deleted
}
if (ttl === -1) {
  // Key exists but has NO expiry — it will live forever until manually deleted
}
if (ttl > 0) {
  // Key exists and will auto-delete in `ttl` seconds
  console.log(`Expires in ${ttl} seconds`);
}

// 4. Show "session expires in X minutes" to the user
const secondsLeft = await redis.ttl(`session:${sessionId}`);
res.json({ expiresInMinutes: Math.ceil(secondsLeft / 60) });
```

---

#### `eval(script, keys, args)`

Execute a Lua script atomically on the Redis server. The script runs as a single operation — no other command can execute between its steps.

| Param | Type | Description |
|-------|------|-------------|
| `script` | `string` | Lua script source code |
| `keys` | `string[]` | Redis keys the script accesses (available as `KEYS[1]`, `KEYS[2]`, ...) |
| `args` | `string[]` | Additional arguments (available as `ARGV[1]`, `ARGV[2]`, ...) |

**Returns:** `Promise<unknown>` — whatever the Lua script returns.

**Why use eval instead of multiple commands?**

Without eval, this race condition is possible:
```
Server A: GET lock → "owner-a" ✓ (it's mine)
Server B: GET lock → "owner-a" 
Server A: DEL lock (releases it)
Server B: DEL lock (ALSO deletes it — but it was already re-acquired by Server C!)
```

With eval, the GET + conditional DEL is one atomic step — no other command can sneak in between.

```typescript
// 1. Safe lock release (compare-and-delete)
// Only delete the lock if we still own it.
// Without this atomicity, another process could steal the lock between our GET and DEL.
const unlockScript = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;
const released = await redis.eval(unlockScript, ["lock:send-emails"], [myLockToken]);
if (released === 0) {
  console.warn("Lock was already taken by someone else");
}

// 2. Atomic rate limiter (increment + set expiry in one call)
// Problem with separate INCR + EXPIRE: if the process crashes between them,
// the key lives forever and the user is permanently rate-limited.
// Eval makes it all-or-nothing.
const rateLimitScript = `
  local count = redis.call("INCR", KEYS[1])
  if count == 1 then
    redis.call("EXPIRE", KEYS[1], ARGV[1])
  end
  return count
`;
const count = await redis.eval(rateLimitScript, [`ratelimit:${userId}`], ["60"]);
if (count as number > 100) throw new Error("Rate limited");

// 3. Atomic "get and delete" (consume a one-time token)
// Verify the token exists AND delete it in one step.
// If two requests hit simultaneously with the same token, only one succeeds.
const consumeToken = `
  local val = redis.call("GET", KEYS[1])
  if val then
    redis.call("DEL", KEYS[1])
    return val
  end
  return nil
`;
const payload = await redis.eval(consumeToken, [`otp:${code}`], []);
if (!payload) throw new Error("Invalid or already-used token");
```

---

#### Accessing the raw ioredis client

If you need commands not exposed by `RedisCommandHandler` (e.g. `HSET`, `LPUSH`, `PUBLISH`, `SUBSCRIBE`), access the underlying ioredis instance directly:

```typescript
// single
const raw = redis.redisConnection!;
await raw.hset("hash:key", "field", "value");
await raw.lpush("list:key", "item1", "item2");

// pool (gets the next healthy connection via round-robin)
const raw = pool.redisConnection!;
await raw.rpop("queue:jobs");

// cluster
const raw = cluster.clusterConnection!;
await raw.publish("channel", "message");
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

async function isRateLimited(userId: string, limit: number, windowSeconds: number): Promise<boolean> {
  const key = `ratelimit:${userId}`;
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, windowSeconds);
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
│   │   ├── commands.ts              # RedisCommandHandler base class (shared commands)
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

MIT
