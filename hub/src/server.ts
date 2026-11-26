import { randomUUID } from "node:crypto";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import { authenticateFactory, authenticateSession, isUuid, issueFactoryCredential, orgRole, type FactoryPrincipal, type UserPrincipal } from "./auth.js";
import { audit, CommandError, type CommandService } from "./commands.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { makeReadiness, type HubState } from "./health.js";
import { channels, type Bus, type RateLimiter, type Tunnel } from "./infra.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerDashboardRoutes } from "./routes-dashboard.js";
import { registerTunnelRoutes } from "./routes-tunnel.js";
import { registerUi, SECURITY_HEADERS } from "./ui.js";
import { eventsBody, ingestEvents, syncBody, syncMetadata } from "./ingest.js";

export interface Deps { cfg: Config; db: Db; bus: Bus; tunnel: Tunnel; limiter: RateLimiter; log: Logger; commands: CommandService; state: HubState }

declare module "fastify" { interface FastifyRequest { factory?: FactoryPrincipal; user?: UserPrincipal } }

const createCommandBody = z.object({
  type: z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/), payload: z.record(z.string(), z.unknown()).optional(),
  ttlSeconds: z.number().int().min(10).max(7 * 24 * 3600).optional(), repeatable: z.boolean().optional(), clientKey: z.string().min(1).max(200).optional(),
});
const completeBody = z.object({ leaseToken: z.string().uuid(), outcome: z.enum(["succeeded", "failed"]), result: z.unknown().optional(), error: z.string().max(2000).optional() });
const ackBody = z.object({ leaseToken: z.string().uuid(), extendSeconds: z.number().int().min(5).max(3600).optional() });
const heartbeatBody = z.object({ version: z.string().max(100).optional(), metadata: z.record(z.string(), z.unknown()).optional() });
const registerBody = z.object({ orgId: z.string().uuid(), name: z.string().min(1).max(100) });

