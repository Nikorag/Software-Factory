import { join } from "node:path";
import type { Logger } from "pino";
import { ClaudeCodeAgent } from "../agents/claude.js";
import { LocalModelClient } from "../agents/local.js";
import { ModelRouter } from "../agents/router.js";
import { AgentRunner } from "../agents/runner.js";
import { ConfigError } from "../config/load.js";
import type { LoadedConfig, ProjectConfig } from "../config/schema.js";
import { openDb, type DbHandle } from "../db/client.js";
import { Engine, type HandlerRegistry, type TypedHandlers } from "../core/engine.js";
import type { LinearClient } from "../linear/client.js";
import { createTrackerClient } from "../tracker/index.js";
import { createIntakeHandlers } from "../linear/handlers.js";
import { createLinearReporter } from "../linear/reporter.js";
import { createLogger } from "../logging/logger.js";
import { createHosts, type Hosts } from "../host/index.js";
import { syncProjects } from "../repo/registry.js";
import { WorktreeManager } from "../repo/worktrees.js";
import { createSpecKitHandlers } from "../speckit/handlers.js";
import { createImplementationHandlers, type ImplDeps } from "../implement/handlers.js";
import { createDeliveryHandlers, type DeliveryDeps } from "../delivery/handlers.js";
import type { GitHubClient } from "../github/client.js";
import { createTypedHandlers } from "../workflows/typed-handlers.js";
import { backfillJobSnapshots, syncBuiltinWorkflow } from "../workflows/library.js";

export interface Context {
  config: LoadedConfig;
  handle: DbHandle;
  logger: Logger;
  router: ModelRouter;
  runner: AgentRunner;
  worktrees: WorktreeManager;
  linear: () => LinearClient;
  project: (id: string) => ProjectConfig;
  handlers: HandlerRegistry;
  /** The reusable stage types (agent, review, check) that custom workflows are built from. */
  typed: TypedHandlers;
  engine: Engine;
  hosts: Hosts;
}

/** Wires every real component together. Tests substitute `agents`, `linear` and `db`; nothing here is a mock. */
export function createContext(config: LoadedConfig, opts: { db?: DbHandle; logger?: Logger; linear?: LinearClient; claudeBin?: string; agents?: ConstructorParameters<typeof ModelRouter>[1]; runCommand?: ImplDeps["runCommand"]; github?: GitHubClient; hosts?: Hosts; delivery?: DeliveryDeps["timing"]; deliveryNow?: DeliveryDeps["now"]; push?: DeliveryDeps["push"] } = {}): Context {
  const dataDir = config.factory.dataDir;
  const logger = opts.logger ?? createLogger({ level: config.factory.logLevel, file: join(dataDir, "logs", "factory.log") });
  const handle = opts.db ?? openDb(join(dataDir, "database", "factory.sqlite"));
  syncProjects(handle.db, config.projects.projects);
  // The built-in Default Workflow (kept current with the factory's own process and workflows.yaml), and the snapshot jobs from before workflows existed run on.
  syncBuiltinWorkflow(handle.db, config.workflows);
  backfillJobSnapshots(handle.db, config.workflows);
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
  const runner = new AgentRunner({ db: handle.db, router, logDir: join(dataDir, "logs", "agents"), protectedPaths: config.factory.protectedPaths });
  const worktrees = new WorktreeManager({
    db: handle.db, logger, workspacesRoot: join(dataDir, "workspaces"),
    repoPath: (id) => project(id).repository, defaultBranch: (id) => project(id).defaultBranch,
    networkEnv: (id) => hosts.gitAuth(project(id)),
  });
  const linear = (): LinearClient => (opts.linear ? opts.linear : createTrackerClient(config));

  const handlers: HandlerRegistry = {
    ...createIntakeHandlers({ db: handle.db, linear, linearConfig: config.linear, project }),
    ...createSpecKitHandlers({ db: handle.db, runner, router, worktrees, linear, project, fallback: config.models.independentReviewFallback, logger }),
    ...createImplementationHandlers({
      db: handle.db, runner, router, worktrees, linear, project, fallback: config.models.independentReviewFallback, logger,
      dataDir, runCommand: opts.runCommand, maxPasses: (id) => config.projects.projects.find((p) => p.id === id)?.overrides?.maxImplementationPasses ?? config.factory.maxImplementationPasses, settings: { protectedPaths: config.factory.protectedPaths, commandTimeoutSeconds: config.factory.commandTimeoutSeconds, sandbox: config.factory.sandbox },
    }),
    // PR-only delivery: push + open the PR, watch CI, report readiness, wait for a human to merge. The factory never merges.
    ...createDeliveryHandlers({
      db: handle.db, runner, router, worktrees, linear, project, fallback: config.models.independentReviewFallback, logger, dataDir,
      github: (p) => opts.github ?? hosts.pr(p), hosts, timing: opts.delivery, now: opts.deliveryNow, push: opts.push,
    }),
  };
  // The reusable stage types custom workflows are built from (agent, review, command check). Same kit, same router, same sandbox as the built-in stages.
  const typed = createTypedHandlers({
    db: handle.db, runner, router, worktrees, linear, project, fallback: config.models.independentReviewFallback, logger, dataDir, runCommand: opts.runCommand,
    settings: { commandTimeoutSeconds: config.factory.commandTimeoutSeconds, sandbox: config.factory.sandbox },
  });
  const engine = new Engine({ db: handle.db, logger, config, handlers, typed, observer: createLinearReporter(handle.db, { globalDryRun: () => config.factory.dryRun }) });
  return { config, handle, logger, router, runner, worktrees, linear, project, handlers, typed, engine, hosts };
}
