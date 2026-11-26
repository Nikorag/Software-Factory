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
  // The gh login this profile uses unless a project names its own. Lets e.g. a "home" and a "work" profile use different GitHub accounts.
  githubAccount: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional(),
  // Which issue tracker this profile uses (Linear, Jira or GitHub Issues). The factory never needs two: a "home" profile can be on Linear and a "work" profile on Jira.
  tracker: z.enum(["linear", "jira", "github"]).default("linear"),
  // automatic: tickets labelled factory:enabled in the pickup status are picked up on their own. manual: nothing starts until you start it from the Board.
  pickupMode: z.enum(["automatic", "manual"]).default("automatic"),
  dryRun: z.boolean().default(false),
  maxRemediationAttempts: z.number().int().min(0).max(10).default(3),
  // How many implement-then-check-against-the-spec rounds one implementation stage may take before it stops for a person. (Not the fix cycle limit: that is review and CI fixes.)
  maxImplementationPasses: z.number().int().min(1).max(10).default(3),
  // Delivery is PR-only by decision: the factory opens pull requests and never merges them. `auto` does not exist yet.
  mergeMode: z.literal("pr-only").default("pr-only"),
  maxConcurrentJobs: z.number().int().min(1).default(1),
  // Project commands (install/build/test/lint/typecheck) run under macOS sandbox-exec: no network (installs excepted),
  // writes only inside the worktree/temp, no reading of credentials. `required: true` refuses to run them unconfined.
  sandbox: z.object({ required: z.boolean().default(true), readAllow: z.array(z.string()).optional(), writeAllow: z.array(z.string()).optional() }).prefault({}),
  commandTimeoutSeconds: z.number().int().min(10).default(900),
  pollIntervalSeconds: z.number().int().min(10).default(60),
  // Agent conversation logs hold ticket text, code and command output. They are deleted after this many days (0 = keep forever).
  logRetentionDays: z.number().int().min(0).max(3650).default(30),
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
      // Any OpenAI-compatible server (LM Studio, llama.cpp, Ollama...). `doctor` probes it before use.
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

const RouteName = ["classification", "specification", "implementation", "independent_review", "final_review"] as const;
/** Anything set here beats the global setting for this project only; anything left out follows the global one. */
export const ProjectOverrides = z.object({
  pickupMode: z.enum(["automatic", "manual"]).optional(),
  maxConcurrentJobs: z.number().int().min(1).max(8).optional(), // jobs of THIS project running at once (default 1: each job has its own worktree, but tickets in one repository tend to touch the same files)
  maxRemediationAttempts: z.number().int().min(0).max(10).optional(),
  maxImplementationPasses: z.number().int().min(1).max(10).optional(),
  models: z.object(Object.fromEntries(RouteName.map((r) => [r, ModelRoute.optional()])) as Record<(typeof RouteName)[number], z.ZodOptional<typeof ModelRoute>>)
    .refine((m) => (m.specification?.provider ?? "anthropic") === "anthropic" && (m.implementation?.provider ?? "anthropic") === "anthropic", {
      message: "specification and implementation need file and shell tools, so they must use provider `anthropic` (Claude Code)",
    }).optional(),
});
export type ProjectOverrides = z.infer<typeof ProjectOverrides>;

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
  // Where this repository is hosted. Each project chooses: a "home" project can be on GitHub and a "work" project on Bitbucket.
  host: z.enum(["github", "bitbucket"]).default("github"),
  // Used when host is "bitbucket": workspace/slug, and which stored credential (Settings > Integrations) to use.
  bitbucket: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(), credential: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default("default") }).prefault({}),
  // GitHub account that owns/accesses this repo. gh is invoked as this account per call; the global gh login is never switched.
  github: z
    .object({
      account: z.string().optional(),
      // owner/name. If `repository` is omitted the factory clones this into <dataDir>/projects/<id> and owns that clone.
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
    })
    .prefault({}),
  overrides: ProjectOverrides.optional(),
  commands: z
    .object({ install: z.string().optional(), build: z.string().optional(), test: z.string().optional(), lint: z.string().optional(), typecheck: z.string().optional() })
    .default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