export function buildServer(d: Deps): FastifyInstance {
  const { cfg, db, bus, log, commands, state } = d;
  const app = Fastify({
    loggerInstance: log, logController: new LogController({ disableRequestLogging: true }), trustProxy: true, forceCloseConnections: true, bodyLimit: 2 * 1024 * 1024,
    genReqId: (req) => { const h = req.headers["x-request-id"]; return typeof h === "string" && /^[\w.-]{8,100}$/.test(h) ? h : randomUUID(); },
  });
  const readiness = makeReadiness(db, bus, state);
  // Shutdown wakes every long-poll so the process can drain quickly.
  const shutdownWaiters = new Set<() => void>();
  app.addHook("onClose", async () => { shutdownWaiters.forEach((w) => w()); });

  // ---- Health ----
  // live: the event loop answers. No dependency checks, by design.
  app.get("/healthz/live", async () => ({ status: "ok" }));
  // startup: initial connectivity + schema check passed once.
  app.get("/healthz/startup", async (_req, reply) => state.initialised ? { status: "ok" } : reply.code(503).send({ status: "starting" }));
  app.get("/healthz/ready", async (_req, reply) => { const r = await readiness(); return reply.code(r.ready ? 200 : 503).send({ status: r.ready ? "ok" : "unavailable", checks: r.checks }); });

  // ---- Access log (no bodies, no query strings, no health noise) + rate limit on the API ----
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/healthz")) return;
    if (!(await d.limiter.allow(`ip:${req.ip}`))) return reply.code(429).header("retry-after", "30").send({ error: "rate_limited" });
  });
  app.addHook("onResponse", async (req, reply) => {
    if (req.url.startsWith("/healthz")) return;
    req.log[req.method === "GET" && reply.statusCode < 400 && req.url.startsWith("/f/") ? "debug" : "info"]({ method: req.method, route: req.routeOptions.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime), factoryId: req.factory?.factoryId, userId: req.user?.userId }, "request");
  });

  app.addHook("onSend", async (_req, reply) => { for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v); });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    if (err instanceof CommandError) {
      const code = { forbidden: 403, not_found: 404, conflict: 409, invalid: 400 }[err.code];
      return reply.code(code).send({ error: err.code, message: err.message, status: err.status });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error({ err: { message: err.message, stack: err.stack } }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", requestId: req.id });
  });

  const requireFactory = async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticateFactory(cfg, db, req.headers.authorization);
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    req.factory = p;
    req.log = req.log.child({ factoryId: p.factoryId });
  };
  // Cookie-authenticated routes. `strictJson` (the API) requires mutations to be JSON; the tunnel instead requires the
  // dashboard's custom X-Factory-UI header (it forces a CORS preflight, which this server never grants).
  const makeUserGuard = (kind: "json" | "tunnel") => async (req: FastifyRequest, reply: FastifyReply) => {
    const p = await authenticateSession(cfg, db, req.headers.cookie);
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const safe = req.method === "GET" || req.method === "HEAD";
    if (!safe && kind === "json" && req.method !== "DELETE" && !req.headers["content-type"]?.startsWith("application/json")) return reply.code(415).send({ error: "json_required" });
    if (!safe && kind === "tunnel" && req.headers["x-factory-ui"] !== "1") return reply.code(403).send({ error: "missing_ui_header" });
    // Defence in depth on top of SameSite=Strict: a cookie-authenticated mutation must come from our own origin.
    const origin = req.headers.origin;
    if (!safe && origin && origin !== cfg.WEBAUTHN_ORIGIN) return reply.code(403).send({ error: "bad_origin" });
    req.user = p;
  };
  const requireUser = makeUserGuard("json");
  const uuidParam = (v: unknown) => { if (!isUuid(v)) throw new CommandError("invalid", "invalid id"); return v; };

  // ================= Factory-facing API (bearer factory token) =================
  app.post("/v1/factory/heartbeat", { preHandler: requireFactory }, async (req) => {
    const b = heartbeatBody.parse(req.body ?? {});
    await db.query("UPDATE factories SET last_seen_at = now(), status = CASE WHEN status='registered' THEN 'active' ELSE status END, version = COALESCE($2, version), metadata = metadata || $3::jsonb WHERE id = $1",
      [req.factory!.factoryId, b.version ?? null, JSON.stringify(b.metadata ?? {})]);
    return { ok: true, serverTime: new Date().toISOString() };
  });

  // Long-poll for commands. Wake-ups arrive over Redis pub/sub from whichever replica handled the
  // dispatch, so it does not matter which replica this factory happens to be connected to. A short DB
  // re-check interval means delivery still works if Redis pub/sub is down.
  app.get("/v1/factory/commands/next", { preHandler: requireFactory }, async (req, reply) => {
    const q = z.object({ wait: z.coerce.number().int().min(0).max(cfg.POLL_MAX_WAIT_SECONDS).default(0), limit: z.coerce.number().int().min(1).max(20).default(5) }).parse(req.query);
    const factoryId = req.factory!.factoryId;
    let wake: (() => void) | undefined;
    const unsub = q.wait > 0 ? await bus.subscribe(channels.wake(factoryId), () => wake?.()).catch(() => undefined) : undefined;
    const deadline = Date.now() + q.wait * 1000;
    let aborted = false;
    const onClose = () => { aborted = true; wake?.(); };
    req.raw.on("close", onClose);
    try {
      for (;;) {
        const cmds = await commands.claim(factoryId, q.limit);
        if (cmds.length) {
          req.log.info({ commandIds: cmds.map((c) => c.id) }, "commands delivered");
          return { commands: cmds.map((c) => ({ id: c.id, type: c.type, payload: c.payload, repeatable: c.repeatable, expiresAt: c.expires_at, leaseToken: c.lease_token, leaseExpiresAt: c.lease_expires_at, attempt: c.attempts })) };
        }
        const left = deadline - Date.now();
        if (left <= 0 || aborted || state.shuttingDown) return reply.code(204).send();
        await new Promise<void>((res) => { const t = setTimeout(res, Math.min(left, 3000)); wake = () => { clearTimeout(t); res(); }; shutdownWaiters.add(wake); });
        shutdownWaiters.delete(wake!);
      }
    } finally { req.raw.off("close", onClose); await unsub?.(); }
  });

  app.post("/v1/factory/commands/:id/ack", { preHandler: requireFactory }, async (req, reply) => {
    const id = uuidParam((req.params as { id: string }).id); const b = ackBody.parse(req.body);
    const r = await commands.ack(req.factory!.factoryId, id, b.leaseToken, b.extendSeconds);
    if (r.ok) return { ok: true };
    req.log.warn({ commandId: id, status: r.status }, "ack refused");
    return reply.code(409).send({ ok: false, status: r.status, execute: false }); // factory MUST NOT execute
  });

  app.post("/v1/factory/commands/:id/result", { preHandler: requireFactory }, async (req, reply) => {
    const id = uuidParam((req.params as { id: string }).id); const b = completeBody.parse(req.body);
    const r = await commands.complete(req.factory!.factoryId, id, b.leaseToken, b.outcome, b.result, b.error);
    if (r.ok) { req.log.info({ commandId: id, outcome: b.outcome, duplicate: r.duplicate }, "command result recorded"); return { ok: true }; }
    return reply.code(409).send({ ok: false, status: r.status });
  });

  app.post("/v1/factory/events", { preHandler: requireFactory }, async (req) => {
    const b = eventsBody.parse(req.body);
    const accepted = await ingestEvents(db, bus, req.factory!.factoryId, req.factory!.orgId, b);
    return { ok: true, accepted, duplicates: b.events.length - accepted };
  });

  app.post("/v1/factory/sync", { preHandler: requireFactory }, async (req) => {
    await syncMetadata(db, req.factory!.factoryId, syncBody.parse(req.body));
    return { ok: true };
  });

  // ================= Dashboard/user API (database-backed session cookie) =================
  app.post("/v1/factories", { preHandler: requireUser }, async (req, reply) => {
    const b = registerBody.parse(req.body);
    const role = await orgRole(db, req.user!.userId, b.orgId);
    if (role !== "owner" && role !== "admin") return reply.code(403).send({ error: "forbidden" });
    const out = await db.tx(async (q) => {
      const f = await q.query<{ id: string }>("INSERT INTO factories (org_id, name, owner_user_id) VALUES ($1,$2,$3) ON CONFLICT (org_id, name) DO NOTHING RETURNING id", [b.orgId, b.name, req.user!.userId]);
      if (!f.rows[0]) return null;
      const token = await issueFactoryCredential(cfg, q, f.rows[0].id);
      await audit(q, b.orgId, "user", req.user!.userId, "factory.register", f.rows[0].id, { name: b.name });
      return { factoryId: f.rows[0].id, token };
    });
    if (!out) return reply.code(409).send({ error: "conflict", message: "a factory with that name already exists" });
    return reply.code(201).header("cache-control", "no-store").send({ ...out, note: "Store this token now; it is not shown again." });
  });

  app.post("/v1/factories/:id/commands", { preHandler: requireUser }, async (req, reply) => {
    const factoryId = uuidParam((req.params as { id: string }).id); const b = createCommandBody.parse(req.body);
    const { command, created } = await commands.create(req.user!.userId, factoryId, b);
    req.log.info({ commandId: command.id, factoryId, type: b.type, created }, "command created");
    return reply.code(created ? 202 : 200).send({ id: command.id, status: command.status, expiresAt: command.expires_at, duplicate: !created });
  });

  app.get("/v1/commands/:id", { preHandler: requireUser }, async (req) => {
    const c = await commands.get(req.user!.userId, uuidParam((req.params as { id: string }).id));
    return { id: c.id, factoryId: c.factory_id, type: c.type, status: c.status, attempts: c.attempts, expiresAt: c.expires_at, completedAt: c.completed_at, result: c.result, error: c.error };
  });

  app.post("/v1/commands/:id/revoke", { preHandler: requireUser }, async (req) => {
    const c = await commands.revoke(req.user!.userId, uuidParam((req.params as { id: string }).id));
    req.log.info({ commandId: c.id }, "command revoked");
    return { id: c.id, status: c.status };
  });

  // Live updates: events published to Redis by any replica reach any dashboard connection.
  app.get("/v1/orgs/:id/stream", { preHandler: requireUser }, async (req, reply) => {
    const orgId = uuidParam((req.params as { id: string }).id);
    if (!(await orgRole(db, req.user!.userId, orgId))) return reply.code(403).send({ error: "forbidden" });
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (m: string) => reply.raw.write(`data: ${m}\n\n`);
    const unsub = await bus.subscribe(channels.org(orgId), send);
    const ping = setInterval(() => reply.raw.write(": keepalive\n\n"), 20_000);
    const done = () => { clearInterval(ping); void unsub(); shutdownWaiters.delete(end); };
    const end = () => { done(); reply.raw.end(); };
    shutdownWaiters.add(end);
    req.raw.on("close", done);
  });

  registerAuthRoutes(app as unknown as FastifyInstance, d, requireUser);
  registerDashboardRoutes(app as unknown as FastifyInstance, d, requireUser);
  registerUi(app as unknown as FastifyInstance);
  registerTunnelRoutes(app as unknown as FastifyInstance, d, makeUserGuard("tunnel"), requireFactory);
  return app as unknown as FastifyInstance;
}
