import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { FactoryDb } from "../db/client.js";
import { factoryState } from "../db/schema.js";
import { registerApiRoutes, type ApiDeps } from "./routes.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const ASSETS: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export interface ServerDeps extends Partial<Omit<ApiDeps, "db" | "logger">> {
  db: FactoryDb;
  logger: Logger;
  /** The port the server listens on: used to allow only our own Host/Origin (DNS-rebinding defence). */
  port?: number;
  /** Bearer token required by every mutating call. Without one, mutating calls are refused outright. */
  controlToken?: string;
}

/** A token the dashboard needs for controls. Created once, readable only by the user, never logged. */
export function loadOrCreateToken(dataDir: string): string {
  const file = join(dataDir, "control-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

const sameToken = (a: string, b: string): boolean => {
  const [x, y] = [createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest()]; // equal length, constant time
  return timingSafeEqual(x, y);
};

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app: FastifyInstance = Fastify({ loggerInstance: deps.logger as FastifyBaseLogger, bodyLimit: 16 * 1024 });
  const hostOk = (host: string | undefined): boolean => {
    if (!host) return false;
    const h = host.toLowerCase();
    return deps.port ? [`127.0.0.1:${deps.port}`, `localhost:${deps.port}`, `[::1]:${deps.port}`].includes(h) : /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h);
  };

  // Defence in depth for a local control surface:
  //  1. only loopback peers;  2. only our own Host header (a rebinding page on evil.com resolving to 127.0.0.1 sends Host: evil.com);
  //  3. a cross-site browser request carries an Origin: it must be ours;  4. every mutating call needs the bearer token.
  app.addHook("onRequest", async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send({ error: "loopback only" });
    if (!hostOk(req.headers.host)) return reply.code(403).send({ error: "bad host" });
    const origin = req.headers.origin;
    if (origin && !hostOk(origin.replace(/^https?:\/\//, ""))) return reply.code(403).send({ error: "bad origin" });
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer").header("X-Frame-Options", "DENY");
  });

  const requireToken = async (req: FastifyRequest, reply: FastifyReply) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!deps.controlToken || !m || !sameToken(m[1]!, deps.controlToken)) return reply.code(401).send({ error: "control token required" });
  };

  app.get("/health", async () => {
    const state = deps.db.select().from(factoryState).where(eq(factoryState.id, 1)).get();
    return { status: "ok", paused: state?.paused ?? false, emergencyStop: state?.emergencyStop ?? false };
  });

  for (const [url, file] of Object.entries(ASSETS)) {
    app.get(url, async (_req, reply) => {
      const path = join(PUBLIC_DIR, file);
      if (!existsSync(path)) return reply.code(404).send({ error: "dashboard assets missing" });
      const ext = file.slice(file.lastIndexOf("."));
      reply.header("Content-Type", TYPES[ext]!);
      if (ext === ".html") {
        // No inline script/style, no third-party origins: ticket text and agent logs are untrusted content.
        reply.header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      }
      return readFileSync(path);
    });
  }

  registerApiRoutes(app, { ...deps, db: deps.db, logger: deps.logger } as ApiDeps, requireToken);
  return app;
}
