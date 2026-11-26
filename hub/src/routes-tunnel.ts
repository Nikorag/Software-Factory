import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateSession, can } from "./auth.js";
import { audit } from "./commands.js";
import { channels } from "./infra.js";
import type { Deps } from "./server.js";

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

// The hub serves the SAME React dashboard that runs on the factory (web/), and tunnels its /api calls to that
// factory: browser -> hub (/f/<id>/api/*) -> Redis relay -> factory long-poll -> factory's local API -> back.
// The hub never interprets these calls; the factory decides what is allowed (its remote-access policy).

const SAFE_ASSET = /^[\w.-]+$/;
const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json" };
const MAX_REQ_BODY = 64 * 1024;
const MAX_RES_BODY = 5 * 1024 * 1024;
const ONLINE_WITHIN_S = 90;
// Only these response headers are relayed back to the browser: the factory cannot set cookies or redirects on our origin.
const RELAYED = new Set(["content-type"]);

export function webDistDir(configured?: string): string {
  if (configured) return configured;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "web"), join(here, "..", "..", "web", "dist")]) if (existsSync(join(c, "index.html"))) return c;
  return join(here, "web");
}

export function registerTunnelRoutes(app: FastifyInstance, d: Deps, requireUserTunnel: Guard, requireFactory: Guard) {
  const { cfg, db, bus, tunnel } = d;
  const webDir = webDistDir(cfg.WEB_DIST_DIR);
  const uuid = (v: unknown) => z.uuid().parse(v);

  // ================= Factory side =================
  app.get("/v1/factory/tunnel/next", { preHandler: requireFactory }, async (req, reply) => {
    const q = z.object({ wait: z.coerce.number().int().min(0).max(cfg.POLL_MAX_WAIT_SECONDS).default(0), limit: z.coerce.number().int().min(1).max(20).default(10) }).parse(req.query);
    const factoryId = req.factory!.factoryId;
    // A poll proves the factory is alive: that is how the dashboard knows it is online without waiting for a heartbeat.
    await db.query("UPDATE factories SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 seconds')", [factoryId]);
    let wake: (() => void) | undefined; let aborted = false;
    const unsub = q.wait > 0 ? await bus.subscribe(channels.tunnel(factoryId), () => wake?.()).catch(() => undefined) : undefined;
    const onClose = () => { aborted = true; wake?.(); };
    req.raw.on("close", onClose);
    const deadline = Date.now() + q.wait * 1000;
    try {
      for (;;) {
        const requests = await tunnel.take(factoryId, q.limit);
        if (requests.length) return { requests };
        const left = deadline - Date.now();
        if (left <= 0 || aborted || d.state.shuttingDown) return reply.code(204).send();
        await new Promise<void>((ok) => { const t = setTimeout(ok, Math.min(left, 2000)); wake = () => { clearTimeout(t); ok(); }; });
      }
    } finally { req.raw.off("close", onClose); await unsub?.(); }
  });

  app.post("/v1/factory/tunnel/:id/response", { preHandler: requireFactory, bodyLimit: Math.ceil(MAX_RES_BODY * 1.4) }, async (req, reply) => {
    const id = uuid((req.params as { id: string }).id);
    const b = z.object({ status: z.number().int().min(100).max(599), headers: z.record(z.string(), z.string()).default({}), bodyBase64: z.string().max(Math.ceil(MAX_RES_BODY * 1.4)) }).parse(req.body);
    const ok = await tunnel.respond(id, { status: b.status, headers: b.headers, bodyBase64: b.bodyBase64 });
    return ok ? { ok: true } : reply.code(404).send({ ok: false, error: "expired" });
  });

  // ================= Browser side =================
  // The dashboard shell for one factory: the same index.html the factory serves, told which factory it is showing.
  const serveIndex = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!z.uuid().safeParse(id).success) return reply.code(404).send({ error: "not_found" });
    const who = await authenticateSession(cfg, db, req.headers.cookie);
    if (!who) return reply.redirect("/");
    if (!(await can(db, who.userId, id, "view"))) return reply.code(404).send({ error: "not_found" });
    const file = join(webDir, "index.html");
    if (!existsSync(file)) return reply.code(503).send({ error: "dashboard_not_built", message: "the web dashboard is not bundled in this image" });
    const html = readFileSync(file, "utf8").replace('<meta name="factory-hub-base" content="" />', `<meta name="factory-hub-base" content="/f/${id}" />`);
    return reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").send(html);
  };
  app.get("/f/:id", serveIndex);
  app.get("/f/:id/", serveIndex);

  // Static build output (hashed filenames, no secrets): same files the factory serves from web/dist/assets.
  app.get("/assets/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!SAFE_ASSET.test(file) || file.startsWith(".")) return reply.code(404).send({ error: "not_found" });
    const path = join(webDir, "assets", file);
    if (!existsSync(path)) return reply.code(404).send({ error: "not_found" });
    const ext = file.slice(file.lastIndexOf("."));
    return reply.header("content-type", TYPES[ext] ?? "application/octet-stream").header("cache-control", "public, max-age=31536000, immutable").send(readFileSync(path));
  });

  // The API tunnel. Own plugin scope so bodies stay raw bytes (we never parse or alter what the dashboard sends).
  void app.register(async (inst) => {
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_REQ_BODY }, (_req, body, done) => done(null, body));

    inst.route({
      method: ["GET", "POST", "PUT", "DELETE"], url: "/f/:id/api/*", preHandler: requireUserTunnel,
      handler: async (req, reply) => {
        const { id: factoryId } = req.params as { id: string };
        if (!z.uuid().safeParse(factoryId).success) return reply.code(404).send({ error: "not_found" });
        const userId = req.user!.userId, mutating = req.method !== "GET";
        if (!(await d.limiter.allow(`tunnel:${userId}`, cfg.TUNNEL_RATE_LIMIT_PER_MINUTE))) return reply.code(429).send({ error: "rate_limited" });
        if (!(await can(db, userId, factoryId, mutating ? "command" : "view"))) return reply.code(mutating ? 403 : 404).send({ error: mutating ? "forbidden" : "not_found" });

        const f = (await db.query<{ org_id: string; status: string; online: boolean; remote: boolean }>(
          `SELECT org_id, status, (last_seen_at > now() - $2 * interval '1 second') AS online, COALESCE((metadata->>'remoteAccess')::boolean, false) AS remote FROM factories WHERE id = $1`, [factoryId, ONLINE_WITHIN_S])).rows[0];
        if (!f) return reply.code(404).send({ error: "not_found" });
        if (f.status === "disabled") return reply.code(409).send({ error: "factory_disabled", message: "This factory has been disabled." });
        if (!f.remote) return reply.code(409).send({ error: "remote_access_disabled", message: "Remote access is off on this factory. On that machine run: software-factory hub remote-access on" });
        if (!f.online) return reply.code(504).send({ error: "factory_offline", message: "The factory is not connected to the hub right now." });

        const path = req.url.slice(`/f/${factoryId}`.length); // "/api/..." plus query, exactly as sent
        const ct = req.headers["content-type"], accept = req.headers.accept;
        const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
        const id = randomUUID();
        const accepted = await tunnel.push(factoryId, {
          id, method: req.method, path, expiresAt: new Date(Date.now() + cfg.TUNNEL_TIMEOUT_SECONDS * 1000).toISOString(),
          headers: { ...(ct ? { "content-type": String(ct) } : {}), ...(accept ? { accept: String(accept) } : {}) }, ...(body ? { bodyBase64: body.toString("base64") } : {}),
        });
        if (!accepted) return reply.code(503).send({ error: "factory_busy", message: "Too many requests are waiting for this factory." });
        req.log = req.log.child({ factoryId, tunnelId: id });
        // Audit who changed what (method + route only: never the body, which may carry settings or answers).
        if (mutating) await audit(db, f.org_id, "user", userId, "tunnel.request", factoryId, { method: req.method, path: path.split("?")[0] });

        const res = await tunnel.awaitResponse(id, cfg.TUNNEL_TIMEOUT_SECONDS * 1000);
        if (!res) return reply.code(504).send({ error: "factory_timeout", message: "The factory did not respond in time." });
        for (const [k, v] of Object.entries(res.headers)) if (RELAYED.has(k.toLowerCase())) reply.header(k.toLowerCase(), v);
        return reply.code(res.status).header("cache-control", "no-store").send(Buffer.from(res.bodyBase64, "base64"));
      },
    });
  });
}
