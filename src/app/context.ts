import { readGrants } from "../core/approvals.js";
import { join } from "node:path";
import type { Logger } from "pino";
import { ClaudeCodeAgent } from "../agents/claude.js";
import { LocalModelClient } from "../agents/local.js";
import { ModelRouter } from "../agents/router.js";
import { AgentRunner } from "../agents/runner.js";
import { readLimits, usageFile } from "../agents/usage.js";
import { ConfigError } from "../config/load.js";
import { effectiveProtectedPaths, planningModeOf, type LoadedConfig, type ProjectConfig } from "../config/schema.js";
import { openDb, type DbHandle } from "../db/client.js";
import { Engine, type HandlerRegistry } from "../core/engine.js";
import type { LinearClient } from "../linear/client.js";
import { trackerSet, type TrackerSet } from "../tracker/index.js";
import { createIntakeHandlers } from "../linear/handlers.js";
import { createLinearReporter } from "../linear/reporter.js";
import { createLogger } from "../logging/logger.js";
import { createHosts, type Hosts } from "../host/index.js";
import { syncProjects } from "../repo/registry.js";
import { WorktreeManager } from "../repo/worktrees.js";
import { createSpecKitHandlers } from "../speckit/handlers.js";
import { createPromptHandlers } from "../planning/handlers.js";
import { createImplementationHandlers, type ImplDeps } from "../implement/handlers.js";
import { createDeliveryHandlers, type DeliveryDeps } from "../delivery/handlers.js";
import type { GitHubClient } from "../github/client.js";

export interface Context {
  config: LoadedConfig;
  handle: DbHandle;
  logger: Logger;
  router: ModelRouter;
  runner: AgentRunner;
  worktrees: WorktreeManager;
  linear: (projectId?: string) => LinearClient;
  /** Which tracker connection each project uses, with its client and names. */
  trackers: TrackerSet;
  project: (id: string) => ProjectConfig;
  handlers: HandlerRegistry;
  engine: Engine;
  hosts: Hosts;
}

/** The paths agents may never write: the one list both the agent runner and the implementation checks use (always includes the repo's factory settings file). */
export const protectedPathsOf = (config: LoadedConfig): string[] => effectiveProtectedPaths(config.factory.protectedPaths);

/** Wires every real component together. Tests substitute `agents`, `linear` and `db`; nothing here is a mock. */
export function createContext(config: LoadedConfig, opts: { db?: DbHandle; logger?: Logger; linear?: LinearClient; claudeBin?: string; agents?: ConstructorParameters<typeof ModelRouter>[1]; runCommand?: ImplDeps["runCommand"]; github?: GitHubClient; hosts?: Hosts; delivery?: DeliveryDeps["timing"]; deliveryNow?: DeliveryDeps["now"]; push?: DeliveryDeps["push"] } = {}): Context {
  const dataDir = config.factory.dataDir;
  const logger = opts.logger ?? createLogger({ level: config.factory.logLevel, file: join(dataDir, "logs", "factory.log") });
  const handle = opts.db ?? openDb(join(dataDir, "database", "factory.sqlite"));
  syncProjects(handle.db, config.projects.projects);
  // Looked up live (not copied into a Map): the settings UI adds and edits projects while the service runs.
  const project = (id: string): ProjectConfig => {
    const p = config.projects.projects.find((x) => x.id === id);
    if (!p) throw new ConfigError(`unknown project "${id}"`);
    return p;
  };

  const hosts = opts.hosts ?? createHosts(config);
  const router = new ModelRouter(config.models, opts.agents ?? {
    anthropic: new ClaudeCodeAgent({ bin: opts.claudeBin }),
    local: new LocalModelClient({ baseUrl: config.models.local.baseUrl }),
  }, (id) => config.projects.projects.find((p) => p.id === id)?.overrides?.models);
  const runner = new AgentRunner({ db: handle.db, router, logDir: join(dataDir, "logs", "agents"), protectedPaths: protectedPathsOf(config), usageFile: usageFile(dataDir),
    access: (id) => config.projects.projects.find((p) => p.id === id)?.overrides?.agentAccess ?? config.factory.agentAccess,
    projectBashAllow: (id) => config.projects.projects.find((p) => p.id === id)?.agentBashAllow ?? [],
    readGrants: (jobId) => readGrants(handle.db, jobId),
  });
  const worktrees = new WorktreeManager({
    db: handle.db, logger, workspacesRoot: join(dataDir, "workspaces"),
    repoPath: (id) => project(id).repository, defaultBranch: (id) => project(id).defaultBranch,
    networkEnv: (id) => hosts.gitAuth(project(id)),
  });
  const trackers = trackerSet(config, {}, opts.linear);
  const linear = (projectId?: string): LinearClient => trackers.client(trackers.idOf(projectId ? config.projects.projects.find((p) => p.id === projectId) : undefined));

  const stageDeps = { db: handle.db, runner, router, worktrees, linear, project, fallback: config.models.independentReviewFallback, logger };
  const planningMode = () => planningModeOf(config);
  // REQUIREMENTS_ANALYSIS is the one stage both planning modes share: in haiku_prompt mode the Spec Kit stages after it are skipped by the workflow.
  const speckit = createSpecKitHandlers(stageDeps);
  const prompt = createPromptHandlers(stageDeps);
  const specHandlers: HandlerRegistry = { ...speckit, REQUIREMENTS_ANALYSIS: (ctx) => (planningMode() === "speckit" ? speckit.REQUIREMENTS_ANALYSIS : prompt.REQUIREMENTS_ANALYSIS)(ctx) };
  const handlers: HandlerRegistry = {
    ...createIntakeHandlers({ db: handle.db, linear, linearConfig: config.linear, linearNames: (id) => trackers.names(trackers.idOf(project(id))), project }),
    ...specHandlers,
    ...createImplementationHandlers({
      db: handle.db, runner, router, worktrees, linear, project, fallback: config.models.independentReviewFallback, logger,
      dataDir, runCommand: opts.runCommand, planningMode, github: (p) => opts.github ?? hosts.pr(p), fetchEnv: (p) => hosts.gitAuth(p), maxConflictResolutions: () => config.factory.workflow.max_conflict_resolutions, agentAccess: (id) => config.projects.projects.find((p) => p.id === id)?.overrides?.agentAccess ?? config.factory.agentAccess, maxPasses: (id) => config.projects.projects.find((p) => p.id === id)?.overrides?.maxImplementationPasses ?? config.factory.maxImplementationPasses, settings: { protectedPaths: protectedPathsOf(config), commandTimeoutSeconds: config.factory.commandTimeoutSeconds, sandbox: config.factory.sandbox },
    }),
    // PR-only delivery: push + open the PR, watch CI, report readiness, wait for a human to merge. The factory never merges.
    ...createDeliveryHandlers({
      db: handle.db, runner, router, worktrees, linear, project, fallback: config.models.independentReviewFallback, logger, dataDir,
      github: (p) => opts.github ?? hosts.pr(p), hosts, maxConflictResolutions: () => config.factory.workflow.max_conflict_resolutions, timing: opts.delivery, now: opts.deliveryNow, push: opts.push,
    }),
  };
  const engine = new Engine({ db: handle.db, logger, config, handlers, claudeLimits: () => readLimits(usageFile(dataDir)), observer: createLinearReporter(handle.db, { globalDryRun: () => config.factory.dryRun, planningMode }) });
  return { config, handle, logger, router, runner, worktrees, linear, trackers, project, handlers, engine, hosts };
}
