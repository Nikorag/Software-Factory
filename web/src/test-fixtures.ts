import { BUILTIN_HELP } from "./lib/builtin-stages";
import type { FailureRule, StageDef, WorkflowDef, WorkflowsMeta } from "./lib/workflows";

const ORDER = ["DISCOVERED", "ELIGIBILITY_CHECK", "REQUIREMENTS_ANALYSIS", "SPECIFICATION_GENERATION", "SPECIFICATION_REVIEW", "SPECIFICATION_REMEDIATION", "SPECIFICATION_VALIDATION", "IMPLEMENTATION_PREPARATION", "IMPLEMENTATION", "AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW", "REMEDIATION", "FINAL_VALIDATION", "PULL_REQUEST_CREATION", "CI_VALIDATION", "MERGE_VALIDATION", "MERGING", "LINEAR_COMPLETION"];
const NEXT: Record<string, string> = { SPECIFICATION_REVIEW: "SPECIFICATION_VALIDATION", CLAUDE_REVIEW: "FINAL_VALIDATION", REMEDIATION: "AUTOMATED_TESTING" };
const FIX: Record<string, string> = { SPECIFICATION_REVIEW: "SPECIFICATION_REMEDIATION", SPECIFICATION_VALIDATION: "SPECIFICATION_REMEDIATION", AUTOMATED_TESTING: "REMEDIATION", LOCAL_MODEL_REVIEW: "REMEDIATION", CLAUDE_REVIEW: "REMEDIATION", FINAL_VALIDATION: "REMEDIATION", CI_VALIDATION: "REMEDIATION" };

export const stage = (id: string, o: Partial<StageDef> = {}): StageDef => ({
  id, name: id, description: "", type: "agent", enabled: true, required: true, timeoutSeconds: 900, retry: { max: 1, backoff: true }, successGate: { type: "result_ok" }, onFailure: [], requires: [], outputs: [], config: {}, ...o,
});

/** The built-in Default Workflow as the backend builds it (same ids, order, `next` and fix routes). */
export function defaultDefinition(): WorkflowDef {
  const stages = ORDER.map((id, i): StageDef => {
    const onFailure: FailureRule[] = [...(FIX[id] ? [{ on: "findings", action: "goto", target: FIX[id] } as FailureRule] : []), { on: "error", action: "retry" }, { on: "timeout", action: "retry" }];
    const inOrder = ORDER[i + 1] ?? "COMPLETED";
    return stage(id, { name: BUILTIN_HELP[id]!.name, description: BUILTIN_HELP[id]!.what, type: "factory", handler: id, ...(NEXT[id] && NEXT[id] !== inOrder ? { next: NEXT[id] } : {}), onFailure, retry: { max: 2, backoff: true } });
  });
  return { schemaVersion: 1, stages, limits: {} };
}

