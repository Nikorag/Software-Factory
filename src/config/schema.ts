import { z } from "zod";
import { TOOL_TASKS } from "../plugins/capabilities.js";
import { instancesOf, routeHasTools, TOOL_TASK_MESSAGE } from "../plugins/routes.js";

/** https only, except for a hub running on this machine (development). */
export function validHubUrl(u: string): boolean {
  try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname)); } catch { return false; }
}

export const MAX_SKILLS = 50;
export const SkillRef = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "a skill name is lowercase letters, numbers and hyphens (max 64)"),
  path: z.string().min(1).max(500),
});
export type SkillRef = z.infer<typeof SkillRef>;

export const AutonomyLevel =z.enum(["full", "supervised", "off"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

/**
 * How a job gets from ticket to implementation. `haiku_prompt` (default): Claude Haiku inspects the repository and writes one concise,
 * implementation-ready prompt that the implementer works from. `speckit`: the full Spec Kit flow (specify, clarify, plan, tasks, independent
 * spec review, validation, converge). Chosen per profile in factory.yaml; profiles never affect each other.
 */
export const PlanningMode = z.enum(["haiku_prompt", "speckit"]);
export type PlanningMode = z.infer<typeof PlanningMode>;

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
  // The profile's DEFAULT issue tracker connection: what a project uses unless it names its own (`tracker:` on the project). Profiles and projects can mix freely.
  tracker: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default("linear"), // the id of a tracker connection (the built-in ones are "linear", "jira" and "github"; more are named in trackers.yaml)
  // automatic: tickets labelled factory:enabled in the pickup status are picked up on their own. manual: nothing starts until you start it from the Board.
  pickupMode: z.enum(["automatic", "manual"]).default("automatic"),
  // Reporting progress to a central Software Factory Hub. OFF by default: nothing leaves this machine until you run
  // `factory hub connect` with an API key from your hub. The key itself is never stored here (keychain / FACTORY_HUB_KEY).
  hub: z.object({
    enabled: z.boolean().default(false),
    url: z.string().default("").refine((u) => u === "" || validHubUrl(u), { message: "hub url must be https (http only for localhost)" }),
    reportIntervalSeconds: z.number().int().min(10).max(3600).default(30),
    // Lets the hub's web dashboard operate this factory (it relays dashboard requests to this machine). OFF by default and separate
    // from `enabled`: reporting progress never grants remote control. Turn on with `factory hub remote-access on`.
    remoteAccess: z.boolean().default(false),
  }).prefault({}),
  workflow: z.object({
    planning_mode: PlanningMode.default("haiku_prompt"),
    // How many times Claude may resolve merge conflicts with the target branch for one pull request before a human is asked.
    max_conflict_resolutions: z.number().int().min(0).max(10).default(3),
  }).prefault({}),
  dryRun: z.boolean().default(false),
  // Skills (SKILL.md files) every agent run of this profile receives, unless a project has a skill of the same name. Operator-trusted input.
  skills: z.array(SkillRef).max(MAX_SKILLS).default([]),
  maxRemediationAttempts: z.number().int().min(0).max(10).default(3),
  // How many implement-then-check-against-the-spec rounds one implementation stage may take before it stops for a person. (Not the fix cycle limit: that is review and CI fixes.)
  maxImplementationPasses: z.number().int().min(1).max(10).default(3),
  // Delivery is PR-only by decision: the factory opens pull requests and never merges them. `auto` does not exist yet.
  mergeMode: z.literal("pr-only").default("pr-only"),
  maxConcurrentJobs: z.number().int().min(1).default(1),
  // Project commands (install/build/test/lint/typecheck) run under macOS sandbox-exec: no network (installs excepted),
  // writes only inside the worktree/temp, no reading of credentials. `required: true` refuses to run them unconfined.
  sandbox: z.object({ required: z.boolean().default(true), readAllow: z.array(z.string()).optional(), writeAllow: z.array(z.string()).optional() }).prefault({}),
  // How much freedom the implementer agent has. `restricted` (default): an allowlist of git commands plus the project's checks.
  // `unrestricted`: Claude Code's own `auto` permission mode with no factory tool allow/deny lists, like any interactive auto-mode
  // session. The factory still checks the diff afterwards (protected paths, secrets). Can be overridden per project.
  agentAccess: z.enum(["restricted", "unrestricted"]).default("restricted"),
  commandTimeoutSeconds: z.number().int().min(10).default(900),
  pollIntervalSeconds: z.number().int().min(10).default(60),
  // Agent conversation logs hold ticket text, code and command output. They are deleted after this many days (0 = keep forever).
  logRetentionDays: z.number().int().min(0).max(3650).default(30),
  // Paths agents may never write to in any project. Enforced twice: as permission denies given to Claude Code,
  // and by verifying the worktree diff after every agent run. (The factory itself can never be a project: see loadConfig.)
  protectedPaths: z.array(z.string()).default([".git/**", ".env", ".env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/secrets/**", ".github/workflows/**",
    // the agents' own instruction set and the scripts they run: never editable by an agent
    ".claude/**", ".specify/scripts/**", ".specify/templates/**", ".specify/workflows/**", ".specify/integrations/**",
    // the project's own factory settings (commands, allowLoopback...): only people change them
    ".software-factory.yml"]),
});
export type FactoryConfig = z.infer<typeof FactoryConfig>;

