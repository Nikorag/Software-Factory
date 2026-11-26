// Types mirroring the backend (src/workflows/*) and the workflow API (src/server/workflow-routes.ts).
export const COMPLETE = "COMPLETED";
export type StageType = "factory" | "agent" | "review" | "check" | "conditional";
export type ConditionOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "exists" | "truthy" | "contains";
export const CONDITION_OPS: { op: ConditionOp; label: string; needsValue: boolean }[] = [
  { op: "eq", label: "equals", needsValue: true }, { op: "neq", label: "does not equal", needsValue: true },
  { op: "gt", label: "is greater than", needsValue: true }, { op: "gte", label: "is at least", needsValue: true },
  { op: "lt", label: "is less than", needsValue: true }, { op: "lte", label: "is at most", needsValue: true },
  { op: "exists", label: "exists", needsValue: false }, { op: "truthy", label: "is set / not empty", needsValue: false }, { op: "contains", label: "contains", needsValue: true },
];
export interface Condition { field: string; op: ConditionOp; value?: string | number | boolean | undefined }
export type Gate =
  | { type: "all" | "any"; of: Gate[] }
  | { type: "result_ok" } | { type: "verdict_approved" } | { type: "no_blocking_findings"; severities?: string[] | undefined }
  | { type: "exit_code_zero" } | { type: "tests_passed" }
  | { type: "artifact_exists"; path: string } | { type: "fields_present"; fields: string[] } | { type: "condition"; condition: Condition };
export type FailureKind = "findings" | "error" | "timeout" | "gate" | "any";
export type FailureAction = "retry" | "goto" | "skip" | "block" | "fail" | "manual";
export interface FailureRule { on: FailureKind; action: FailureAction; target?: string | undefined; maxCycles?: number | undefined }
export type BudgetPhase = "specification" | "code" | "ci";
export interface StageDef {
  id: string; name: string; description: string; type: StageType; handler?: string | undefined; enabled: boolean; required: boolean; next?: string | undefined;
  prompt?: { template?: string | undefined; instructions?: string | undefined } | undefined;
  model?: { provider?: "local" | "anthropic" | undefined; model?: string | undefined } | undefined;
  timeoutSeconds: number; retry: { max: number; delaySeconds?: number | undefined; backoff: boolean };
  successGate: Gate; onFailure: FailureRule[]; requires: string[]; outputs: { name: string; description: string }[];
  runIf?: Condition | undefined; budget?: { phase: BudgetPhase; resetOnEntry: boolean } | undefined; mutating?: boolean | undefined;
  config: Record<string, unknown>;
}
export interface WorkflowDef { schemaVersion: 1; stages: StageDef[]; limits: { maxStageExecutions?: number | undefined; timeoutSeconds?: number | undefined } }
export interface Issue { path: string; message: string; severity: "error" | "warning" }

export interface WorkflowUsage { projects: string[]; labels: { id: string; name: string | null; priority: number }[]; activeJobs: number; isGlobalDefault: boolean }
export interface WorkflowView {
  id: string; name: string; description: string; version: number; enabled: boolean; builtin: boolean; category: string | null; tags: string[];
  createdAt: number; updatedAt: number; stageCount: number; valid: boolean;
}
export interface WorkflowListItem extends WorkflowView { usage: WorkflowUsage }
export interface WorkflowFull extends WorkflowListItem { definition: WorkflowDef; issues: Issue[]; warnings: Issue[]; versions: { version: number; name: string; createdAt: number }[] }
export interface AssignmentRow { id: number | string; scope: "project" | "label"; targetId: string; targetName: string | null; workflowId: string; priority: number }
export type ConflictPolicy = "block" | "project" | "tiebreak";
export interface WorkflowSettingsRow { defaultWorkflowId: string; labelConflictPolicy: ConflictPolicy }
export interface WorkflowList { workflows: WorkflowListItem[]; settings: WorkflowSettingsRow; assignments: AssignmentRow[] }

export interface StageTypeMeta { type: StageType; label: string; description: string; defaultConfig: Record<string, unknown>; defaultGate: Gate; defaultPrompt: string | null; usesModel: boolean; engineOnly: boolean }
export interface FactoryHandlerMeta { handler: string; name: string; description: string; mutating: boolean }
export interface WorkflowsMeta {
  stageTypes: StageTypeMeta[]; factoryHandlers: FactoryHandlerMeta[];
  gateTypes: string[]; failureKinds: FailureKind[]; failureActions: FailureAction[]; complete: string;
  promptVariables: { name: string; description: string }[];
  limits: Record<string, number>;
  mandatory: { handler: string; guards: "mutating" | string[]; why: string }[];
  models: { routes: Record<string, { provider: "local" | "anthropic"; model: string }>; providers: string[] };
}
export interface TrackerLabel { id: string; name: string; teams: string[] }
export interface AssignedLabel { id: string; name: string | null; workflowId: string; priority: number; foundInTracker: boolean }

export interface ResolutionRecord {
  source: "label" | "project" | "default"; reason: string;
  matchedLabels: { id: string; name: string; priority: number; workflowId: string }[];
  conflict?: { policy: string; outcome: "priority" | "project" | "tiebreak" | "blocked"; candidates: { workflowId: string; labelId: string; priority: number }[] };
}
export interface JobWorkflow { id: string; version: number | null; name: string; definition: WorkflowDef | null; resolution: ResolutionRecord | null; valid: boolean }
export interface GateTrace { type: string; passed: boolean; detail: string; children?: GateTrace[] }
export interface GateRecord { passed: boolean; trace?: GateTrace }
export interface RouteRecord { action: string; to?: string; rule?: number; reason?: string; attempt?: number; of?: number; delayMs?: number; cycle?: number; phase?: string }
