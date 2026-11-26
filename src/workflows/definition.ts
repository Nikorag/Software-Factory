import { z } from "zod";
import { STAGES } from "../config/schema.js";
import { SYSTEM_LIMITS } from "./limits.js";

/** Where a job ends up when its last stage succeeds. Never a stage of its own. */
export const COMPLETE = "COMPLETED";
/** Held or terminal job states: not stages, so no workflow may define or route to a stage with one of these ids (use a failure action instead). */
export const RESERVED_IDS: readonly string[] = ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION"];
/** The factory's own stage handlers: what a `factory` stage can wrap. */
export const FACTORY_HANDLERS: readonly string[] = STAGES.filter((s) => s !== "COMPLETED");
export const STAGE_TYPES = ["factory", "agent", "review", "check", "conditional"] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export const stageId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/, "ids start with a letter and use letters, digits and underscores (max 48)");

// ---- conditions: a small, closed vocabulary. Never an expression language, never code. ----
export const CONDITION_FIELD = /^(job\.(remediationAttempts|stageAttempts|dryRun|autonomous|manual|kind)|output(\.[A-Za-z0-9_]{1,40}){1,4}|outputs\.[A-Za-z][A-Za-z0-9_]{0,47}(\.[A-Za-z0-9_]{1,40}){1,4})$/;
export const Condition = z.object({
  field: z.string().regex(CONDITION_FIELD, "a condition reads job.<remediationAttempts|stageAttempts|dryRun|autonomous|manual|kind>, output.<path> or outputs.<STAGE_ID>.<path>"),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "exists", "truthy", "contains"]),
  value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
});
export type Condition = z.infer<typeof Condition>;

// ---- gates ----
const relPath = z.string().min(1).max(300).refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).includes("..") && !p.includes("\0"), "a path inside the job worktree (relative, no ..)");
export type Gate =
  | { type: "all" | "any"; of: Gate[] }
  | { type: "result_ok" }
  | { type: "verdict_approved" }
  | { type: "no_blocking_findings"; severities?: string[] | undefined }
  | { type: "exit_code_zero" }
  | { type: "tests_passed" }
  | { type: "artifact_exists"; path: string }
  | { type: "fields_present"; fields: string[] }
  | { type: "condition"; condition: Condition };
export const GATE_TYPES = ["all", "any", "result_ok", "verdict_approved", "no_blocking_findings", "exit_code_zero", "tests_passed", "artifact_exists", "fields_present", "condition"] as const;
export const Gate: z.ZodType<Gate> = z.lazy(() => z.union([
  z.object({ type: z.enum(["all", "any"]), of: z.array(Gate).min(1).max(SYSTEM_LIMITS.maxGateNodes) }),
  z.object({ type: z.literal("result_ok") }),
  z.object({ type: z.literal("verdict_approved") }),
  z.object({ type: z.literal("no_blocking_findings"), severities: z.array(z.string().max(20)).max(8).optional() }),
  z.object({ type: z.literal("exit_code_zero") }),
  z.object({ type: z.literal("tests_passed") }),
  z.object({ type: z.literal("artifact_exists"), path: relPath }),
  z.object({ type: z.literal("fields_present"), fields: z.array(z.string().regex(/^[A-Za-z0-9_.]{1,60}$/)).min(1).max(20) }),
  z.object({ type: z.literal("condition"), condition: Condition }),
]));

// ---- failure routing ----
export const FAILURE_KINDS = ["findings", "error", "timeout", "gate", "any"] as const;
export const FAILURE_ACTIONS = ["retry", "goto", "skip", "block", "fail", "manual"] as const;
export const FailureRule = z.object({
  /** findings: the stage reported problems to fix. error: it failed transiently. timeout. gate: it finished but its success gate did not pass. any: all four. */
  on: z.enum(FAILURE_KINDS),
  action: z.enum(FAILURE_ACTIONS),
  target: stageId.optional(), // goto: the stage to send the job to (an earlier one to redo work, or a later failure handler)
  maxCycles: z.number().int().min(1).max(SYSTEM_LIMITS.maxFixCycles).optional(), // goto: lower than the project's fix-cycle limit, never higher
}).refine((r) => (r.action === "goto") === Boolean(r.target), { message: "`goto` needs a target stage, and no other action takes one" });
export type FailureRule = z.infer<typeof FailureRule>;

