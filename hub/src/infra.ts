import { Queue, Worker } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import type { Config } from "./config.js";

// Redis is used for transient coordination only. Everything here is reconstructible from PostgreSQL
// (see commands.ts: reconcile() re-enqueues pending work if Redis loses it).

export interface Bus {
  publish(channel: string, message: string): Promise<void>;
  /** Subscribe to an exact channel; returns an unsubscribe function. */
  subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface DispatchQueue {
  /** Idempotent per commandId: enqueuing twice yields one job. */
  enqueue(commandId: string): Promise<void>;
  startWorker(handler: (commandId: string) => Promise<void>): void;
  close(): Promise<void>;
}

/**
 * Transient request/response relay between a browser (via the hub) and a factory's local dashboard API.
 * Lives only in Redis with short TTLs and is NEVER stored in PostgreSQL: the semantics are "execute now or
 * fail", so a queued request can't fire hours later. Delivery is at-most-once (take() removes it) and a
 * response is accepted once.
 */
export interface TunnelRequest { id: string; method: string; path: string; headers: Record<string, string>; bodyBase64?: string; expiresAt: string }
export interface TunnelResponse { status: number; headers: Record<string, string>; bodyBase64: string }
export interface Tunnel {
  /** false when that factory's queue is full. */
  push(factoryId: string, req: TunnelRequest): Promise<boolean>;
  take(factoryId: string, max: number): Promise<TunnelRequest[]>;
  /** false when the request already expired or was already answered. */
  respond(id: string, res: TunnelResponse): Promise<boolean>;
  awaitResponse(id: string, timeoutMs: number): Promise<TunnelResponse | null>;
}

export interface RateLimiter {
  /** true = allowed. Implementations fail open when Redis is unavailable. `limit` overrides the default per-minute limit. */
  allow(key: string, limit?: number): Promise<boolean>;
  close(): Promise<void>;
}

export const channels = {
  wake: (factoryId: string) => `wake:${factoryId}`,
  org: (orgId: string) => `org:${orgId}`,
  tunnel: (factoryId: string) => `tunnel:${factoryId}`,
  tunnelRes: (requestId: string) => `tunres:${requestId}`,
};

export function redisOptions(cfg: Config, extra: RedisOptions = {}): RedisOptions {
  const url = new URL(cfg.REDIS_URL);
  const tls = url.protocol === "rediss:" ? { ca: cfg.REDIS_TLS_CA, rejectUnauthorized: cfg.REDIS_TLS_REJECT_UNAUTHORIZED, servername: url.hostname } : undefined;
  return {
    host: url.hostname, port: Number(url.port || 6379),
    username: cfg.REDIS_USERNAME ?? (decodeURIComponent(url.username) || undefined),
    password: cfg.REDIS_PASSWORD ?? (decodeURIComponent(url.password) || undefined),
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls, connectionName: "software-factory-hub", ...extra,
  };
}

// Connection errors must never crash the process; the readiness probe reports them.
const quiet = (r: Redis) => { r.on("error", () => undefined); return r; };

export function createRedisBus(cfg: Config): Bus {
  const pub = quiet(new Redis(redisOptions(cfg, { maxRetriesPerRequest: 1, commandTimeout: 2000 })));
  const sub = quiet(new Redis(redisOptions(cfg)));
  const prefix = `${cfg.REDIS_KEY_PREFIX}:`;
  const handlers = new Map<string, Set<(m: string) => void>>();
  sub.on("message", (ch: string, msg: string) => handlers.get(ch)?.forEach((h) => h(msg)));
  // After a reconnect ioredis re-subscribes automatically (autoResubscribe), so no extra bookkeeping.
  return {
    async publish(channel, message) { await pub.publish(prefix + channel, message); },
    async subscribe(channel, handler) {
      const full = prefix + channel;
      let set = handlers.get(full);
      if (!set) { set = new Set(); handlers.set(full, set); await sub.subscribe(full); }
      set.add(handler);
      return async () => {
        set.delete(handler);
        if (set.size === 0) { handlers.delete(full); await sub.unsubscribe(full).catch(() => undefined); }
      };
    },
    async ping() { await pub.ping(); },
    async close() { sub.disconnect(); await pub.quit().catch(() => pub.disconnect()); },
  };
}

export function createBullQueue(cfg: Config): DispatchQueue {
  // BullMQ needs maxRetriesPerRequest: null for blocking connections and forbids ioredis keyPrefix.
  const opts = redisOptions(cfg, { maxRetriesPerRequest: null });
  const name = "command-dispatch";
  const prefix = cfg.REDIS_KEY_PREFIX;
  const queue = new Queue(name, { connection: quiet(new Redis(opts)), prefix,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true, attempts: 5, backoff: { type: "exponential", delay: 1000 } } });
  queue.on("error", () => undefined);
  let worker: Worker | undefined;
  return {
    // jobId = commandId, so duplicate enqueues collapse. Jobs are removed on completion so the same
    // id can be enqueued again later (e.g. a redelivery after a lease expires).
    // BullMQ's connection waits forever while Redis is down; bound it so the outbox relay fails fast
    // (and retries with backoff) instead of holding a database transaction open.
    async enqueue(commandId) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          queue.add("dispatch", { commandId }, { jobId: commandId }),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("redis enqueue timed out")), 3000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
    startWorker(handler) {
      worker = new Worker(name, async (job) => handler((job.data as { commandId: string }).commandId),
        { connection: quiet(new Redis(opts)), prefix, concurrency: 8 });
      worker.on("error", () => undefined);
    },
    async close() { await worker?.close(); await queue.close(); },
  };
}

