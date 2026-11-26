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
import { saveSecret } from "./secrets.js";
import { TaskManager } from "./tasks.js";
import { UpdateChecker } from "./versions.js";
import { bbStore } from "../bitbucket/auth.js";
import { keychainStore, trackerConfigured } from "../tracker/index.js";
import { pruneAgentLogs, rotateLogs } from "./retention.js";
import { addProfile, DEFAULT_PROFILE, factoryRoot, listProfiles, removeProfile } from "../config/profiles.js";
import { isUp, startService as launchService } from "./launch.js";
import { drainChildren, killAllChildren, reapOrphans, setChildPidDir } from "../agents/children.js";
import { agentPidDir, clearStopMarker, writeStopMarker } from "./runstate.js";

const run = promisify(execFile);

export interface Service { ctx: Context; scheduler?: Scheduler; app: FastifyInstance; token: string; port: number; stop(reason?: string): Promise<void> }

/**
 * Starts the factory: single-instance lock, the dashboard/API on loopback, and (unless disabled) the scheduler that
 * discovers tickets and runs jobs. Everything persistent lives in SQLite, so stopping and starting is always safe.
 */
export async function startService(config: LoadedConfig, opts: { scheduler?: boolean; ctx?: Context; port?: number; requestShutdown?: () => void; childGraceMs?: number } = {}): Promise<Service> {
  const dataDir = config.factory.dataDir;
  const lock = acquireLock(join(dataDir, "factory.lock"));
  clearStopMarker(dataDir);
  const ctx = opts.ctx ?? createContext(config);
  const { logger } = ctx;
  // Before anything can recover a job: kill agents (and their test runs) left behind by a previous service that died without
  // stopping them, or crash recovery would re-run the stage in the same worktree while the orphan is still editing it.
  const pidDir = agentPidDir(dataDir);
  const reaped = await reapOrphans(pidDir);
  if (reaped.killed.length) logger.warn({ processGroups: reaped.killed }, "killed agent processes left behind by the previous service");
  setChildPidDir(pidDir);
  const port = opts.port ?? config.factory.server.port;
  const token = loadOrCreateToken(config.factory.dataDir);

  const usesLocal = Object.values(config.models.routes).some((r) => r.provider === "local");
  const health = new HealthChecker({
    trackerName: config.factory.tracker,
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
    discover: async () => config.projects.projects.length === 0 ? { enqueued: [], skipped: [], errors: [] } : discoverIssues({ db: ctx.handle.db, client: ctx.linear(), linear: config.linear, projects: config.projects.projects, logger, dryRun: config.factory.dryRun, requireOnboarding: true, pickupMode: config.factory.pickupMode, workflows: config.workflows }),
    flush: async () => (config.factory.dryRun ? { sent: 0, failed: 0, pending: 0 } : flushOutbox({ db: ctx.handle.db, client: ctx.linear(), linear: config.linear, logger })),
    validate: async () => {
      for (const p of config.projects.projects.filter((x) => x.enabled && x.managed)) { const c = await ensureClone(p, { hosts: ctx.hosts }); if (c.status === "error") logger.warn({ project: p.id, err: c.error }, "clone failed"); }
      await validateProjects(ctx.handle.db, config.projects.projects, { hosts: ctx.hosts });
    },
  });

  const keySrc = { envName: config.linear.apiKeyEnv, keychainService: config.linear.keychainService };
  const settings = {
    tasks: new TaskManager(), actions: createProjectActions(ctx), linear: () => ctx.linear(), linearKeyPresent: () => trackerConfigured(config),
    saveLinearKey: async (key: string) => { const me = await createLinearClient({ apiKey: key }).viewer(); saveSecret(keySrc, key); return { name: me.name }; },
  };
  const app = buildServer({ shutdown: opts.requestShutdown, db: ctx.handle.db, logger, config, engine: ctx.engine, worktrees: ctx.worktrees, scheduler, health, dataDir: config.factory.dataDir, port, controlToken: token, settings, bitbucket: { store: bbStore(config.bitbucket.keychainService) }, jira: { store: keychainStore(config.jira.keychainService), port }, updates: new UpdateChecker(), profiles: {
    current: process.env.FACTORY_PROFILE ?? DEFAULT_PROFILE, list: () => listProfiles(), add: (n) => addProfile(n), remove: (n) => removeProfile(n),
    start: (p) => launchService(p, factoryRoot()), isUp: (p) => isUp(p),
  } });
  try {
    await app.listen({ host: config.factory.server.host, port });
  } catch (e) { setChildPidDir(null); lock.release(); throw e; }
  // Conversation and command logs are sensitive (ticket text, code, command output): prune on start and then daily.
  const logsDir = join(config.factory.dataDir, "logs");
  const prune = () => {
    for (const sub of ["agents", "commands"]) {
      try { const n = pruneAgentLogs(join(logsDir, sub), config.factory.logRetentionDays); if (n) logger.info({ removed: n, days: config.factory.logRetentionDays, dir: sub }, "pruned old logs"); } catch { /* best effort */ }
    }
  };
  prune();
  const pruneTimer = setInterval(prune, 24 * 3600_000); pruneTimer.unref();
  // factory.log, service.out and the LaunchAgent's stdout/stderr are append-only: cap them by size (checked on start and every 10 minutes).
  const rotate = () => { try { const r = rotateLogs(logsDir); if (r.length) logger.info({ rotated: r }, "rotated logs"); } catch { /* best effort */ } };
  rotate();
  const rotateTimer = setInterval(rotate, 10 * 60_000); rotateTimer.unref();
  scheduler?.start();
  logger.info({ port, scheduler: Boolean(scheduler), dryRun: config.factory.dryRun, mergeMode: config.factory.mergeMode }, "factory service started");

  let stopped = false;
  return {
    ctx, scheduler, app, token, port,
    async stop(reason = "stop requested") {
      if (stopped) return; stopped = true;
      writeStopMarker(dataDir, reason); // first, so the app can tell this stop from a crash however it ends
      clearInterval(pruneTimer); clearInterval(rotateTimer);
      logger.info({ reason }, "factory service stopping");
      await scheduler?.stop();
      // The engine is idle once each aborted stage has returned, which can be before its process group has exited (it gets
      // SIGTERM, then SIGKILL after a grace period). Wait for every child here, bounded, and kill whatever is left.
      killAllChildren("SIGTERM");
      const forced = await drainChildren(opts.childGraceMs ?? 8000);
      if (forced) logger.warn({ processGroups: forced }, "shutdown: killed agent processes that did not exit in time");
      await app.close();
      ctx.handle.close();
      setChildPidDir(null);
      lock.release();
    },
  };
}
