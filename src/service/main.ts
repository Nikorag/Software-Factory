import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { createContext, type Context } from "../app/context.js";
import type { LoadedConfig } from "../config/schema.js";
import { ensureClone } from "../repo/clone.js";
import { validateProjects } from "../repo/registry.js";
import { discoverIssues } from "../linear/discovery.js";
import { flushOutbox } from "../linear/outbox.js";
import { buildServer, loadOrCreateToken } from "../server/app.js";
import { sandboxAvailable } from "../exec/sandbox.js";
import { findBinary } from "../speckit/tools.js";
import { acquireLock } from "./lock.js";
import { HealthChecker } from "./metrics.js";
import { Scheduler } from "./scheduler.js";
import { LocalModelClient } from "../agents/local.js";
import { createLinearClient } from "../linear/client.js";
import { createProjectActions } from "./actions.js";
import { resolveSecret, saveSecret } from "./secrets.js";
import { TaskManager } from "./tasks.js";
import { UpdateChecker } from "./versions.js";

const run = promisify(execFile);

export interface Service { ctx: Context; scheduler?: Scheduler; app: FastifyInstance; token: string; port: number; stop(): Promise<void> }

/**
 * Starts the factory: single-instance lock, the dashboard/API on loopback, and (unless disabled) the scheduler that
 * discovers tickets and runs jobs. Everything persistent lives in SQLite, so stopping and starting is always safe.
 */
export async function startService(config: LoadedConfig, opts: { scheduler?: boolean; ctx?: Context; port?: number } = {}): Promise<Service> {
  const lock = acquireLock(join(config.factory.dataDir, "factory.lock"));
  const ctx = opts.ctx ?? createContext(config);
  const { logger } = ctx;
  const port = opts.port ?? config.factory.server.port;
  const token = loadOrCreateToken(config.factory.dataDir);

  const usesLocal = Object.values(config.models.routes).some((r) => r.provider === "local");
  const health = new HealthChecker({
    claudeAuth: async () => (await run("claude", ["auth", "status"], { timeout: 10_000 })).stdout,
    linearViewer: async () => ctx.linear().viewer(),
    ghAuth: async () => { const r = await run("gh", ["auth", "status"], { timeout: 10_000 }).catch((e) => e as { stdout?: string; stderr?: string }); return `${r.stdout ?? ""}${r.stderr ?? ""}`; },
    sandboxAvailable, specifyInstalled: () => findBinary("specify") !== null,
    localModels: usesLocal ? () => new LocalModelClient({ baseUrl: config.models.local.baseUrl }).listModels() : undefined,
  });

  const scheduler = opts.scheduler === false ? undefined : new Scheduler({
    db: ctx.handle.db, engine: ctx.engine, logger,
    intervals: { discoveryMs: config.factory.pollIntervalSeconds * 1000 },
    // Nothing to poll before the first project is added (first run): do not complain about a missing Linear key yet.
    discover: async () => config.projects.projects.length === 0 ? { enqueued: [], skipped: [], errors: [] } : discoverIssues({ db: ctx.handle.db, client: ctx.linear(), linear: config.linear, projects: config.projects.projects, logger, dryRun: config.factory.dryRun }),
    flush: async () => (config.factory.dryRun ? { sent: 0, failed: 0, pending: 0 } : flushOutbox({ db: ctx.handle.db, client: ctx.linear(), linear: config.linear, logger })),
    validate: async () => {
      for (const p of config.projects.projects.filter((x) => x.enabled && x.managed)) { const c = await ensureClone(p); if (c.status === "error") logger.warn({ project: p.id, err: c.error }, "clone failed"); }
      await validateProjects(ctx.handle.db, config.projects.projects);
    },
  });

  const keySrc = { envName: config.linear.apiKeyEnv, keychainService: config.linear.keychainService };
  const settings = {
    tasks: new TaskManager(), actions: createProjectActions(ctx), linear: () => ctx.linear(), linearKeyPresent: () => Boolean(resolveSecret(keySrc)),
    saveLinearKey: async (key: string) => { const me = await createLinearClient({ apiKey: key }).viewer(); saveSecret(keySrc, key); return { name: me.name }; },
  };
  const app = buildServer({ db: ctx.handle.db, logger, config, engine: ctx.engine, scheduler, health, dataDir: config.factory.dataDir, port, controlToken: token, settings, updates: new UpdateChecker() });
  try {
    await app.listen({ host: config.factory.server.host, port });
  } catch (e) { lock.release(); throw e; }
  scheduler?.start();
  logger.info({ port, scheduler: Boolean(scheduler), dryRun: config.factory.dryRun, mergeMode: config.factory.mergeMode }, "factory service started");

  let stopped = false;
  return {
    ctx, scheduler, app, token, port,
    async stop() {
      if (stopped) return; stopped = true;
      logger.info("factory service stopping");
      await scheduler?.stop();
      await app.close();
      ctx.handle.close();
      lock.release();
    },
  };
}
