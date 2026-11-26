import { PGlite } from "@electric-sql/pglite";
import { pino } from "pino";
import { loadConfig, type Config } from "../src/config.js";
import type { Db, Queryable } from "../src/db.js";
import type { Bus, DispatchQueue, RateLimiter, Tunnel, TunnelRequest, TunnelResponse } from "../src/infra.js";
import { createHub } from "../src/hub.js";
import { migrate } from "../src/migrate.js";

export const TEST_ENV = {
  NODE_ENV: "test", PUBLIC_URL: "https://factory.example.test", DATABASE_URL: "postgres://unused", REDIS_URL: "redis://unused",
  SETUP_TOKEN: "setup-token-for-tests-1234567",
  SESSION_SECRET: "s".repeat(40), FACTORY_TOKEN_PEPPER: "p".repeat(40), WEBAUTHN_RP_ID: "factory.example.test",
  WEBAUTHN_ORIGIN: "https://factory.example.test", VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:ops@example.test",
  LOG_LEVEL: "silent", SHUTDOWN_DRAIN_MS: "0", COMMAND_LEASE_SECONDS: "60",
};
export const testConfig = (over: Record<string, string> = {}): Config => loadConfig({ ...TEST_ENV, ...over });

export function pgliteDb(pg = new PGlite()): Db & { pg: PGlite } {
  const wrap = (c: Pick<PGlite, "query" | "exec">): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) { const r = await c.query<T>(sql, params as never); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; },
    async exec(sql) { await c.exec(sql); },
  });
  return { ...wrap(pg), pg, tx: (fn) => pg.transaction((tx) => fn(wrap(tx as never))), close: () => pg.close() };
}

export async function freshDb() { const db = pgliteDb(); await migrate(db); return db; }

export class FakeBus implements Bus {
  down = false; published: Array<[string, string]> = [];
  private subs = new Map<string, Set<(m: string) => void>>();
  async publish(c: string, m: string) { if (this.down) throw new Error("redis down"); this.published.push([c, m]); this.subs.get(c)?.forEach((h) => h(m)); }
  async subscribe(c: string, h: (m: string) => void) { (this.subs.get(c) ?? this.subs.set(c, new Set()).get(c)!).add(h); return async () => { this.subs.get(c)?.delete(h); }; }
  async ping() { if (this.down) throw new Error("redis down"); }
  async close() {}
}

export class FakeQueue implements DispatchQueue {
  jobs: string[] = []; down = false; handler?: (id: string) => Promise<void>;
  async enqueue(id: string) { if (this.down) throw new Error("redis down"); if (!this.jobs.includes(id)) this.jobs.push(id); }
  startWorker(h: (id: string) => Promise<void>) { this.handler = h; }
  /** Run queued jobs through the worker handler (what BullMQ would do). */
  async drain() { const j = this.jobs.splice(0); for (const id of j) await this.handler!(id); return j.length; }
  /** Simulate Redis losing its data. */
  flush() { this.jobs = []; }
  async close() {}
}

/** In-memory Tunnel with the same semantics as the Redis one (at-most-once take, single response, expiry). */
export class FakeTunnel implements Tunnel {
  queues = new Map<string, TunnelRequest[]>(); live = new Set<string>(); responses = new Map<string, TunnelResponse>(); full = false;
  async push(f: string, r: TunnelRequest) { if (this.full) return false; this.live.add(r.id); (this.queues.get(f) ?? this.queues.set(f, []).get(f)!).push(r); return true; }
  async take(f: string, n: number) { return this.queues.get(f)?.splice(0, n) ?? []; }
  async respond(id: string, res: TunnelResponse) { if (!this.live.delete(id)) return false; this.responses.set(id, res); return true; }
  async awaitResponse(id: string, ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const r = this.responses.get(id); if (r) { this.responses.delete(id); return r; } await new Promise((ok) => setTimeout(ok, 10)); }
    this.live.delete(id); return null;
  }
}

export const allowAll: RateLimiter = { allow: async () => true, close: async () => {} };

export async function seed(db: Db) {
  const one = async (sql: string, p: unknown[]) => (await db.query<{ id: string }>(sql, p)).rows[0]!.id;
  const org = await one("INSERT INTO organisations (slug, name) VALUES ('acme','Acme') RETURNING id", []);
  const mk = (email: string) => one("INSERT INTO users (email, display_name, webauthn_user_handle) VALUES ($1,$1,$2) RETURNING id", [email, Buffer.from(email.padEnd(32, "x"))]);
  const admin = await mk("admin@acme.test"), viewer = await mk("viewer@acme.test"), outsider = await mk("out@else.test");
  await db.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'admin'),($1,$3,'viewer')", [org, admin, viewer]);
  const factory = await one("INSERT INTO factories (org_id, name, owner_user_id) VALUES ($1,'mac-mini',$2) RETURNING id", [org, admin]);
  return { org, admin, viewer, outsider, factory };
}

export function testHub(db: Db, over: Record<string, string> = {}, push?: import("../src/push.js").PushSender | null) {
  const cfg = testConfig(over), bus = new FakeBus(), queue = new FakeQueue(), tunnel = new FakeTunnel();
  const log = pino({ level: "silent" });
  const hub = createHub(cfg, { db, bus, tunnel, queue, limiter: allowAll, ...(push !== undefined ? { push } : {}) }, log);
  hub.state.initialised = true; queue.startWorker((id) => hub.commands.onDispatch(id));
  return { cfg, bus, queue, tunnel, hub, commands: hub.commands, app: hub.app };
}
