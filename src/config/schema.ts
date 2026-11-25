import { z } from "zod";

export const AutonomyLevel = z.enum(["full", "supervised", "off"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const FactoryConfig = z.object({
  dataDir: z.string().default("~/.software-factory"),
  server: z
    .object({
      host: z.literal("127.0.0.1").default("127.0.0.1"), // loopback only; never configurable to 0.0.0.0
      port: z.number().int().min(1024).max(65535).default(4780),
    })
    .default({ host: "127.0.0.1", port: 4780 }),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  dryRun: z.boolean().default(false),
  maxRemediationAttempts: z.number().int().min(0).max(10).default(3),
  // Delivery is PR-only by decision: the factory opens pull requests and never merges them. `auto` does not exist yet.
  mergeMode: z.literal("pr-only").default("pr-only"),
  maxConcurrentJobs: z.number().int().min(1).default(1),
  // Project commands (install/build/test/lint/typecheck) run under macOS sandbox-exec: no network (installs excepted),
  // writes only inside the worktree/temp, no reading of credentials. `required: true` refuses to run them unconfined.
  sandbox: z.object({ required: z.boolean().default(true), readAllow: z.array(z.string()).optional(), writeAllow: z.array(z.string()).optional() }).prefault({}),
  commandTimeoutSeconds: z.number().int().min(10).default(900),
  pollIntervalSeconds: z.number().int().min(10).default(60),
  // Paths agents may never write to in any project. Enforced twice: as permission denies given to Claude Code,
  // and by verifying the worktree diff after every agent run. (The factory itself can never be a project: see loadConfig.)
  protectedPaths: z.array(z.string()).default([".git/**", ".env", ".env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/secrets/**", ".github/workflows/**",
    // the agents' own instruction set and the scripts they run: never editable by an agent
    ".claude/**", ".specify/scripts/**", ".specify/templates/**", ".specify/workflows/**", ".specify/integrations/**"]),
});
export type FactoryConfig = z.infer<typeof FactoryConfig>;

const Provider = z.enum(["local", "anthropic"]);
const ModelRoute = z.object({
  provider: Provider,
  // Identifier is a free string: for `local` it must match what the runtime reports
  // (see `factory doctor`); for `anthropic` it is passed to Claude Code via --model.
  model: z.string().min(1),
});
export const ModelsConfig = z
  .object({
  local: z
    .object({
      // Bionic is LM Studio-derived but its API is unverified; the adapter assumes
      // an OpenAI-compatible server and `doctor` probes it before use.
      baseUrl: z.string().url().default("http://127.0.0.1:1234/v1"),
      requestTimeoutSeconds: z.number().int().min(1).default(300),
      maxConcurrentRequests: z.literal(1).default(1), // unified-memory constraint
    })
    .default({ baseUrl: "http://127.0.0.1:1234/v1", requestTimeoutSeconds: 300, maxConcurrentRequests: 1 }),
  // If the local model is unavailable for an independent review: use a fresh Claude reviewer, or block the job.
  independentReviewFallback: z.enum(["claude", "block"]).default("claude"),
  routes: z.object({
    classification: ModelRoute,
    specification: ModelRoute,
    implementation: ModelRoute,
    independent_review: ModelRoute,
    final_review: ModelRoute,
  }),
  })
  .refine((m) => m.routes.implementation.provider === "anthropic" && m.routes.specification.provider === "anthropic", {
    message: "specification and implementation need file and shell tools, so they must use provider `anthropic` (Claude Code)",
  });
export type ModelsConfig = z.infer<typeof ModelsConfig>;

export const ProjectConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  repository: z.string(), // always an absolute-ish path after loading
  managed: z.boolean().default(false), // true: the factory owns this clone under <dataDir>/projects
  defaultBranch: z.string().default("main"),
  enabled: z.boolean().default(true),
  specKit: z.boolean().default(true),
  autonomy: AutonomyLevel.default("supervised"),
  // Bind to a Linear team, optionally narrowed to one Linear project (by name or id). One repo per Linear project.
  linear: z.object({ teamKey: z.string(), projectName: z.string().optional(), projectId: z.string().optional() }).optional(),
  // GitHub account that owns/accesses this repo. gh is invoked as this account per call; the global gh login is never switched.
  github: z
    .object({
      account: z.string().optional(),
      // owner/name. If `repository` is omitted the factory clones this into <dataDir>/projects/<id> and owns that clone.
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
    })
    .prefault({}),
  commands: z
    .object({ install: z.string().optional(), build: z.string().optional(), test: z.string().optional(), lint: z.string().optional(), typecheck: z.string().optional() })
    .default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
/** What projects.yaml may contain: `repository` can be omitted when `github.repo` is given (factory-managed clone). */
export const ProjectInput = ProjectConfig.extend({ repository: z.string().optional() }).refine((p) => p.repository || p.github.repo, {
  message: "set `repository` (existing checkout) or `github.repo` (factory-managed clone)",
});
export const ProjectsFile = z.object({ projects: z.array(ProjectInput).default([]) });
export const ProjectsConfig = z.object({ projects: z.array(ProjectConfig).default([]) });

export const STAGES = [
  "DISCOVERED", "ELIGIBILITY_CHECK", "REQUIREMENTS_ANALYSIS", "SPECIFICATION_GENERATION",
  "SPECIFICATION_REVIEW", "SPECIFICATION_REMEDIATION", "SPECIFICATION_VALIDATION",
  "IMPLEMENTATION_PREPARATION", "IMPLEMENTATION", "AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW",
  "CLAUDE_REVIEW", "REMEDIATION", "FINAL_VALIDATION", "PULL_REQUEST_CREATION", "CI_VALIDATION",
  "MERGE_VALIDATION", "MERGING", "LINEAR_COMPLETION", "COMPLETED",
] as const;
export const TERMINAL_OR_HELD = ["BLOCKED", "FAILED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION"] as const;
export const StageName = z.enum([...STAGES, ...TERMINAL_OR_HELD]);
export type StageName = z.infer<typeof StageName>;

const StagePolicy = z.object({
  timeoutSeconds: z.number().int().min(1).default(900),
  maxRetries: z.number().int().min(0).default(2),
});
export const WorkflowsConfig = z.object({
  workflows: z.record(z.string(), z.object({ stages: z.record(z.string(), StagePolicy).default({}) })).default({}),
  defaults: StagePolicy.default({ timeoutSeconds: 900, maxRetries: 2 }),
});
export type WorkflowsConfig = z.infer<typeof WorkflowsConfig>;

// Linear names are configuration, never hardcoded. They are resolved to ids per team at runtime.
export const LinearConfig = z.object({
  apiKeyEnv: z.string().default("LINEAR_API_KEY"),
  // Fallback when the env var is unset (a LaunchAgent has no shell env): a macOS keychain generic-password service name. Not a secret itself.
  keychainService: z.string().default("software-factory-linear"),
  statuses: z
    .object({
      readyForSpecification: z.string().default("Ready for specification"), // pickup status
      specificationReview: z.string().default("Specification review"),
      readyForDevelopment: z.string().default("Ready for development"),
      inProgress: z.string().default("In progress"),
      readyForReview: z.string().default("Ready for review"),
      changesRequested: z.string().default("Changes requested"),
      merging: z.string().default("Merging"),
      done: z.string().default("Done"),
      blocked: z.string().default("Blocked"),
    })
    .prefault({}),
  labels: z
    .object({
      enabled: z.string().default("factory:enabled"),
      autonomous: z.string().default("factory:autonomous"),
      bugfix: z.string().default("factory:bugfix"),
      feature: z.string().default("factory:feature"),
      maintenance: z.string().default("factory:maintenance"),
      blocked: z.string().default("factory:blocked"),
    })
    .prefault({}),
});
export type LinearConfig = z.infer<typeof LinearConfig>;

export const LoadedConfig = z.object({
  linear: LinearConfig,
  factory: FactoryConfig,
  models: ModelsConfig,
  projects: ProjectsConfig,
  workflows: WorkflowsConfig,
});
export type LoadedConfig = z.infer<typeof LoadedConfig>;
