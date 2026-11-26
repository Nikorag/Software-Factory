import { COMPLETE, type Condition, type FailureRule, type Gate, type Issue, type StageDef, type StageType, type WorkflowDef, type WorkflowsMeta } from "./workflows";

/** Editor state helpers. All pure: they take a draft definition and return a new one, never mutate. */

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const sameDef = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Roles and commands are enums in the backend's stage-type schemas; the meta only carries their defaults, so the editor lists them here. */
export const AGENT_ROLES = ["classifier", "requirements-analyst", "spec-reviewer", "qa-reviewer", "security-reviewer", "final-reviewer"] as const;
export const REVIEW_ROLES = ["qa-reviewer", "spec-reviewer", "security-reviewer", "final-reviewer"] as const;
export const CHECK_COMMANDS = ["install", "build", "typecheck", "lint", "test"] as const;
export const SEVERITIES = ["critical", "blocker", "major", "minor"] as const;
export const PHASES = ["specification", "code", "ci"] as const;
export const TICKET_SCOPED = /^(ticket|repo|spec)\./;

const STAGE_ID = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const RESERVED = ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION"];

/** An id from a name: STEP_NAME style, unique among `taken` (and never a built-in stage's or a reserved job state). */
export function uniqueId(name: string, taken: Iterable<string>, builtin: readonly string[] = []): string {
  const used = new Set([...taken, ...builtin, ...RESERVED]);
  let base = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  if (!base || !/^[A-Z]/.test(base)) base = `STEP_${base}`.replace(/_$/, "");
  if (!base || base === "STEP") base = "STEP";
  let id = base, n = 2;
  while (used.has(id) || !STAGE_ID.test(id)) id = `${base}_${n++}`.slice(0, 48);
  return id;
}

export const usedHandlers = (def: WorkflowDef) => new Set(def.stages.filter((s) => s.type === "factory").map((s) => s.handler ?? s.id));
export const availableHandlers = (meta: WorkflowsMeta, def: WorkflowDef) => { const used = usedHandlers(def); return meta.factoryHandlers.filter((h) => !used.has(h.handler)); };

/** A new stage with the type's defaults from the meta (never copies of values hardcoded here). `name` is the display name; for a factory stage the handler decides the id. */
export function newStage(meta: WorkflowsMeta, def: WorkflowDef, type: StageType, opts: { name?: string; handler?: string } = {}): StageDef {
  const t = meta.stageTypes.find((x) => x.type === type);
  if (!t) throw new Error(`unknown stage type ${type}`);
  const retryRules: FailureRule[] = [{ on: "error", action: "retry" }, { on: "timeout", action: "retry" }];
  if (type === "factory") {
    const h = meta.factoryHandlers.find((x) => x.handler === opts.handler);
    if (!h) throw new Error("choose a built-in stage");
    return { id: h.handler, name: h.name, description: h.description, type, handler: h.handler, enabled: true, required: false, timeoutSeconds: 900, retry: { max: 2, backoff: true }, successGate: clone(t.defaultGate), onFailure: retryRules, requires: [], outputs: [], mutating: h.mutating, config: clone(t.defaultConfig) };
  }
  const name = (opts.name ?? "").trim() || t.label;
  const builtin = meta.factoryHandlers.map((h) => h.handler);
  const id = uniqueId(name, def.stages.map((s) => s.id), builtin);
  const config = clone(t.defaultConfig);
  if (type === "conditional") Object.assign(config, { condition: { field: "job.remediationAttempts", op: "gt", value: 0 }, then: COMPLETE, else: COMPLETE });
  return {
    id, name, description: "", type, enabled: true, required: true, timeoutSeconds: 900, retry: { max: type === "check" || type === "conditional" ? 0 : 1, backoff: true },
    successGate: clone(t.defaultGate), onFailure: type === "conditional" ? [] : retryRules.slice(0, 1),
    requires: [], outputs: [], config, ...(t.defaultPrompt ? { prompt: { template: t.defaultPrompt } } : {}),
  };
}

export function insertStage(def: WorkflowDef, stage: StageDef, afterId?: string | null): WorkflowDef {
  const i = afterId ? def.stages.findIndex((s) => s.id === afterId) : -1;
  const stages = [...def.stages];
  stages.splice(i >= 0 ? i + 1 : stages.length, 0, stage);
  return { ...def, stages };
}

export const updateStage = (def: WorkflowDef, id: string, patch: Partial<StageDef> | ((s: StageDef) => StageDef)): WorkflowDef => ({
  ...def, stages: def.stages.map((s) => (s.id === id ? (typeof patch === "function" ? patch(s) : { ...s, ...patch }) : s)),
});

