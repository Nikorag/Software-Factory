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
  maxConcurrentJobs: z.number().int().min(1).default(1),
  pollIntervalSeconds: z.number().int().min(10).default(60),
  // Paths agents may never write to, regardless of project (factory self-protection).
  protectedPaths: z.array(z.string()).default(["config/**", ".env*", "**/*.pem", "**/secrets/**"]),
});
export type FactoryConfig = z.infer<typeof FactoryConfig>;

const Provider = z.enum(["local", "anthropic"]);
const ModelRoute = z.object({
  provider: Provider,
  // Identifier is a free string: for `local` it must match what the runtime reports
  // (see `factory doctor`); for `anthropic` it is passed to Claude Code via --model.
  model: z.string().min(1),
});
export const ModelsConfig = z.object({
  local: z
    .object({
      // Bionic is LM Studio-derived but its API is unverified; the adapter assumes
      // an OpenAI-compatible server and `doctor` probes it before use.
      baseUrl: z.string().url().default("http://127.0.0.1:1234/v1"),
      requestTimeoutSeconds: z.number().int().min(1).default(300),
      maxConcurrentRequests: z.literal(1).default(1), // unified-memory constraint
    })
    .default({ baseUrl: "http://127.0.0.1:1234/v1", requestTimeoutSeconds: 300, maxConcurrentRequests: 1 }),
  routes: z.object({
    classification: ModelRoute,
    specification: ModelRoute,
    implementation: ModelRoute,
    independent_review: ModelRoute,
    final_review: ModelRoute,
  }),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;

export const ProjectConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  repository: z.string(),
  defaultBranch: z.string().default("main"),
  enabled: z.boolean().default(true),
  specKit: z.boolean().default(true),
  autonomy: AutonomyLevel.default("supervised"),
  linear: z.object({ teamKey: z.string(), projectId: z.string().optional() }).optional(),
  commands: z
    .object({ test: z.string().optional(), lint: z.string().optional(), typecheck: z.string().optional() })
    .default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
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

export const LoadedConfig = z.object({
  factory: FactoryConfig,
  models: ModelsConfig,
  projects: ProjectsConfig,
  workflows: WorkflowsConfig,
});
export type LoadedConfig = z.infer<typeof LoadedConfig>;