export const META: WorkflowsMeta = {
  stageTypes: [
    { type: "factory", label: "Factory stage", description: "A built-in stage.", defaultConfig: {}, defaultGate: { type: "result_ok" }, defaultPrompt: null, usesModel: true, engineOnly: false },
    { type: "agent", label: "Agent", description: "Runs a read-only AI agent.", defaultConfig: { role: "requirements-analyst" }, defaultGate: { type: "fields_present", fields: ["text"] }, defaultPrompt: "Work on {{ticket.identifier}}", usesModel: true, engineOnly: false },
    { type: "review", label: "Review", description: "Runs a reviewer.", defaultConfig: { role: "qa-reviewer", blocking: ["blocker", "major"] }, defaultGate: { type: "all", of: [{ type: "verdict_approved" }, { type: "no_blocking_findings" }] }, defaultPrompt: "Review {{ticket.identifier}}", usesModel: true, engineOnly: false },
    { type: "check", label: "Command check", description: "Runs a project command.", defaultConfig: { command: "test" }, defaultGate: { type: "exit_code_zero" }, defaultPrompt: null, usesModel: false, engineOnly: false },
    { type: "conditional", label: "Condition", description: "Routes on a condition.", defaultConfig: {}, defaultGate: { type: "result_ok" }, defaultPrompt: null, usesModel: false, engineOnly: true },
  ],
  factoryHandlers: ORDER.map((h) => ({ handler: h, name: BUILTIN_HELP[h]!.name, description: BUILTIN_HELP[h]!.what, mutating: ["IMPLEMENTATION", "REMEDIATION", "PULL_REQUEST_CREATION", "LINEAR_COMPLETION", "SPECIFICATION_GENERATION", "SPECIFICATION_REMEDIATION", "IMPLEMENTATION_PREPARATION", "MERGING"].includes(h) })),
  gateTypes: ["all", "any", "result_ok", "verdict_approved", "no_blocking_findings", "exit_code_zero", "tests_passed", "artifact_exists", "fields_present", "condition"],
  failureKinds: ["findings", "error", "timeout", "gate", "any"], failureActions: ["retry", "goto", "skip", "block", "fail", "manual"], complete: "COMPLETED",
  promptVariables: [{ name: "ticket.identifier", description: "The ticket key" }, { name: "ticket.title", description: "The ticket title" }, { name: "workflow.name", description: "This workflow's name" }, { name: "findings", description: "Blocking findings" }, { name: "outputs.<STAGE_ID>", description: "An earlier stage's output" }],
  limits: { maxStages: 40, maxRetries: 10, maxRetryDelaySeconds: 3600, maxStageTimeoutSeconds: 86400, maxWorkflowTimeoutSeconds: 604800, maxFixCycles: 10, maxStageExecutions: 200, maxPromptChars: 20000, maxGateDepth: 5, maxGateNodes: 30, maxFailureRules: 10 },
  mandatory: [{ handler: "ELIGIBILITY_CHECK", guards: "mutating", why: "re-checks the live ticket before anything changes" }, { handler: "LOCAL_MODEL_REVIEW", guards: ["PULL_REQUEST_CREATION"], why: "the independent review" }],
  models: { routes: { classification: { provider: "local", model: "qwen" }, specification: { provider: "anthropic", model: "sonnet" }, implementation: { provider: "anthropic", model: "sonnet" }, independent_review: { provider: "local", model: "qwen" }, final_review: { provider: "anthropic", model: "opus" } }, providers: ["anthropic", "local"] },
};

/** A small custom workflow: an optional doc step skipped unless a condition holds, a conditional branch, and a review that retries then loops back. */
export function customDefinition(): WorkflowDef {
  return {
    schemaVersion: 1, limits: {},
    stages: [
      stage("ELIGIBILITY_CHECK", { name: "Eligibility", type: "factory", handler: "ELIGIBILITY_CHECK", retry: { max: 2, backoff: true } }),
      stage("TRIAGE", { name: "Triage", type: "agent", config: { role: "classifier" } }),
      stage("DOCS_CHECK", { name: "Docs only?", type: "conditional", config: { condition: { field: "outputs.TRIAGE.docsOnly", op: "truthy" }, then: "WRITE_DOCS", else: "BUILD" } }),
      stage("WRITE_DOCS", { name: "Write docs", type: "agent", required: false, mutating: true, runIf: { field: "outputs.TRIAGE.docsOnly", op: "truthy" }, next: "REVIEW" }),
      stage("BUILD", { name: "Build", type: "check", config: { command: "build" }, successGate: { type: "exit_code_zero" }, retry: { max: 3, backoff: true }, onFailure: [{ on: "error", action: "retry" }] }),
      stage("REVIEW", { name: "Review", type: "review", next: "COMPLETED", config: { role: "qa-reviewer", blocking: ["blocker"] }, successGate: { type: "all", of: [{ type: "verdict_approved" }, { type: "no_blocking_findings" }] }, onFailure: [{ on: "findings", action: "goto", target: "FIXUP", maxCycles: 2 }] }),
      stage("FIXUP", { name: "Fix up", type: "agent", next: "REVIEW" }),
    ],
  };
}
