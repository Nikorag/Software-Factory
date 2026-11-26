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

export interface RateLimiter {
  /** true = allowed. Implementations fail open when Redis is unavailable. */
  allow(key: string): Promise<boolean>;
  close(): Promise<void>;
}

export const channels = {
  wake: (factoryId: string) => `wake:${factoryId}`,
  org: (orgId: string) => `org:${orgId}`,
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
    async allow(key) {
      try {
        const k = `${cfg.REDIS_KEY_PREFIX}:rl:${key}:${Math.floor(Date.now() / 60_000)}`;
        const n = await r.incr(k);
        if (n === 1) await r.expire(k, 90);
        return n <= cfg.RATE_LIMIT_PER_MINUTE;
      } catch { return true; }
    },
    async close() { await r.quit().catch(() => r.disconnect()); },
  };
}
