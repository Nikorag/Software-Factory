import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { createContext, type Context } from "../app/context.js";
import type { LoadedConfig } from "../config/schema.js";
import { decisions } from "../db/schema.js";
import { ensureClone } from "../repo/clone.js";
import { refreshRepoFile } from "../config/repo-file.js";
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
import { HubReporter } from "../hub/reporter.js";
import { HubTunnel } from "../hub/tunnel.js";
import { hubKey, readHubSettings } from "../hub/settings.js";
import { TaskManager } from "./tasks.js";
import { installedVersion, UpdateChecker } from "./versions.js";
import { bbStore } from "../bitbucket/auth.js";
import { jiraStoreFor, trackerConfigured, trackerIdsInUse } from "../tracker/index.js";
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
    claudeAuth: async () => (await run("claude", ["auth", "status"], { timeout: 10_000 })).stdout,
    trackers: () => trackerIdsInUse(config).map((id) => ({ name: id === "github" ? "github-issues" : id /* "github" is already the gh sign-in probe */, viewer: async () => ctx.trackers.client(id).viewer() })),
    ghAuth: async () => { const r = await run("gh", ["auth", "status"], { timeout: 10_000 }).catch((e) => e as { stdout?: string; stderr?: string }); return `${r.stdout ?? ""}${r.stderr ?? ""}`; },
    sandboxAvailable, specifyInstalled: () => findBinary("specify") !== null,
    localModels: usesLocal ? () => new LocalModelClient({ baseUrl: config.models.local.baseUrl }).listModels() : undefined,
  });

  const scheduler = opts.scheduler === false ? undefined : new Scheduler({
    db: ctx.handle.db, engine: ctx.engine, logger,
    intervals: { discoveryMs: config.factory.pollIntervalSeconds * 1000 },
    // Nothing to poll before the first project is added (first run): do not complain about a missing Linear key yet.
    discover: async () => config.projects.projects.length === 0 ? { enqueued: [], skipped: [], errors: [] } : discoverIssues({ db: ctx.handle.db, trackers: ctx.trackers, linear: config.linear, projects: config.projects.projects, logger, dryRun: config.factory.dryRun, requireOnboarding: true, planningMode: config.factory.workflow.planning_mode, pickupMode: config.factory.pickupMode }),
    flush: async () => (config.factory.dryRun ? { sent: 0, failed: 0, pending: 0 } : flushOutbox({ db: ctx.handle.db, trackers: ctx.trackers, projectOf: (id) => config.projects.projects.find((p) => p.id === id), linear: config.linear, logger })),
    validate: async () => {
      for (const p of config.projects.projects.filter((x) => x.enabled && x.managed)) { const c = await ensureClone(p, { hosts: ctx.hosts }); if (c.status === "error") logger.warn({ project: p.id, err: c.error }, "clone failed"); else { const r = await refreshRepoFile(p); if (r.status === "error") logger.warn({ project: p.id, err: r.error }, ".software-factory.yml not applied"); } }
      await validateProjects(ctx.handle.db, config.projects.projects, { hosts: ctx.hosts, planningMode: config.factory.workflow.planning_mode });
    },
  });

  const settings = {
    tasks: new TaskManager(), actions: createProjectActions(ctx), linear: (id?: string) => ctx.trackers.client(id ?? config.factory.tracker), linearKeyPresent: (id?: string) => trackerConfigured(config, undefined, id),
    saveLinearKey: async (key: string, id?: string) => {
      const c = config.connections[id ?? config.factory.tracker];
      if (!c || c.kind !== "linear") throw new Error("that is not a Linear connection");
      const me = await createLinearClient({ apiKey: key }).viewer();
      saveSecret({ keychainService: c.keychainService }, key);
      return { name: me.name };
    },
  };
  // The job chat: a read-only agent in an empty directory, told about one job. It records nothing against the job (no jobId).
  const chat = { run: async (r: { projectId: string; prompt: string; cwd: string; timeoutMs: number }) => {
    const res = await ctx.runner.run({ projectId: r.projectId, task: "final_review", role: "assistant", prompt: r.prompt, cwd: r.cwd, timeoutMs: r.timeoutMs });
    return { ok: res.ok, text: res.text, error: res.error };
  } };
  const app = buildServer({ chat, shutdown: opts.requestShutdown, db: ctx.handle.db, logger, config, engine: ctx.engine, worktrees: ctx.worktrees, scheduler, health, dataDir: config.factory.dataDir, port, controlToken: token, settings, bitbucket: { store: bbStore(config.bitbucket.keychainService) }, jira: { store: jiraStoreFor(config, "jira"), storeFor: (id) => jiraStoreFor(config, id), port }, updates: new UpdateChecker(), profiles: {
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
  // Reports to the hub only when the user has connected one (off by default). Settings are re-read each pass, so connect/disconnect apply live.
  let hubTimer: NodeJS.Timeout | undefined;
  let tunnel: HubTunnel | undefined, tunnelTimer: NodeJS.Timeout | undefined;
  if (opts.scheduler !== false) {
    const version = await installedVersion(async (file, args, cwd) => (await run(file, args, { cwd, timeout: 10_000 })).stdout);
    const reporter = new HubReporter({ db: ctx.handle.db, dataDir, logger, getSettings: () => readHubSettings(config.configDir), getKey: hubKey, version, tracker: config.factory.tracker, dryRun: config.factory.dryRun });
    let nextAt = 0;
    hubTimer = setInterval(() => {
      let every = config.factory.hub.reportIntervalSeconds;
      try { every = readHubSettings(config.configDir).reportIntervalSeconds; } catch { /* keep the startup value */ }
      if (Date.now() < nextAt) return;
      nextAt = Date.now() + every * 1000;
      void reporter.tick();
    }, 5000);
    hubTimer.unref();
    // The hub's web dashboard can operate this factory only if the user turned `hub.remoteAccess` on (separate from reporting, off by
    // default). Dashboard requests run through this same server in-process, filtered by src/hub/remote-policy.ts.
    tunnel = new HubTunnel({
      app, port, logger, getSettings: () => readHubSettings(config.configDir), getKey: hubKey,
      audit: (a) => { try { ctx.handle.db.insert(decisions).values({ kind: "remote.request", decision: `${a.method} ${a.route} -> ${a.status}`, actor: "hub-remote" }).run(); } catch { /* best effort */ } },
    });
    tunnelTimer = setInterval(() => tunnel?.sync(), 5000); tunnelTimer.unref();
    tunnel.sync();
  }
  scheduler?.start();
  logger.info({ port, scheduler: Boolean(scheduler), dryRun: config.factory.dryRun, mergeMode: config.factory.mergeMode }, "factory service started");

  let stopped = false;
  return {
    ctx, scheduler, app, token, port,
    async stop(reason = "stop requested") {
      if (stopped) return; stopped = true;
      writeStopMarker(dataDir, reason); // first, so the app can tell this stop from a crash however it ends
      clearInterval(pruneTimer); clearInterval(rotateTimer); if (hubTimer) clearInterval(hubTimer); if (tunnelTimer) clearInterval(tunnelTimer); tunnel?.stop();
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
