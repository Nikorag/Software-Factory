import { generateKeyPairSync } from "node:crypto";
import { ConfigError, loadConfig } from "./config.js";
import { createPgDb } from "./db.js";
import { createHub } from "./hub.js";
import { createBullQueue, createRedisBus, createRedisRateLimiter, createRedisTunnel } from "./infra.js";
import { createLogger } from "./log.js";
import { loadMigrations, migrate, pendingMigrations } from "./migrate.js";

const cmd = process.argv[2] ?? "serve";

function fatal(msg: string): never { process.stderr.write(JSON.stringify({ level: "fatal", msg }) + "\n"); process.exit(1); }

async function main() {
  if (cmd === "vapid-generate") { // handy for first-time setup; prints to stdout only
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pub = publicKey.export({ format: "jwk" }); const priv = privateKey.export({ format: "jwk" });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, "base64url"), Buffer.from(pub.y!, "base64url")]);
    process.stdout.write(`VAPID_PUBLIC_KEY=${raw.toString("base64url")}\nVAPID_PRIVATE_KEY=${priv.d}\n`);
    return;
  }
  if (cmd === "healthcheck") { // used by the Dockerfile HEALTHCHECK (distroless has no curl)
    const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/healthz/live`, { signal: AbortSignal.timeout(3000) });
    process.exit(r.ok ? 0 : 1);
  }
  if (!["serve", "migrate", "migrate-status"].includes(cmd)) fatal(`unknown command '${cmd}' (serve | migrate | migrate-status | vapid-generate | healthcheck)`);

  let cfg;
  try { cfg = loadConfig(); } catch (e) { if (e instanceof ConfigError) fatal(e.message); throw e; }
  const log = createLogger(cfg.LOG_LEVEL);

  if (cmd === "migrate" || cmd === "migrate-status") {
    const db = createPgDb(cfg);
    try {
      if (cmd === "migrate-status") { const p = await pendingMigrations(db); log.info({ pending: p }, p.length ? "migrations pending" : "schema up to date"); process.exitCode = p.length ? 2 : 0; return; }
      const applied = await migrate(db, loadMigrations(), (m) => log.info(m));
      log.info({ applied }, applied.length ? "migrations applied" : "no migrations to apply");
    } finally { await db.close(); }
    return;
  }

  const bus = createRedisBus(cfg);
  const hub = createHub(cfg, { db: createPgDb(cfg), bus, tunnel: createRedisTunnel(cfg, bus), queue: createBullQueue(cfg), limiter: createRedisRateLimiter(cfg) }, log);
  let closing = false;
  const stop = (sig: string) => {
    if (closing) return; closing = true;
    log.info({ signal: sig }, "signal received");
    setTimeout(() => { log.error("shutdown timed out; forcing exit"); process.exit(1); }, cfg.SHUTDOWN_TIMEOUT_MS).unref();
    hub.shutdown().then(() => process.exit(0), (e) => { log.error({ err: (e as Error).message }, "shutdown failed"); process.exit(1); });
  };
  process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (e) => log.error({ err: (e as Error)?.message }, "unhandled rejection"));
  await hub.start();
  log.info({ port: cfg.PORT }, "listening");
}

main().catch((e) => fatal(e instanceof Error ? e.message : String(e)));