/** Removes a stage and every reference to it, so the draft never points at something that is gone. */
export function removeStage(def: WorkflowDef, id: string): WorkflowDef {
  const stages = def.stages.filter((s) => s.id !== id).map((s): StageDef => {
    const out: StageDef = { ...s, requires: s.requires.filter((r) => r !== id), onFailure: s.onFailure.filter((r) => !(r.action === "goto" && r.target === id)) };
    if (out.next === id) delete out.next;
    if (s.type === "conditional") { const c = s.config as { then?: string; else?: string }; out.config = { ...s.config, ...(c.then === id ? { then: COMPLETE } : {}), ...(c.else === id ? { else: COMPLETE } : {}) }; }
    return out;
  });
  return { ...def, stages };
}

export function moveStage(def: WorkflowDef, id: string, dir: -1 | 1): WorkflowDef {
  const i = def.stages.findIndex((s) => s.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= def.stages.length) return def;
  const stages = [...def.stages];
  [stages[i], stages[j]] = [stages[j]!, stages[i]!];
  return { ...def, stages };
}

/** Changing a custom stage's type starts it over with the new type's defaults, keeping what is not type-specific. */
export function changeType(meta: WorkflowsMeta, s: StageDef, type: StageType): StageDef {
  if (s.type === type || s.type === "factory" || type === "factory") return s;
  const fresh = newStage(meta, { schemaVersion: 1, stages: [], limits: {} }, type, { name: s.name });
  const { prompt: _p, model: _m, ...rest } = s;
  void _p; void _m;
  return { ...rest, type, config: fresh.config, successGate: fresh.successGate, ...(fresh.prompt ? { prompt: fresh.prompt } : {}), ...(meta.stageTypes.find((t) => t.type === type)?.usesModel && s.model ? { model: s.model } : {}) };
}

export const defaultPromptOf = (meta: WorkflowsMeta, type: StageType) => meta.stageTypes.find((t) => t.type === type)?.defaultPrompt ?? null;

/** Mandatory safety stages that apply to this draft (the same rule as the backend's validation): locked in the editor. */
export function lockedHandlers(def: WorkflowDef, meta: WorkflowsMeta): Map<string, string> {
  const mutating = new Set(meta.factoryHandlers.filter((h) => h.mutating).map((h) => h.handler));
  const out = new Map<string, string>();
  for (const m of meta.mandatory) {
    const guarded = m.guards === "mutating"
      ? def.stages.filter((s) => s.enabled && s.id !== m.handler && ((s.type === "factory" && mutating.has(s.handler ?? s.id)) || (s.type !== "factory" && s.mutating)))
      : def.stages.filter((s) => s.enabled && s.type === "factory" && (m.guards as string[]).includes(s.handler ?? s.id));
    if (guarded.length && def.stages.some((s) => s.type === "factory" && (s.handler ?? s.id) === m.handler)) out.set(m.handler, m.why);
  }
  return out;
}