/** What projects.yaml may contain: `repository` can be omitted when `github.repo` is given (factory-managed clone). */
export const ProjectInput = ProjectConfig.extend({ repository: z.string().optional() }).refine((p) => p.repository || (p.host === "bitbucket" ? p.bitbucket.repo : p.github.repo), {
  message: "set `repository` (existing checkout) or the host's repo (`github.repo` / `bitbucket.repo`) for a factory-managed clone",
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

const STATUS_KEYS = ["readyForSpecification", "specificationReview", "readyForDevelopment", "inProgress", "readyForReview", "changesRequested", "merging", "done", "blocked"] as const;
const LABEL_KEYS = ["enabled", "autonomous", "bugfix", "feature", "maintenance", "blocked"] as const;
export const JIRA_STATUS_KEYS = STATUS_KEYS;
export const JIRA_LABEL_KEYS = LABEL_KEYS;

/**
 * Jira (Atlassian OAuth 2.0 3LO). Unlike Linear, the factory cannot create Jira statuses (workflows are admin-owned), so every factory
 * status is MAPPED to one that already exists ("" = not mapped: the factory then simply does not move tickets to it). Labels are mapped
 * the same way so a work Jira can keep its own naming. No secret lives here: the OAuth client secret and tokens are in the keychain.
 */
export const JiraConfig = z.object({
  clientId: z.string().optional(), // the OAuth app's client id (public); its secret is in the keychain
  keychainService: z.string().default("software-factory-jira"),
  site: z.object({ cloudId: z.string(), url: z.string(), name: z.string() }).optional(),
  statuses: z.partialRecord(z.enum(STATUS_KEYS), z.string()).default({}),
  labels: z.partialRecord(z.enum(LABEL_KEYS), z.string()).default({}),
});
export type JiraConfig = z.infer<typeof JiraConfig>;

/**
 * GitHub Issues. A repository is the "team"; a milestone is the "project". GitHub issues are only open or closed, so the factory's
 * workflow statuses are LABELS that start with `statusPrefix` (e.g. "status: In progress"); the factory may create them (labels are cheap),
 * and "done" also closes the issue. Authentication is the `gh` login the profile already uses (factory.githubAccount): nothing secret lives here.
 */
export const GithubIssuesConfig = z.object({
  statusPrefix: z.string().min(1).max(40).default("status: "),
  statuses: LinearConfig.shape.statuses,
  labels: LinearConfig.shape.labels,
});
export type GithubIssuesConfig = z.infer<typeof GithubIssuesConfig>;

/**
 * Bitbucket Cloud credentials, by name. The TOKEN is never here (it is in the keychain, one entry per credential name); this only says what
 * kind of token it is. `access-token`: a repository, project or workspace access token (Bearer; git user x-token-auth). `api-token`: an
 * Atlassian account API token with Bitbucket scopes (Basic auth with your account email; git user x-bitbucket-api-token-auth).
 * A project picks one by name (`bitbucket.credential`), so a token scoped to one repository can serve just that project.
 */
export const BitbucketCredential = z.object({ kind: z.enum(["access-token", "api-token"]), email: z.string().email().optional() })
  .refine((c) => c.kind !== "api-token" || Boolean(c.email), { message: "an API token needs the Atlassian account email it belongs to" });
export const BitbucketConfig = z.object({
  keychainService: z.string().default("software-factory-bitbucket"),
  credentials: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), BitbucketCredential).default({}),
});
export type BitbucketConfig = z.infer<typeof BitbucketConfig>;

/** What the rest of the factory sees as "the tracker's names": for Jira, the mapped names (unmapped = ""). */
export function effectiveTrackerNames(jira: JiraConfig): LinearConfig {
  return LinearConfig.parse({
    keychainService: jira.keychainService,
    statuses: Object.fromEntries(STATUS_KEYS.map((k) => [k, jira.statuses[k] ?? ""])),
    labels: Object.fromEntries(LABEL_KEYS.map((k) => [k, jira.labels[k] ?? ""])),
  });
}

/** For a GitHub profile: the configured names, in the shape the rest of the factory reads. */
export function githubTrackerNames(g: GithubIssuesConfig): LinearConfig {
  return LinearConfig.parse({ statuses: g.statuses, labels: g.labels });
}

export const LoadedConfig = z.object({
  linear: LinearConfig, // for a Jira or GitHub profile: the mapped names (see JiraConfig, GithubIssuesConfig)
  jira: JiraConfig,
  githubIssues: GithubIssuesConfig,
  bitbucket: BitbucketConfig,
  factory: FactoryConfig,
  models: ModelsConfig,
  projects: ProjectsConfig,
  workflows: WorkflowsConfig,
  /** Where these files were read from (the settings UI writes projects.yaml here). */
  configDir: z.string().optional(),
});
export type LoadedConfig = z.infer<typeof LoadedConfig>;

/** How tickets of a project get started: its own override, else the profile's setting. */
export const pickupModeOf = (project: { overrides?: { pickupMode?: "automatic" | "manual" } | undefined }, factory: { pickupMode: "automatic" | "manual" }): "automatic" | "manual" =>
  project.overrides?.pickupMode ?? factory.pickupMode;