const Model = z.object({
  provider: z.enum(["local", "anthropic"]).optional(),
  // Passed to Claude Code's --model: it must never be able to look like a flag.
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/, "a model id or alias (letters, digits, . _ : / -)").optional(),
});

export const Stage = z.object({
  id: stageId,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  type: z.enum(STAGE_TYPES),
  /** type `factory`: which built-in handler runs. The stage id must equal it (the handlers record and read their work by that name). */
  handler: z.string().optional(),
  enabled: z.boolean().default(true),
  /** A required stage cannot be disabled or skipped by a failure rule. */
  required: z.boolean().default(true),
  /** Where the job goes after success. Default: the next enabled stage in order. */
  next: z.union([stageId, z.literal(COMPLETE)]).optional(),
  /** agent/review: the whole prompt template. factory: instructions appended to what the stage already tells its agents. */
  prompt: z.object({
    template: z.string().max(SYSTEM_LIMITS.maxPromptChars).optional(),
    instructions: z.string().max(SYSTEM_LIMITS.maxPromptChars).optional(),
  }).optional(),
  model: Model.optional(),
  timeoutSeconds: z.number().int().min(1).max(SYSTEM_LIMITS.maxStageTimeoutSeconds).default(900),
  retry: z.object({
    max: z.number().int().min(0).max(SYSTEM_LIMITS.maxRetries).default(2),
    delaySeconds: z.number().int().min(0).max(SYSTEM_LIMITS.maxRetryDelaySeconds).optional(), // default: the engine's backoff base
    backoff: z.boolean().default(true), // double the delay on every consecutive failure
  }).prefault({}),
  successGate: Gate.default({ type: "result_ok" }),
  onFailure: z.array(FailureRule).max(SYSTEM_LIMITS.maxFailureRules).default([]),
  /** Stages whose output this stage needs: it is not run (the job is blocked) if any of them has not succeeded in this job. */
  requires: z.array(stageId).max(10).default([]),
  outputs: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_]{1,40}$/), description: z.string().max(200).default("") })).max(20).default([]),
  /** Run the stage only when this holds; otherwise it is skipped (and recorded as skipped). */
  runIf: Condition.optional(),
  /** Which fix-cycle budget a failure route out of this stage spends, and whether entering the stage starts a fresh one. */
  budget: z.object({ phase: z.enum(["specification", "code", "ci"]).default("code"), resetOnEntry: z.boolean().default(false) }).optional(),
  /** Has side effects on the repository, tracker or host: skipped (and recorded) in a dry run. Factory stages take this from the engine's own table. */
  mutating: z.boolean().optional(),
  /** Per-type settings, validated by the stage-type registry. */
  config: z.record(z.string(), z.unknown()).default({}),
});
export type Stage = z.infer<typeof Stage>;

export const WorkflowDefinition = z.object({
  schemaVersion: z.literal(1).default(1),
  stages: z.array(Stage).min(1).max(SYSTEM_LIMITS.maxStages),
  limits: z.object({
    maxStageExecutions: z.number().int().min(1).max(SYSTEM_LIMITS.maxStageExecutions).default(SYSTEM_LIMITS.maxStageExecutions),
    /** Wall-clock budget for the whole job, from the moment it was created (time spent waiting for a person counts). */
    timeoutSeconds: z.number().int().min(60).max(SYSTEM_LIMITS.maxWorkflowTimeoutSeconds).optional(),
  }).prefault({}),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export const WorkflowMeta = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).default(""),
  category: z.string().trim().max(40).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
});
export type WorkflowMeta = z.infer<typeof WorkflowMeta>;
