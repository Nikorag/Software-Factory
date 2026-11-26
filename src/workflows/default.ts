import { STAGES, type StageName, type WorkflowsConfig } from "../config/schema.js";
import { HAPPY_NEXT, MUTATING, REMEDIATE_TO } from "../core/workflow.js";
import { SYSTEM_LIMITS } from "./limits.js";
import { COMPLETE, WorkflowDefinition, type FailureRule, type Stage } from "./definition.js";

export const DEFAULT_WORKFLOW_ID = "default";
export const DEFAULT_WORKFLOW_NAME = "Default Workflow";
export const DEFAULT_WORKFLOW_DESCRIPTION = "The factory's standard process: specification, implementation, layered review, pull request and CI. Built in and read-only: duplicate it to make your own.";

const TEXT: Record<string, [name: string, description: string]> = {
  DISCOVERED: ["Discovered", "The job exists because discovery accepted the ticket."],
  ELIGIBILITY_CHECK: ["Eligibility check", "Re-reads the live ticket: still opted in, not blocked, still in the pickup status."],
  REQUIREMENTS_ANALYSIS: ["Requirements", "Claude reads the ticket and the code and asks a person only when what is wanted is unclear."],
  SPECIFICATION_GENERATION: ["Generate spec", "Spec Kit writes the specification, clarifications, plan and tasks."],
  SPECIFICATION_REVIEW: ["Spec review", "An independent, cheaper model reviews the specification read-only."],
  SPECIFICATION_REMEDIATION: ["Fix spec", "Claude fixes the valid specification findings and rejects invalid ones with evidence."],
  SPECIFICATION_VALIDATION: ["Spec validation", "Deterministic checks, then Spec Kit analyze."],
  IMPLEMENTATION_PREPARATION: ["Prepare", "Installs dependencies and runs the project's checks on the untouched base to get a baseline."],
  IMPLEMENTATION: ["Implement", "Claude implements the tasks in an isolated worktree; Spec Kit converge confirms nothing was missed."],
  AUTOMATED_TESTING: ["Run checks", "The factory runs build, typecheck, lint and tests itself, in a sandbox."],
  LOCAL_MODEL_REVIEW: ["Independent review", "An independent reviewer checks the diff against the spec; security-sensitive changes also get a security review."],
  CLAUDE_REVIEW: ["Claude review", "Claude reviews the change and rules on each earlier finding."],
  REMEDIATION: ["Fix findings", "The implementer session resumes with the findings and fixes the valid ones."],
  FINAL_VALIDATION: ["Final validation", "Gates no reviewer can waive, then every requirement shown in code and in a test."],
  PULL_REQUEST_CREATION: ["Open PR", "Pushes the branch (never forced) and opens the pull request with the evidence report."],
  CI_VALIDATION: ["CI", "Waits for the host's checks; failures go to a fix cycle."],
  MERGE_VALIDATION: ["Merge readiness", "Reports mergeability and review state to the tracker."],
  MERGING: ["Awaiting your merge", "The factory never merges: it waits until a person does."],
  LINEAR_COMPLETION: ["Complete", "Comments on the ticket, removes the finished worktree and moves the ticket to Done."],
};
const PHASE: Partial<Record<StageName, "specification" | "ci">> = { SPECIFICATION_REVIEW: "specification", SPECIFICATION_VALIDATION: "specification", CI_VALIDATION: "ci" };

/**
 * The Default Workflow, derived from the factory's own state machine (core/workflow.ts) and the stage timeouts and retry counts in
 * workflows.yaml, so upgrading an installation keeps its tuning. `kind` picks that file's per-kind overrides (its `feature` entry
 * is the one the shipped config tunes).
 */
export function buildDefaultDefinition(policy: WorkflowsConfig, kind = "feature"): WorkflowDefinition {
  const all = STAGES.filter((s) => s !== "COMPLETED");
  const stages: Stage[] = all.map((s, i) => {
    const p = { ...policy.defaults, ...(policy.workflows[kind]?.stages[s] ?? {}) };
    const inOrder = all[i + 1] ?? COMPLETE;
    const happy = HAPPY_NEXT[s] ?? COMPLETE;
    const onFailure: FailureRule[] = [];
    const target = REMEDIATE_TO[s];
    if (target) onFailure.push({ on: "findings", action: "goto", target });
    onFailure.push({ on: "error", action: "retry" }, { on: "timeout", action: "retry" });
    const phase = PHASE[s];
    const [name, description] = TEXT[s] ?? [s, ""];
    return {
      id: s, name, description, type: "factory", handler: s, enabled: true, required: true,
      ...(happy !== inOrder ? { next: happy } : {}),
      timeoutSeconds: Math.min(p.timeoutSeconds, SYSTEM_LIMITS.maxStageTimeoutSeconds), retry: { max: Math.min(p.maxRetries, SYSTEM_LIMITS.maxRetries), backoff: true }, successGate: { type: "result_ok" }, onFailure,
      requires: [], outputs: [], mutating: MUTATING.has(s),
      ...(phase || s === "IMPLEMENTATION_PREPARATION" ? { budget: { phase: phase ?? "code", resetOnEntry: s === "IMPLEMENTATION_PREPARATION" } } : {}),
      config: {},
    } as Stage;
  });
  return WorkflowDefinition.parse({ schemaVersion: 1, stages, limits: {} });
}