// ---- validation issues ----
export interface StageIssue extends Issue { field: string }
/** Issues for stage `index`, with the field path inside it ("onFailure.0.target"). Workflow-level issues ("stages") have no stage. */
export function issuesForStage(issues: Issue[], index: number): StageIssue[] {
  const prefix = `stages.${index}`;
  return issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`)).map((i) => ({ ...i, field: i.path.slice(prefix.length + 1) }));
}
export const workflowIssues = (issues: Issue[]) => issues.filter((i) => !/^stages\.\d+/.test(i.path));
/** Issues on a field or anything below it. */
export const atField = (issues: StageIssue[], field: string) => issues.filter((i) => i.field === field || i.field.startsWith(`${field}.`) || i.field.startsWith(`${field}[`));

/** Which stage ids have issues, by severity, for the list badges (indexes in the draft). */
export function issueCounts(issues: Issue[], count: number): { errors: number; warnings: number }[] {
  return Array.from({ length: count }, (_, i) => { const x = issuesForStage(issues, i); return { errors: x.filter((e) => e.severity === "error").length, warnings: x.filter((e) => e.severity === "warning").length }; });
}
export const stageIndexOfIssue = (i: Issue): number | null => { const m = /^stages\.(\d+)/.exec(i.path); return m ? Number(m[1]) : null; };

// ---- conditions ----
export type FieldKind = "job" | "output" | "outputs";
export const JOB_FIELDS = ["remediationAttempts", "stageAttempts", "dryRun", "autonomous", "manual", "kind"] as const;
export function parseField(field: string): { kind: FieldKind; job: string; stage: string; path: string } {
  const [root, ...rest] = field.split(".");
  if (root === "outputs") return { kind: "outputs", job: "remediationAttempts", stage: rest[0] ?? "", path: rest.slice(1).join(".") };
  if (root === "output") return { kind: "output", job: "remediationAttempts", stage: "", path: rest.join(".") };
  return { kind: "job", job: rest[0] ?? "remediationAttempts", stage: "", path: "" };
}
export const joinField = (p: { kind: FieldKind; job: string; stage: string; path: string }) => p.kind === "job" ? `job.${p.job}` : p.kind === "output" ? `output.${p.path}` : `outputs.${p.stage}.${p.path}`;
/** "5" is the number 5, "true" is a boolean, anything else is text: what the typed value in a condition means. */
export const parseValue = (raw: string): Condition["value"] => (raw === "true" ? true : raw === "false" ? false : raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw);

// ---- gates ----
export function newGate(type: string): Gate {
  switch (type) {
    case "all": case "any": return { type, of: [{ type: "result_ok" }] };
    case "no_blocking_findings": return { type };
    case "artifact_exists": return { type, path: "" };
    case "fields_present": return { type, fields: ["text"] };
    case "condition": return { type, condition: { field: "job.remediationAttempts", op: "eq", value: 0 } };
    default: return { type } as Gate;
  }
}
/** Gate types that make sense for a stage type, mirroring the backend's validation. */
export function gateTypesFor(stage: StageType, all: string[]): string[] {
  return all.filter((t) => !(((t === "verdict_approved" || t === "no_blocking_findings") && (stage === "agent" || stage === "check")) || ((t === "exit_code_zero" || t === "tests_passed") && (stage === "agent" || stage === "review"))));
}
export const GATE_LABELS: Record<string, string> = {
  all: "All of these", any: "Any of these", result_ok: "Stage reports success", verdict_approved: "Reviewer approves", no_blocking_findings: "No blocking findings", exit_code_zero: "Command exits 0",
  tests_passed: "Tests passed", artifact_exists: "A file exists", fields_present: "Output has fields", condition: "A condition holds",
};
/** Counts a gate's nodes and depth, the same way the backend limits them. */
export function gateSize(g: Gate, depth = 1): { depth: number; nodes: number } {
  if (g.type !== "all" && g.type !== "any") return { depth, nodes: 1 };
  const kids = g.of.map((x) => gateSize(x, depth + 1));
  return { depth: Math.max(depth, ...kids.map((k) => k.depth)), nodes: 1 + kids.reduce((n, k) => n + k.nodes, 0) };
}
export function updateGateAt(g: Gate, path: number[], next: Gate | null): Gate {
  if (!path.length) return next ?? g;
  if (g.type !== "all" && g.type !== "any") return g;
  const [i, ...rest] = path;
  const of = [...g.of];
  if (rest.length === 0 && next === null) of.splice(i!, 1);
  else of[i!] = updateGateAt(of[i!]!, rest, next);
  return { ...g, of };
}

/** Which model route a stage uses by default, so the editor can show it. Follows how the built-in stages use the configured routes. */
const ROLE_TASK: Record<string, string> = { classifier: "classification", "requirements-analyst": "specification", "spec-reviewer": "independent_review", "qa-reviewer": "independent_review", "security-reviewer": "final_review", "final-reviewer": "final_review" };
const HANDLER_TASK: Record<string, string> = {
  REQUIREMENTS_ANALYSIS: "specification", SPECIFICATION_GENERATION: "specification", SPECIFICATION_VALIDATION: "specification", SPECIFICATION_REMEDIATION: "specification",
  SPECIFICATION_REVIEW: "independent_review", LOCAL_MODEL_REVIEW: "independent_review", IMPLEMENTATION: "implementation", REMEDIATION: "implementation", CLAUDE_REVIEW: "final_review", FINAL_VALIDATION: "final_review",
};
export function defaultRouteOf(s: StageDef, meta: WorkflowsMeta): { task: string; provider: string; model: string } | null {
  const task = s.type === "factory" ? HANDLER_TASK[s.handler ?? s.id] : s.type === "agent" || s.type === "review" ? ROLE_TASK[String(s.config.role ?? "")] : undefined;
  const r = task ? meta.models.routes[task] : undefined;
  return task && r ? { task, provider: r.provider, model: r.model } : null;
}
