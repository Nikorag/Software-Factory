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
// The dashboard is the built React app (pnpm web:build -> web/dist). Only index.html and files directly under assets/ are ever served.
const DASHBOARD_DIR = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const SAFE_NAME = /^[\w.-]+$/;

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

/** Mutating requests and anything that is not a 2xx are worth keeping; successful reads (mostly polling) are debug-only. */
export function requestLogLevel(method: string, statusCode: number): "info" | "debug" {
  const read = method === "GET" || method === "HEAD" || method === "OPTIONS";
  return !read || statusCode < 200 || statusCode >= 300 ? "info" : "debug";
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  // Fastify's own per-request logging is off: the dashboard and the menu bar app poll several endpoints every few seconds, which
  // filled factory.log with ~150k lines a day. requestLogLevel() decides instead: changes and errors at info, routine reads at debug.
  const app: FastifyInstance = Fastify({ loggerInstance: deps.logger as FastifyBaseLogger, bodyLimit: 16 * 1024, disableRequestLogging: true });
  // disableRequestLogging also silences Fastify's default error log, so keep server errors (with their stack) ourselves.
  app.addHook("onError", async (req, _reply, err) => {
    if ((err.statusCode ?? 500) >= 500) req.log.error({ err }, "request failed");
  });
  app.addHook("onResponse", async (req, reply) => {
    req.log[requestLogLevel(req.method, reply.statusCode)]({ method: req.method, url: req.url.split("?")[0], statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "request");
  });
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

  // Two ways to make a change:
  //  - the dashboard itself: a same-origin browser request (our own Origin, the X-Factory-UI header, and no cross-site Sec-Fetch-Site).
  //    A page on another origin cannot set that header without a CORS preflight, which this server never grants, and browsers
  //    attach Origin / Sec-Fetch-Site themselves so a web page cannot forge them. No token to paste, no read-only mode.
  //  - the CLI and scripts: the bearer token from <dataDir>/control-token.
  // Not defended: another process on this machine can forge those headers. That is the accepted trade-off for a tokenless dashboard.
  const requireToken = async (req: FastifyRequest, reply: FastifyReply) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (deps.controlToken && m && sameToken(m[1]!, deps.controlToken)) return;
    const origin = req.headers.origin, site = req.headers["sec-fetch-site"];
    if (origin && hostOk(origin.replace(/^https?:\/\//, "")) && req.headers["x-factory-ui"] === "1" && (site === undefined || site === "same-origin")) return;
    return reply.code(401).send({ error: "this request is not from the dashboard and has no valid control token" });
  };

  app.get("/health", async () => {
    const state = deps.db.select().from(factoryState).where(eq(factoryState.id, 1)).get();
    return { status: "ok", paused: state?.paused ?? false, emergencyStop: state?.emergencyStop ?? false };
  });

  const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const sendAsset = (reply: FastifyReply, path: string) => {
    if (!existsSync(path)) return reply.code(404).send({ error: "dashboard assets missing: run `pnpm web:build`" });
    const ext = path.slice(path.lastIndexOf("."));
    reply.header("Content-Type", TYPES[ext] ?? "application/octet-stream");
    // No inline script/style, no third-party origins: ticket text and agent logs are untrusted content.
    if (ext === ".html") reply.header("Content-Security-Policy", CSP);
    return readFileSync(path);
  };
  app.get("/", async (_req, reply) => sendAsset(reply, join(DASHBOARD_DIR, "index.html")));
  app.get<{ Params: { file: string } }>("/assets/:file", async (req, reply) => {
    if (!SAFE_NAME.test(req.params.file) || req.params.file.startsWith(".")) return reply.code(404).send({ error: "not found" });
    return sendAsset(reply, join(DASHBOARD_DIR, "assets", req.params.file));
  });

  registerApiRoutes(app, { ...deps, db: deps.db, logger: deps.logger } as ApiDeps, requireToken);
  return app;
}