/** Always protected, even when a user's factory.yaml lists its own protectedPaths: it controls what runs with network access and how loose the sandbox is. */
export const ALWAYS_PROTECTED_PATHS: readonly string[] = [".software-factory.yml"];
export const effectiveProtectedPaths = (paths: readonly string[]): string[] => [...paths, ...ALWAYS_PROTECTED_PATHS.filter((p) => !paths.includes(p))];

// A route names a plugin INSTANCE: `{ plugin: <instance id>, model }` (instances are defined once in `plugins:`).
// The legacy form `{ provider: anthropic | local, model }` still loads: it is migrated on read to the instance it always meant
// (anthropic -> `claude-code`, local -> `local` / an openai-compatible endpoint). See src/plugins/routes.ts.
const Provider = z.enum(["local", "anthropic"]);
export const InstanceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "an instance id: lowercase letters, numbers and hyphens");
export const PluginInstanceConfig = z.object({
  plugin: z.string().min(1).max(64),
  /** The plugin's own settings, validated by the plugin. Secrets are only ever named by environment variable (`apiKeyEnv`). */
  settings: z.record(z.string(), z.unknown()).default({})
    .refine((s) => !Object.entries(s).some(([k, v]) => /(api[_-]?key|token|secret|password)$/i.test(k) && typeof v === "string" && v.length > 0), { message: "settings must not hold a secret: name an environment variable (apiKeyEnv) instead" }),
});
const ModelRouteBase = z.object({
  plugin: InstanceId.optional(),
  provider: Provider.optional(),
  // Identifier is a free string: for an OpenAI-style plugin it must match what the runtime reports
  // (see `factory doctor`); for `claude-code` it is passed to Claude Code via --model.
  model: z.string().min(1),
});
const oneForm = (r: { plugin?: string; provider?: string }) => (r.plugin === undefined) !== (r.provider === undefined);
const ONE_FORM = { message: "a route names a plugin instance (`plugin: <id>`) or, in older files, a `provider`: exactly one" };
const ModelRoute = ModelRouteBase.refine(oneForm, ONE_FORM);
// The independent reviewer: any OpenAI-compatible endpoint. `baseUrl` + `model` (+ optional `apiKeyEnv`, the NAME of an
// environment variable holding the key: the key itself is never stored). Absent or null = no independent review (skipped).
// provider `local` without a baseUrl uses `local.baseUrl`; provider `anthropic` runs a Claude reviewer (older setups).
// With `plugin:` the endpoint and key belong to the plugin instance, not the route.
export const ReviewerRoute = ModelRouteBase.extend({
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name").max(100).optional(),
}).refine(oneForm, ONE_FORM)
  .refine((r) => !r.apiKeyEnv || !!r.baseUrl, { message: "apiKeyEnv needs a baseUrl: the shared local server is never sent an API key" })
  .refine((r) => !(r.apiKeyEnv && r.baseUrl) || validHubUrl(r.baseUrl), { message: "baseUrl must be https (http only for localhost) when an API key is configured, so the key is never sent in cleartext" })
  .refine((r) => r.provider === "local" || (!r.baseUrl && !r.apiKeyEnv), { message: "baseUrl and apiKeyEnv only apply to provider `local` (an OpenAI-compatible endpoint); with `plugin:` set them on the plugin instance" });
