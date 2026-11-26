import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { WorkflowsConfig } from "../src/config/schema.js";
import { enqueue } from "../src/core/jobs.js";
import { openDb, type DbHandle } from "../src/db/client.js";
import { jobs, projects, workflowAssignments } from "../src/db/schema.js";
import { buildDefaultDefinition, DEFAULT_WORKFLOW_ID } from "../src/workflows/default.js";
import { evaluateGate, type GateContext } from "../src/workflows/gates.js";
import { CompiledWorkflow } from "../src/workflows/graph.js";
import {
  assign, backfillJobSnapshots, createWorkflow, deleteWorkflow, duplicateWorkflow, getSettings, getWorkflow, listWorkflows, setEnabled, syncBuiltinWorkflow,
  unassign, updateSettings, updateWorkflow, usageOf, versionsOf, WorkflowError,
} from "../src/workflows/library.js";
import { resolveWorkflow } from "../src/workflows/resolver.js";
import { renderPrompt, validatePromptVariables } from "../src/workflows/template.js";
import { validateDefinition } from "../src/workflows/validate.js";
import { scratchDefinition } from "../src/server/workflow-routes.js";

const policy = WorkflowsConfig.parse({ workflows: { feature: { stages: { IMPLEMENTATION: { timeoutSeconds: 900, maxRetries: 1 } } } } });
let h: DbHandle;
beforeEach(() => { h = openDb(":memory:"); h.db.insert(projects).values({ id: "p", configJson: "{}" }).run(); syncBuiltinWorkflow(h.db, policy); });

