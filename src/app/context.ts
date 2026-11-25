import { join } from "node:path";
import type { Logger } from "pino";
import { ClaudeCodeAgent } from "../agents/claude.js";
import { LocalModelClient } from "../agents/local.js";
import { ModelRouter } from "../agents/router.js";
import { AgentRunner } from "../agents/runner.js";
import { ConfigError } from "../config/load.js";
import type { LoadedConfig, ProjectConfig } from "../config/schema.js";
import { openDb, type DbHandle } from "../db/client.js";
import { Engine, type HandlerRegistry } from "../core/engine.js";
import { createLinearClient, type LinearClient } from "../linear/client.js";
import { createIntakeHandlers } from "../linear/handlers.js";
import { createLinearReporter } from "../linear/reporter.js";
import { createLogger } from "../logging/logger.js";
import { gitAuthEnv } from "../repo/gh.js";
import { syncProjects } from "../repo/registry.js";
import { WorktreeManager } from "../repo/worktrees.js";
import { createSpecKitHandlers } from "../speckit/handlers.js";
import { createImplementationHandlers, type ImplDeps } from "../implement/handlers.js";

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
  engine: Engine;
}

/** Wires every real component together. Tests substitute `agents`, `linear` and `db`; nothing here is a mock. */
export function createContext(config: LoadedConfig, opts: { db?: DbHandle; logger?: Logger; linear?: LinearClient; claudeBin?: string; agents?: ConstructorParameters<typeof ModelRouter>[1]; runCommand?: ImplDeps["runCommand"] } = {}): Context {
  const dataDir = config.factory.dataDir;
  const logger = opts.logger ?? createLogger({ level: config.factory.logLevel, file: join(dataDir, "logs", "factory.log") });
  const handle = opts.db ?? openDb(join(dataDir, "database", "factory.sqlite"));
  syncProjects(handle.db, config.projects.projects);
  const projects = new Map(config.projects.projects.map((p) => [p.id, p]));
  const project = (id: string): ProjectConfig => {
    const p = projects.get(id);
    if (!p) throw new ConfigError(`unknown project "${id}"`);
    return p;
  };

  const router = new ModelRouter(config.models, opts.agents ?? {
    anthropic: new ClaudeCodeAgent({ bin: opts.claudeBin }),
    local: new LocalModelClient({ baseUrl: config.models.local.baseUrl }),
  });
  const runner = new AgentRunner({ db: handle.db, router, logDir: join(dataDir, "logs", "agents"), protectedPaths: config.factory.protectedPaths });
  const worktrees = new WorktreeManager({
    db: handle.db, logger, workspacesRoot: join(dataDir, "workspaces"),
    repoPath: (id) => project(id).repository, defaultBranch: (id) => project(id).defaultBranch,
    networkEnv: (id) => gitAuthEnv(project(id).github.account),
  });
  const linear = (): LinearClient => {
    if (opts.linear) return opts.linear;
    const key = process.env[config.linear.apiKeyEnv];
    if (!key) throw new ConfigError(`${config.linear.apiKeyEnv} is not set`);
    return createLinearClient({ apiKey: key });
  };

  const handlers: HandlerRegistry = {
    ...createIntakeHandlers({ db: handle.db, linear, linearConfig: config.linear, project }),
    ...createSpecKitHandlers({ db: handle.db, runner, router, worktrees, linear, project, fallback: config.models.independentReviewFallback, logger }),
    ...createImplementationHandlers({
      db: handle.db, runner, router, worktrees, linear, project, fallback: config.models.independentReviewFallback, logger,
      dataDir, runCommand: opts.runCommand, settings: { protectedPaths: config.factory.protectedPaths, commandTimeoutSeconds: config.factory.commandTimeoutSeconds, sandbox: config.factory.sandbox },
    }),
    // PULL_REQUEST_CREATION onwards arrive in Milestone 8; until then the engine blocks a job that reaches them.
  };
  const engine = new Engine({ db: handle.db, logger, config, handlers, observer: createLinearReporter(handle.db, { globalDryRun: () => config.factory.dryRun }) });
  return { config, handle, logger, router, runner, worktrees, linear, project, handlers, engine };
}