export type ReviewerRoute = z.infer<typeof ReviewerRoute>;
export type ModelRouteConfig = z.infer<typeof ModelRoute>;
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
  // Named plugin instances (plugin id + settings), defined once and referenced by routes. `claude-code` and `local` exist without being listed.
  plugins: z.record(InstanceId, PluginInstanceConfig).default({}),
  routes: z.object({
    classification: ModelRoute,
    specification: ModelRoute,
    implementation: ModelRoute,
    independent_review: ReviewerRoute.nullish(),
    final_review: ModelRoute,
    // Writes the implementer's prompt (haiku_prompt planning mode). Reads the repository, so it must be Claude Code. Optional: Haiku by default.
    prompt_generation: ModelRoute.default({ provider: "anthropic", model: "haiku" }),
  }),
  })
  .superRefine((m, ctx) => {
    const defined = instancesOf(m);
    for (const [task, r] of Object.entries(m.routes)) {
      if (r?.plugin && !defined[r.plugin]) ctx.addIssue({ code: "custom", path: ["routes", task, "plugin"], message: `unknown plugin instance "${r.plugin}" (defined: ${Object.keys(defined).join(", ")}); add it under \`plugins:\`` });
    }
    // Capability-driven: the plugin must declare tool access for the steps that read and write the repository.
    if (!TOOL_TASKS.every((t) => routeHasTools(m, m.routes[t]))) ctx.addIssue({ code: "custom", message: TOOL_TASK_MESSAGE });
  });
export type ModelsConfig = z.infer<typeof ModelsConfig>;

const RouteName = ["classification", "specification", "implementation", "independent_review", "final_review", "prompt_generation"] as const;
/** Anything set here beats the global setting for this project only; anything left out follows the global one. */
export const ProjectOverrides = z.object({
  pickupMode: z.enum(["automatic", "manual"]).optional(),
  maxConcurrentJobs: z.number().int().min(1).max(8).optional(), // jobs of THIS project running at once (default 1: each job has its own worktree, but tickets in one repository tend to touch the same files)
  maxRemediationAttempts: z.number().int().min(0).max(10).optional(),
  maxImplementationPasses: z.number().int().min(1).max(10).optional(),
  agentAccess: z.enum(["restricted", "unrestricted"]).optional(), // this project's override of factory.agentAccess
  // independent_review: null = this project skips the independent review; left out = follow the global setting.
  models: z.object({ ...(Object.fromEntries(RouteName.map((r) => [r, ModelRoute.optional()])) as Record<Exclude<(typeof RouteName)[number], "independent_review">, z.ZodOptional<typeof ModelRoute>>), independent_review: ReviewerRoute.nullish() })
    // Instance ids are global, so only the built-in ids and legacy providers can be judged here; the router checks the rest when it routes.
    .refine((m) => TOOL_TASKS.every((t) => { const r = m[t]; return !r || routeHasTools({ local: { baseUrl: "" } }, r); }), { message: TOOL_TASK_MESSAGE }).optional(),
});
export type ProjectOverrides = z.infer<typeof ProjectOverrides>;