export function createRedisRateLimiter(cfg: Config): RateLimiter {
  const r = quiet(new Redis(redisOptions(cfg, { maxRetriesPerRequest: 1, commandTimeout: 2000 })));
  return {
    async allow(key, limit) {
      try {
        const k = `${cfg.REDIS_KEY_PREFIX}:rl:${key}:${Math.floor(Date.now() / 60_000)}`;
        const n = await r.incr(k);
        if (n === 1) await r.expire(k, 90);
        return n <= (limit ?? cfg.RATE_LIMIT_PER_MINUTE);
      } catch { return true; }
    },
    async close() { await r.quit().catch(() => r.disconnect()); },
  };
}

export const TUNNEL_QUEUE_MAX = 50;
const TUNNEL_TTL_S = 60;

export function createRedisTunnel(cfg: Config, bus: Bus): Tunnel {
  const r = quiet(new Redis(redisOptions(cfg, { maxRetriesPerRequest: 1, commandTimeout: 2000 })));
  const p = cfg.REDIS_KEY_PREFIX;
  const q = (f: string) => `${p}:tun:q:${f}`, live = (id: string) => `${p}:tun:p:${id}`, res = (id: string) => `${p}:tun:r:${id}`;
  return {
    async push(factoryId, req) {
      if ((await r.llen(q(factoryId))) >= TUNNEL_QUEUE_MAX) return false;
      await r.set(live(req.id), "1", "EX", TUNNEL_TTL_S);
      await r.rpush(q(factoryId), JSON.stringify(req));
      await r.expire(q(factoryId), TUNNEL_TTL_S * 2);
      await bus.publish(channels.tunnel(factoryId), req.id).catch(() => undefined);
      return true;
    },
    async take(factoryId, max) {
      const items = (await r.lpop(q(factoryId), max)) as string[] | null; // atomic: each request goes to exactly one poller
      return (items ?? []).map((i) => JSON.parse(i) as TunnelRequest);
    },
    async respond(id, response) {
      if ((await r.del(live(id))) !== 1) return false; // expired, or already answered
      await r.set(res(id), JSON.stringify(response), "EX", TUNNEL_TTL_S);
      await bus.publish(channels.tunnelRes(id), "1").catch(() => undefined);
      return true;
    },
    async awaitResponse(id, timeoutMs) {
      let wake: (() => void) | undefined;
      const unsub = await bus.subscribe(channels.tunnelRes(id), () => wake?.()).catch(() => undefined);
      try {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const got = await r.getdel(res(id)); // one-shot read
          if (got) return JSON.parse(got) as TunnelResponse;
          const left = deadline - Date.now();
          if (left <= 0) { await r.del(live(id)); return null; } // stop a late answer from being accepted
          await new Promise<void>((ok) => { const t = setTimeout(ok, Math.min(left, 1000)); wake = () => { clearTimeout(t); ok(); }; });
        }
      } finally { await unsub?.(); }
    },
  };
}