const agentStage = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, type: "agent", config: { role: "classifier" }, retry: { max: 1 }, ...over });
const wf = (stages: unknown[], limits: unknown = {}) => ({ schemaVersion: 1, stages, limits });
const meta = (name: string) => ({ name, description: "", tags: [] });
const errs = (d: unknown) => { const r = validateDefinition(d); return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`); };
const make = (name: string, stages: unknown[] = [agentStage("A")]) => createWorkflow(h.db, { meta: meta(name), definition: wf(stages) });

describe("the built-in Default Workflow", () => {
  it("is created on a new installation, valid, and mirrors the factory's own state machine", () => {
    const row = getWorkflow(h.db, DEFAULT_WORKFLOW_ID)!;
    expect(row).toMatchObject({ builtin: true, enabled: true, version: 1, name: "Default Workflow" });
    const def = validateDefinition(JSON.parse(row.definitionJson));
    expect(def.ok).toBe(true);
    const g = new CompiledWorkflow((def as unknown as { definition: never }).definition);
    expect(g.stages).toHaveLength(19);
    expect(g.entry).toBe("DISCOVERED");
    // the happy path and the fix routes are exactly the old hard-coded ones
    expect(g.next("SPECIFICATION_REVIEW")).toBe("SPECIFICATION_VALIDATION");
    expect(g.next("CLAUDE_REVIEW")).toBe("FINAL_VALIDATION");
    expect(g.next("REMEDIATION")).toBe("AUTOMATED_TESTING");
    expect(g.next("LINEAR_COMPLETION")).toBe("COMPLETED");
    expect(g.stage("AUTOMATED_TESTING")!.onFailure[0]).toEqual({ on: "findings", action: "goto", target: "REMEDIATION" });
  });
  it("carries the retry counts and timeouts of workflows.yaml", () => {
    const d = buildDefaultDefinition(policy);
    expect(d.stages.find((s) => s.id === "IMPLEMENTATION")).toMatchObject({ timeoutSeconds: 900, retry: { max: 1 } });
    expect(d.stages.find((s) => s.id === "ELIGIBILITY_CHECK")).toMatchObject({ timeoutSeconds: 900, retry: { max: 2 } });
  });
  it("is protected: read-only, undeletable, cannot be disabled", () => {
    expect(() => updateWorkflow(h.db, DEFAULT_WORKFLOW_ID, { meta: { name: "x" } })).toThrow(/read-only/);
    expect(() => deleteWorkflow(h.db, DEFAULT_WORKFLOW_ID)).toThrow(/cannot be deleted/);
    expect(() => setEnabled(h.db, DEFAULT_WORKFLOW_ID, false)).toThrow(/cannot be disabled/);
  });
  it("is kept current on upgrade (new version when workflows.yaml changes) without touching other workflows", () => {
    const mine = make("Mine");
    syncBuiltinWorkflow(h.db, policy);
    expect(getWorkflow(h.db, DEFAULT_WORKFLOW_ID)!.version).toBe(1); // unchanged: no churn
    syncBuiltinWorkflow(h.db, WorkflowsConfig.parse({ defaults: { timeoutSeconds: 1200, maxRetries: 2 } }));
    expect(getWorkflow(h.db, DEFAULT_WORKFLOW_ID)!.version).toBe(2);
    expect(versionsOf(h.db, DEFAULT_WORKFLOW_ID).map((v) => v.version)).toEqual([1, 2]);
    expect(getWorkflow(h.db, mine.id)!.version).toBe(1);
  });
});

describe("workflow library", () => {
  it("creates, lists, edits and versions workflows; the version moves only when the definition changes", () => {
    const w = make("Bug fix");
    expect(w).toMatchObject({ version: 1, enabled: true, builtin: false });
    expect(w.id).toMatch(/^wf_/);
    const renamed = updateWorkflow(h.db, w.id, { meta: { name: "Bug fix v2", description: "d", tags: ["bug"], category: "fix" } });
    expect(renamed).toMatchObject({ name: "Bug fix v2", version: 1, category: "fix", id: w.id }); // rename keeps the stable id and version
    const edited = updateWorkflow(h.db, w.id, { definition: wf([agentStage("A"), agentStage("B")]) });
    expect(edited.version).toBe(2);
    expect(updateWorkflow(h.db, w.id, { definition: wf([agentStage("A"), agentStage("B")]) }).version).toBe(2); // identical save: no new version
    expect(versionsOf(h.db, w.id).map((v) => v.version)).toEqual([1, 2]);
    expect(listWorkflows(h.db).map((r) => r.name)).toEqual(["Bug fix v2", "Default Workflow"]);
  });
  it("refuses a duplicate name and an invalid definition, with the reasons", () => {
    make("Same");
    expect(() => make("Same")).toThrow(/already a workflow called/);
    try { createWorkflow(h.db, { meta: meta("Bad"), definition: wf([agentStage("A", { next: "NOPE" })]) }); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(WorkflowError); expect((e as WorkflowError).issues[0]!.message).toMatch(/no stage "NOPE"/); }
  });
  it("duplicates any workflow, the Default included, into an independent editable copy", () => {
    const copy = duplicateWorkflow(h.db, DEFAULT_WORKFLOW_ID);
    expect(copy).toMatchObject({ name: "Default Workflow (copy)", builtin: false, version: 1 });
    expect(duplicateWorkflow(h.db, DEFAULT_WORKFLOW_ID).name).toBe("Default Workflow (copy 2)");
    const def = JSON.parse(copy.definitionJson) as { stages: { id: string; prompt?: unknown; timeoutSeconds: number }[] };
    def.stages.find((s) => s.id === "CLAUDE_REVIEW")!.timeoutSeconds = 3000;
    updateWorkflow(h.db, copy.id, { definition: def });
    expect((JSON.parse(getWorkflow(h.db, DEFAULT_WORKFLOW_ID)!.definitionJson) as typeof def).stages.find((s) => s.id === "CLAUDE_REVIEW")!.timeoutSeconds).toBe(900); // the original is untouched
    expect(getWorkflow(h.db, copy.id)!.version).toBe(2);
  });
  it("starts from scratch with a valid minimal definition", () => {
    expect(validateDefinition(scratchDefinition()).ok).toBe(true);
  });
  it("shows usage, and refuses to delete what is assigned, default or running a job (unless the person confirms the assignments)", () => {
    const w = make("Used");
    assign(h.db, { scope: "project", targetId: "p", workflowId: w.id });
    assign(h.db, { scope: "label", targetId: "lbl-1", targetName: "bug", workflowId: w.id, priority: 5 });
    expect(usageOf(h.db, w.id)).toMatchObject({ projects: ["p"], labels: [{ id: "lbl-1", name: "bug", priority: 5 }], activeJobs: 0, isGlobalDefault: false });
    try { deleteWorkflow(h.db, w.id); expect.unreachable(); } catch (e) { expect((e as WorkflowError).code).toBe("in_use"); expect((e as WorkflowError).usage!.projects).toEqual(["p"]); }
    // an active job blocks even a confirmed delete
    const j = enqueue(h.db, { projectId: "p", externalId: "e1", externalKey: "E1" }).job;
    h.db.update(jobs).set({ workflowId: w.id }).where(eq(jobs.id, j.id)).run();
    expect(() => deleteWorkflow(h.db, w.id, { removeAssignments: true })).toThrow(/active job/);
    h.db.update(jobs).set({ status: "done", workflowId: w.id }).where(eq(jobs.id, j.id)).run();
    deleteWorkflow(h.db, w.id, { removeAssignments: true });
    expect(getWorkflow(h.db, w.id)).toBeUndefined();
    expect(h.db.select().from(workflowAssignments).all()).toHaveLength(0);
    // the global default cannot be deleted
    const g = make("Global");
    updateSettings(h.db, { defaultWorkflowId: g.id });
    expect(() => deleteWorkflow(h.db, g.id, { removeAssignments: true })).toThrow(/global default/);
  });
  it("will not assign, or make default, a disabled workflow", () => {
    const w = make("Off");
    setEnabled(h.db, w.id, false);
    expect(() => assign(h.db, { scope: "project", targetId: "p", workflowId: w.id })).toThrow(/disabled/);
    expect(() => updateSettings(h.db, { defaultWorkflowId: w.id })).toThrow(/disabled/);
  });
});

describe("validation", () => {
  it("rejects duplicate and reserved ids, unknown targets, bad models, unknown prompt variables", () => {
    expect(errs(wf([agentStage("A"), agentStage("A")]))).toContainEqual(expect.stringMatching(/duplicate stage id/));
    expect(errs(wf([agentStage("FAILED")]))).toContainEqual(expect.stringMatching(/reserved job state/));
    expect(errs(wf([agentStage("A", { model: { model: "--dangerous" } })]))).toContainEqual(expect.stringMatching(/model id or alias/));
    expect(errs(wf([agentStage("A", { prompt: { template: "Hi {{ticket.titel}} and {{outputs.GHOST}}" } })]).valueOf()).join("|")).toMatch(/did you mean \{\{ticket.title\}\}.*no stage "GHOST"/);
    expect(errs(wf([agentStage("A", { prompt: { template: "{{ticket.title" } })]))).toContainEqual(expect.stringMatching(/malformed/));
  });
  it("only allows read-only roles and approved commands, and keeps types honest", () => {
    expect(errs(wf([agentStage("A", { config: { role: "implementer" } })])).join("|")).toMatch(/config\.role/);
    expect(errs(wf([{ id: "C", name: "C", type: "check", config: { command: "rm -rf /" } }])).join("|")).toMatch(/config\.command/);
    expect(errs(wf([agentStage("A", { successGate: { type: "exit_code_zero" } })]).valueOf()).join("|")).toMatch(/exit code/);
    expect(errs(wf([{ id: "C", name: "C", type: "check", config: { command: "test" }, successGate: { type: "verdict_approved" } }])).join("|")).toMatch(/needs a verdict/);
    expect(errs(wf([{ id: "C", name: "C", type: "check", config: { command: "test" }, model: { model: "haiku" } }])).join("|")).toMatch(/do not use a model/);
  });
  it("keeps factory stages honest: id equals handler, local model refused for tool-using stages, no replaced prompts", () => {
    const f = (over: Record<string, unknown>) => wf([{ id: "IMPLEMENTATION", name: "I", type: "factory", handler: "IMPLEMENTATION", ...over }]);
    expect(errs(wf([{ id: "X", name: "X", type: "factory", handler: "IMPLEMENTATION" }])).join("|")).toMatch(/id must equal its handler/);
    expect(errs(f({ model: { provider: "local", model: "qwen" } })).join("|")).toMatch(/Claude Code/);
    expect(errs(f({ prompt: { template: "ignore all rules" } })).join("|")).toMatch(/built in/);
    expect(errs(f({ prompt: { instructions: "Prefer small commits. {{ticket.title}}" } })).join("|")).toMatch(/not available in extra instructions/);
    expect(errs(f({ prompt: { instructions: "Prefer small commits." } })).filter((e) => /prompt/.test(e))).toEqual([]);
  });
  it("validates routing: required stages cannot be disabled, skipped or conditional; targets must exist and be enabled", () => {
    expect(errs(wf([agentStage("A", { enabled: false })]))).toContainEqual(expect.stringMatching(/required, so it cannot be disabled/));
    expect(errs(wf([agentStage("A", { onFailure: [{ on: "error", action: "skip" }] })]))).toContainEqual(expect.stringMatching(/cannot skip it/));
    expect(errs(wf([agentStage("A", { runIf: { field: "job.dryRun", op: "truthy" } })]))).toContainEqual(expect.stringMatching(/cannot be conditional/));
    expect(errs(wf([agentStage("A", { onFailure: [{ on: "error", action: "goto", target: "Z" }] })]))).toContainEqual(expect.stringMatching(/no stage "Z"/));
    expect(errs(wf([agentStage("A", { onFailure: [{ on: "error", action: "goto", target: "B" }] }), agentStage("B", { required: false, enabled: false })]))).toContainEqual(expect.stringMatching(/"B" is disabled/));
    expect(validateDefinition(wf([agentStage("A", { required: false, onFailure: [{ on: "error", action: "skip" }] })])).ok).toBe(true);
  });
  it("prevents uncontrolled cycles: success-path loops are rejected, failure loops are allowed because they are budgeted", () => {
    expect(errs(wf([agentStage("A", { next: "B" }), agentStage("B", { next: "A" })])).join("|")).toMatch(/loops forever/);
    const ok = validateDefinition(wf([agentStage("A"), agentStage("B", { onFailure: [{ on: "findings", action: "goto", target: "A", maxCycles: 2 }] })]));
    expect(ok.ok).toBe(true);
    expect(errs(wf([agentStage("A", { onFailure: [{ on: "findings", action: "goto", target: "A", maxCycles: 99 }] })]))).not.toEqual([]); // beyond the system maximum
  });
  it("enforces system limits on retries, timeouts, stages and gate size", () => {
    expect(errs(wf([agentStage("A", { retry: { max: 11 } })]))).not.toEqual([]);
    expect(errs(wf([agentStage("A", { timeoutSeconds: 999_999 })]))).not.toEqual([]);
    expect(errs(wf(Array.from({ length: 41 }, (_, i) => agentStage(`S${i}`))))).not.toEqual([]);
    let gate: unknown = { type: "result_ok" };
    for (let i = 0; i < 6; i++) gate = { type: "all", of: [gate] };
    expect(errs(wf([agentStage("A", { successGate: gate })])).join("|")).toMatch(/nest at most/);
  });
  it("enforces the mandatory safety stages: present, enabled, required, unconditional and impossible to route around", () => {
    const base = () => (JSON.parse(JSON.stringify(buildDefaultDefinition(policy))) as { stages: Record<string, unknown>[] });
    const without = (id: string) => {
      const d = base(); const i = d.stages.findIndex((s) => s.id === id); const after = d.stages[i + 1]!.id as string;
      d.stages = d.stages.filter((s) => s.id !== id);
      for (const s of d.stages) if (s.next === id) s.next = after; // rewire around the removed stage so the only problem left is the missing safety stage
      return d;
    };
    expect(errs(without("LOCAL_MODEL_REVIEW")).join("|")).toMatch(/missing LOCAL_MODEL_REVIEW is a mandatory safety stage/);
    expect(errs(without("FINAL_VALIDATION")).join("|")).toMatch(/missing FINAL_VALIDATION/);
    expect(errs(without("ELIGIBILITY_CHECK")).join("|")).toMatch(/missing ELIGIBILITY_CHECK/);
    const disabled = base(); const lm = disabled.stages.find((s) => s.id === "LOCAL_MODEL_REVIEW")!; lm.enabled = false; lm.required = false;
    expect(errs(disabled).join("|")).toMatch(/LOCAL_MODEL_REVIEW cannot be disabled/);
    const cond = base(); (cond.stages.find((s) => s.id === "FINAL_VALIDATION")!).runIf = { field: "job.dryRun", op: "truthy" }; (cond.stages.find((s) => s.id === "FINAL_VALIDATION")!).required = false;
    expect(errs(cond).join("|")).toMatch(/FINAL_VALIDATION must stay required|FINAL_VALIDATION cannot be conditional/);
    // routing around: a stage before the review jumps straight to opening the PR
    const around = base(); (around.stages.find((s) => s.id === "AUTOMATED_TESTING")!).next = "PULL_REQUEST_CREATION";
    expect(errs(around).join("|")).toMatch(/PULL_REQUEST_CREATION can be reached without passing through (LOCAL_MODEL_REVIEW|FINAL_VALIDATION)/);
    // a failure route cannot skip a mandatory stage either
    const skip = base(); (skip.stages.find((s) => s.id === "LOCAL_MODEL_REVIEW")!).onFailure = [{ on: "error", action: "skip" }];
    expect(errs(skip).join("|")).toMatch(/failure cannot skip it/);
    (skip.stages.find((s) => s.id === "LOCAL_MODEL_REVIEW")!).required = false; // ...and making it optional first does not help: it is mandatory
    expect(errs(skip).join("|")).toMatch(/LOCAL_MODEL_REVIEW must stay required|cannot be skipped on failure/);
  });
  it("lets a workflow with no repository changes omit the review stages (a research workflow), but never the eligibility check once anything is mutated", () => {
    const research = wf([
      { id: "ELIGIBILITY_CHECK", name: "E", type: "factory", handler: "ELIGIBILITY_CHECK" }, agentStage("RESEARCH", { config: { role: "requirements-analyst" } }),
      { id: "LINEAR_COMPLETION", name: "C", type: "factory", handler: "LINEAR_COMPLETION" },
    ]);
    expect(validateDefinition(research).ok).toBe(true);
    const noElig = wf([agentStage("RESEARCH"), { id: "LINEAR_COMPLETION", name: "C", type: "factory", handler: "LINEAR_COMPLETION" }]);
    expect(errs(noElig).join("|")).toMatch(/missing ELIGIBILITY_CHECK/);
  });
});

describe("gates", () => {
  const ctx = (output: unknown, over: Partial<GateContext> = {}): GateContext => ({ output, job: { remediationAttempts: 1, stageAttempts: 0, dryRun: false, autonomous: false, manual: false, kind: "feature" }, outputOf: () => undefined, exists: () => false, ...over });
  it("evaluates each reusable gate deterministically, with a trace", () => {
    expect(evaluateGate({ type: "verdict_approved" }, ctx({ verdict: "approve" })).passed).toBe(true);
    expect(evaluateGate({ type: "verdict_approved" }, ctx({ verdict: "changes_required" })).passed).toBe(false);
    expect(evaluateGate({ type: "no_blocking_findings" }, ctx({ findings: [{ id: "x", severity: "minor" }] })).passed).toBe(true);
    const bad = evaluateGate({ type: "no_blocking_findings" }, ctx({ findings: [{ id: "x1", severity: "major" }] }));
    expect(bad).toMatchObject({ passed: false, trace: { detail: expect.stringContaining("x1") } });
    expect(evaluateGate({ type: "exit_code_zero" }, ctx({ exitCode: 0 })).passed).toBe(true);
    expect(evaluateGate({ type: "exit_code_zero" }, ctx({ exitCode: null })).passed).toBe(false);
    expect(evaluateGate({ type: "tests_passed" }, ctx({ results: [{ kind: "test", ok: true }, { kind: "lint", ok: false }] })).passed).toBe(true);
    expect(evaluateGate({ type: "tests_passed" }, ctx({ results: [{ kind: "lint", ok: true }] })).passed).toBe(false); // no test run is not "tests passed"
    expect(evaluateGate({ type: "fields_present", fields: ["a.b"] }, ctx({ a: { b: 1 } })).passed).toBe(true);
    expect(evaluateGate({ type: "fields_present", fields: ["a", "c"] }, ctx({ a: 1 })).trace.detail).toContain("c");
    expect(evaluateGate({ type: "artifact_exists", path: "specs/x.md" }, ctx({}, { exists: (p) => p === "specs/x.md" })).passed).toBe(true);
    expect(evaluateGate({ type: "condition", condition: { field: "job.remediationAttempts", op: "gte", value: 1 } }, ctx({})).passed).toBe(true);
    expect(evaluateGate({ type: "condition", condition: { field: "outputs.PLAN.size", op: "gt", value: 3 } }, ctx({}, { outputOf: () => ({ size: 5 }) })).passed).toBe(true);
  });
  it("combines conditions with AND and OR", () => {
    const approve = { type: "verdict_approved" } as const, exit0 = { type: "exit_code_zero" } as const;
    const o = ctx({ verdict: "approve", exitCode: 1 });
    expect(evaluateGate({ type: "all", of: [approve, exit0] }, o)).toMatchObject({ passed: false });
    expect(evaluateGate({ type: "any", of: [approve, exit0] }, o)).toMatchObject({ passed: true });
    const t = evaluateGate({ type: "all", of: [approve, exit0] }, o).trace;
    expect(t.children!.map((c) => c.passed)).toEqual([true, false]);
  });
});

describe("prompt templates", () => {
  it("renders variables in one pass: braces inside values are never expanded again", () => {
    expect(renderPrompt("{{ticket.title}} / {{job.attempt}} / {{missing}}", { "ticket.title": "Fix {{job.attempt}}", "job.attempt": "2" })).toBe("Fix {{job.attempt}} / 2 / ");
  });
  it("accepts documented variables and outputs of real stages, and explains the rest", () => {
    const ids = new Set(["PLAN", "BUILD"]);
    expect(validatePromptVariables("{{ticket.title}} {{findings}} {{outputs.PLAN}} {{outputs.PLAN.text}} {{ job.attempt }}", ids, "BUILD")).toEqual([]);
    expect(validatePromptVariables("{{outputs.BUILD}}", ids, "BUILD")[0]!.message).toMatch(/own output/);
    expect(validatePromptVariables("{{nope.x}}", ids)[0]!.message).toMatch(/unknown variable/);
  });
});

describe("workflow resolution", () => {
  let A: ReturnType<typeof make>, B: typeof A, C: typeof A;
  beforeEach(() => { A = make("Alpha"); B = make("Beta"); C = make("Gamma"); });
  const L = (id: string, name = id) => ({ id, name });
  const r = (labels: { id: string; name: string }[], projectId = "p") => resolveWorkflow(h.db, { projectId, labels });
  const ok = (x: ReturnType<typeof r>) => { if (!x.ok) throw new Error(x.reason); return x; };

  it("uses the built-in default when nothing is assigned, and records why", () => {
    const x = ok(r([L("l1")]));
    expect(x).toMatchObject({ workflowId: DEFAULT_WORKFLOW_ID, record: { source: "default" } });
    expect(x.record.reason).toMatch(/global default/);
    expect(x.entryStage).toBe("DISCOVERED");
  });
  it("uses the project's workflow when no label matches", () => {
    assign(h.db, { scope: "project", targetId: "p", workflowId: A.id });
    expect(ok(r([L("l1")]))).toMatchObject({ workflowId: A.id, record: { source: "project" } });
  });
  it("a label assignment beats the project assignment", () => {
    assign(h.db, { scope: "project", targetId: "p", workflowId: A.id });
    assign(h.db, { scope: "label", targetId: "bug", targetName: "bug", workflowId: B.id });
    const x = ok(r([L("other"), L("bug", "bug")]));
    expect(x).toMatchObject({ workflowId: B.id, record: { source: "label", matchedLabels: [{ id: "bug", name: "bug" }] } });
    expect(x.record.reason).toContain("bug");
  });
  it("matches labels by stable id, never by name", () => {
    assign(h.db, { scope: "label", targetId: "id-1", targetName: "bug", workflowId: B.id });
    expect(ok(r([{ id: "id-2", name: "bug" }])).record.source).toBe("default"); // same name, different label
    expect(ok(r([{ id: "id-1", name: "renamed" }])).workflowId).toBe(B.id); // renamed in Linear, still matches
  });
  it("treats several labels that name the same workflow as one match", () => {
    assign(h.db, { scope: "label", targetId: "l1", workflowId: B.id });
    assign(h.db, { scope: "label", targetId: "l2", workflowId: B.id });
    const x = ok(r([L("l1"), L("l2")]));
    expect(x).toMatchObject({ workflowId: B.id }); expect(x.record.conflict).toBeUndefined();
  });
  it("resolves different workflows by priority (lower number wins), regardless of the order Linear returns labels", () => {
    assign(h.db, { scope: "label", targetId: "bug", workflowId: B.id, priority: 10 });
    assign(h.db, { scope: "label", targetId: "urgent", workflowId: C.id, priority: 1 });
    for (const labels of [[L("bug"), L("urgent")], [L("urgent"), L("bug")]]) {
      const x = ok(r(labels));
      expect(x.workflowId).toBe(C.id);
      expect(x.record.conflict).toMatchObject({ outcome: "priority" });
    }
  });
  it("applies the conflict policy when priorities tie: block (default), project, or deterministic tiebreak", () => {
    assign(h.db, { scope: "project", targetId: "p", workflowId: A.id });
    assign(h.db, { scope: "label", targetId: "bug", workflowId: B.id });
    assign(h.db, { scope: "label", targetId: "doc", workflowId: C.id });
    const blocked = r([L("doc"), L("bug")]);
    expect(blocked).toMatchObject({ ok: false, code: "conflict", record: { conflict: { outcome: "blocked" } } });
    updateSettings(h.db, { labelConflictPolicy: "project" });
    expect(ok(r([L("doc"), L("bug")]))).toMatchObject({ workflowId: A.id, record: { source: "project", conflict: { outcome: "project" } } });
    updateSettings(h.db, { labelConflictPolicy: "tiebreak" });
    const a = ok(r([L("doc"), L("bug")])), b = ok(r([L("bug"), L("doc")]));
    expect(a.workflowId).toBe(b.workflowId); // stable
    expect(a.workflowId).toBe([B.id, C.id].sort()[0]);
  });
  it("never swaps in another workflow when the chosen one is disabled, deleted, or invalid", () => {
    assign(h.db, { scope: "project", targetId: "p", workflowId: A.id });
    assign(h.db, { scope: "label", targetId: "bug", targetName: "bug", workflowId: B.id });
    setEnabled(h.db, B.id, false);
    expect(r([L("bug", "bug")])).toMatchObject({ ok: false, code: "unavailable", reason: expect.stringMatching(/Beta.*disabled/) });
    setEnabled(h.db, B.id, true);
    h.raw.prepare("update workflows set definition_json = '{\"stages\":[]}' where id = ?").run(B.id);
    expect(r([L("bug", "bug")])).toMatchObject({ ok: false, code: "invalid" });
    h.raw.pragma("foreign_keys = OFF"); h.raw.prepare("delete from workflows where id = ?").run(A.id);
    expect(r([])).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer exists/) }); // the project's workflow is gone: not silently replaced
  });
  it("falls back to the built-in default if the chosen global default cannot run, and says so", () => {
    updateSettings(h.db, { defaultWorkflowId: A.id });
    expect(ok(r([])).workflowId).toBe(A.id);
    setEnabled(h.db, A.id, false);
    const x = ok(r([]));
    expect(x.workflowId).toBe(DEFAULT_WORKFLOW_ID);
    expect(x.record.reason).toMatch(/disabled.*built-in/);
  });
  it("ignores labels that no longer exist in the tracker (they simply never match)", () => {
    assign(h.db, { scope: "label", targetId: "deleted-label", workflowId: B.id });
    expect(ok(r([L("l1")])).record.source).toBe("default");
    expect(unassign(h.db, "label", "deleted-label")).toBe(true);
    expect(getSettings(h.db).labelConflictPolicy).toBe("block");
  });
});

describe("migration of existing installations", () => {
  it("gives jobs created before workflows existed the Default Workflow built from their own kind's policy, marking them legacy, and never overwrites an existing snapshot", () => {
    const old = enqueue(h.db, { projectId: "p", externalId: "o1", externalKey: "O1", workflow: "bugfix" }).job;
    expect(old.workflowSnapshotJson).toBeNull();
    expect(backfillJobSnapshots(h.db, policy)).toBe(1);
    const row = h.db.select().from(jobs).where(eq(jobs.id, old.id)).get()!;
    expect(row).toMatchObject({ workflowId: DEFAULT_WORKFLOW_ID, stage: "DISCOVERED" });
    expect(JSON.parse(row.workflowResolutionJson!)).toMatchObject({ legacy: true });
    const def = JSON.parse(row.workflowSnapshotJson!) as { stages: { id: string; retry: { max: number } }[] };
    expect(def.stages.find((s) => s.id === "IMPLEMENTATION")!.retry.max).toBe(2); // bugfix kind: no `feature` override, as before
    expect(backfillJobSnapshots(h.db, policy)).toBe(0); // idempotent
  });
});