/** Field definitions shared by projects.yaml and a repository's `.software-factory.yml` (see src/config/repo-file.ts). */
export const ProjectId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
export const ProjectCommands = z.object({ install: z.string().optional(), build: z.string().optional(), test: z.string().optional(), lint: z.string().optional(), typecheck: z.string().optional(), visual: z.string().optional() });
export const ProjectGithub = z.object({
  account: z.string().optional(),
  // owner/name. If `repository` is omitted the factory clones this into <dataDir>/projects/<id> and owns that clone.
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
});

/** Where a project can stop for a human to confirm or send the stage back. Closed list; only the generated implementer prompt (haiku_prompt mode) so far. */
export const GATE_POINTS = ["REQUIREMENTS_ANALYSIS"] as const;
export const GatePoint = z.enum(GATE_POINTS);
export type GatePoint = z.infer<typeof GatePoint>;

export const ProjectConfig = z.object({
  id: ProjectId,
  name: z.string(),
  repository: z.string(), // always an absolute-ish path after loading
  managed: z.boolean().default(false), // true: the factory owns this clone under <dataDir>/projects
  defaultBranch: z.string().default("main"),
  enabled: z.boolean().default(true),
  specKit: z.boolean().default(true),
  autonomy: AutonomyLevel.default("supervised"),
  // Bind to a Linear team, optionally narrowed to one Linear project (by name or id). One repo per Linear project.
  // Which tracker connection the project's tickets live in (an id from Settings → Trackers); omitted = the profile's default.
  tracker: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  linear: z.object({ teamKey: z.string(), projectName: z.string().optional(), projectId: z.string().optional() }).optional(),
  // Where this repository is hosted. Each project chooses: a "home" project can be on GitHub and a "work" project on Bitbucket.
  host: z.enum(["github", "bitbucket"]).default("github"),
  // Used when host is "bitbucket": workspace/slug, and which stored credential (Settings > Integrations) to use.
  bitbucket: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(), credential: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default("default") }).prefault({}),
  // GitHub account that owns/accesses this repo. gh is invoked as this account per call; the global gh login is never switched.
  github: ProjectGithub.prefault({}),
  overrides: ProjectOverrides.optional(),
  // Extra shell command prefixes the (restricted) implementer may run, e.g. "GOLDEN_OUT=/tmp/golden godot --headless". Ignored when unrestricted.
  agentBashAllow: z.array(z.string()).default([]),
  // Opt-in: the restricted implementer may run any Bash command. The always-denied list (git push/remote/config, gh, curl, ssh, sudo, rm -rf, docker, ...) and protected paths stay in force. Ignored when unrestricted.
  agentBashAny: z.boolean().default(false),
  // Let this project's test/lint/build commands use TCP on this machine only (e.g. tests that start PGlite or a mock server). Off by default.
  allowLoopback: z.boolean().default(false),
  // Human gates: after these stages succeed the job waits for a person to confirm or ask for changes. projects.yaml only: a repository file cannot set them.
  gates: z.array(GatePoint).default([]),
  // Skills (SKILL.md files) appended to every agent run's system prompt for this project; they replace profile skills of the same name. Owned by projects.yaml; the repo file's skills are kept apart in `repoSkills`.
  skills: z.array(SkillRef).max(MAX_SKILLS).default([]),
  commands: ProjectCommands.default({}),
  // Runtime only (never written to projects.yaml): why this project's `.software-factory.yml` was not applied. See src/config/repo-file.ts.
  repoFileError: z.string().optional(),
  // Runtime only: the skills `.software-factory.yml` sets, with their bodies read from the committed default branch. Never written to projects.yaml.
  repoSkills: z.array(SkillRef.extend({ body: z.string() })).optional(),
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
  "CLAUDE_REVIEW", "REMEDIATION", "CONFLICT_RESOLUTION", "FINAL_VALIDATION", "PULL_REQUEST_CREATION", "CI_VALIDATION",
  "MERGE_VALIDATION", "MERGING", "LINEAR_COMPLETION", "COMPLETED",
] as const;
export const TERMINAL_OR_HELD = ["BLOCKED", "FAILED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION", "AWAITING_CONFIRMATION"] as const;
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
  // The gh login that reads and writes these issues; omitted = the profile's default GitHub account. Lets two GitHub connections use two accounts.
  account: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional(),
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

export const TrackerId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a tracker id is lowercase letters, numbers and hyphens");
export const TrackerKind = z.enum(["linear", "jira", "github"]);
export type TrackerKind = z.infer<typeof TrackerKind>;
/** The three built-in connections come from linear.yaml, jira.yaml and github-issues.yaml; their ids are reserved. */
export const BUILTIN_TRACKER_IDS: readonly string[] = ["linear", "jira", "github"];

const Label = z.string().trim().min(1).max(60).optional();
/**
 * One tracker connection: an instance of Linear, Jira or GitHub Issues with its own credentials and its own status/label names.
 * Several of the same kind can exist (two Jiras, three Linear workspaces). Secrets are never here, only where to find them.
 */
export const TrackerConnection = z.discriminatedUnion("kind", [
  LinearConfig.extend({ kind: z.literal("linear"), label: Label }),
  JiraConfig.extend({ kind: z.literal("jira"), label: Label }),
  GithubIssuesConfig.extend({ kind: z.literal("github"), label: Label }),
]);
export type TrackerConnection = z.infer<typeof TrackerConnection>;
export const TrackersFile = z.object({ connections: z.record(TrackerId, TrackerConnection).default({}) });

/** What the rest of the factory reads from any connection: the status and label names (and, for Linear, where its key is). */
export function connectionNames(c: TrackerConnection): LinearConfig {
  return c.kind === "jira" ? effectiveTrackerNames(c) : c.kind === "github" ? githubTrackerNames(c) : LinearConfig.parse(c);
}
export const KIND_NAME: Record<TrackerKind, string> = { linear: "Linear", jira: "Jira", github: "GitHub Issues" };
export const connectionLabel = (id: string, c: { kind: TrackerKind; label?: string | undefined }) => c.label ?? (BUILTIN_TRACKER_IDS.includes(id) ? KIND_NAME[c.kind] : `${KIND_NAME[c.kind]} (${id})`);

/** For a GitHub profile: the configured names, in the shape the rest of the factory reads. */
export function githubTrackerNames(g: GithubIssuesConfig): LinearConfig {
  return LinearConfig.parse({ statuses: g.statuses, labels: g.labels });
}

export const LoadedConfig = z.object({
  linear: LinearConfig, // the names of the profile's DEFAULT tracker connection (see `connections` for the rest)
  jira: JiraConfig,
  githubIssues: GithubIssuesConfig,
  /** Every tracker connection by id: the built-in three plus those in trackers.yaml. `factory.tracker` and each project's `tracker` name one. */
  connections: z.record(z.string(), TrackerConnection),
  bitbucket: BitbucketConfig,
  factory: FactoryConfig,
  models: ModelsConfig,
  projects: ProjectsConfig,
  workflows: WorkflowsConfig,
  /** Where these files were read from (the settings UI writes projects.yaml here). */
  configDir: z.string().optional(),
});
export type LoadedConfig = z.infer<typeof LoadedConfig>;

/** The profile's planning mode (factory.yaml `workflow.planning_mode`). */
export const planningModeOf = (config: { factory: { workflow: { planning_mode: PlanningMode } } }): PlanningMode => config.factory.workflow.planning_mode;

/** How tickets of a project get started: its own override, else the profile's setting. */
export const pickupModeOf = (project: { overrides?: { pickupMode?: "automatic" | "manual" } | undefined }, factory: { pickupMode: "automatic" | "manual" }): "automatic" | "manual" =>
  project.overrides?.pickupMode ?? factory.pickupMode;

/** The id of the tracker connection a project uses: its own, else the profile's default. */
export const trackerIdOf = (config: { factory: { tracker: string } }, project?: { tracker?: string | undefined } | null): string => project?.tracker ?? config.factory.tracker;
