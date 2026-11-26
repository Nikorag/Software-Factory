import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FactoryConfig, WorkflowsConfig } from "../src/config/schema.js";
import { openDb, type DbHandle } from "../src/db/client.js";
import { decisions, jobs, projects, stageExecutions } from "../src/db/schema.js";
import { Engine, type HandlerRegistry, type StageContext, type StageHandler, type TypedHandlers } from "../src/core/engine.js";
import { enqueue, getJob, recoverExpired, retryJob } from "../src/core/jobs.js";
import { simulatedHandlers } from "../src/core/simulation.js";
import { buildDefaultDefinition } from "../src/workflows/default.js";
import { CompiledWorkflow } from "../src/workflows/graph.js";
import { assign, createWorkflow, syncBuiltinWorkflow, updateWorkflow } from "../src/workflows/library.js";
import { resolveWorkflow } from "../src/workflows/resolver.js";
import { assertValid } from "../src/workflows/validate.js";

let h: DbHandle;
const policy = WorkflowsConfig.parse({ defaults: { timeoutSeconds: 5, maxRetries: 2 } });
beforeEach(() => { h = openDb(":memory:"); h.db.insert(projects).values({ id: "p", configJson: "{}" }).run(); syncBuiltinWorkflow(h.db, policy); });

const cfg = (factory: Record<string, unknown> = {}) => ({ factory: FactoryConfig.parse(factory), workflows: policy });
const engine = (handlers: HandlerRegistry = {}, typed: TypedHandlers = {}, factory: Record<string, unknown> = {}, extra = {}) =>
  new Engine({ db: h.db, logger: pino({ level: "silent" }), config: cfg(factory), handlers, typed, backoffBaseMs: 0, heartbeatMs: 10, abortSettleMs: 50, ...extra });

const st = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, type: "agent", config: { role: "classifier" }, retry: { max: 1 }, successGate: { type: "result_ok" }, ...over });
const wf = (stages: unknown[], limits: unknown = {}) => ({ schemaVersion: 1, stages, limits });
const add = (def: unknown, ext = "e1", over: Record<string, unknown> = {}) => {
  const d = assertValid(def);
  return enqueue(h.db, { projectId: "p", externalId: ext, externalKey: ext.toUpperCase(), resolved: { workflowId: "wf_test", workflowVersion: 1, definition: d, entryStage: new CompiledWorkflow(d).entry, record: { source: "project", reason: "test" } }, ...over }).job;
};
const history = (id: string) => h.db.select().from(stageExecutions).where(eq(stageExecutions.jobId, id)).all().map((r) => `${r.stage}:${r.outcome}`);
const ranStages = (id: string) => history(id).map((x) => x.split(":")[0]);
const ok = (output?: unknown): StageHandler => async () => ({ kind: "ok", output });
/** typed handlers that record the stage ids they ran, each answering from a script (default ok) */
const scripted = (log: string[], script: Record<string, StageHandler> = {}): TypedHandlers => {
  const run: StageHandler = async (ctx) => { log.push(ctx.stage!.id); return (script[ctx.stage!.id] ?? ok({ text: "done" }))(ctx); };
  return { agent: run, review: run, check: run };
};
const nth = (...fns: StageHandler[]): StageHandler => { let i = 0; return (ctx) => fns[Math.min(i++, fns.length - 1)]!(ctx); };

describe("configurable stage order", () => {
  it("runs stages in the workflow's order, passes over disabled stages and follows explicit next", async () => {
    const log: string[] = [];
    const j = add(wf([st("A", { next: "C" }), st("B", { required: false, enabled: false }), st("C"), st("D")]));
    await engine({}, scripted(log)).tick();
    expect(log).toEqual(["A", "C", "D"]);
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "COMPLETED", status: "done" });
    expect(ranStages(j.id)).toEqual(["A", "C", "D"]);
  });
  it("starts at the workflow's first enabled stage and different workflows have different shapes", async () => {
    const log: string[] = [];
    const a = add(wf([st("ONLY")]), "a");
    const b = add(wf([st("X"), st("Y"), st("Z")]), "b");
    expect(getJob(h.db, a.id)!.stage).toBe("ONLY");
    await engine({}, scripted(log)).tick();
    await engine({}, scripted(log)).tick();
    expect(ranStages(a.id)).toEqual(["ONLY"]);
    expect(ranStages(b.id)).toEqual(["X", "Y", "Z"]);
  });
  it("skips a stage whose condition does not hold, and records it as skipped", async () => {
    const log: string[] = [];
    const j = add(wf([st("A"), st("B", { required: false, runIf: { field: "outputs.A.risky", op: "truthy" } }), st("C")]));
    await engine({}, scripted(log, { A: ok({ risky: false }) })).tick();
    expect(log).toEqual(["A", "C"]);
    const b = h.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "B")).get()!;
    expect(JSON.parse(b.outputJson!)).toMatchObject({ skipped: true });
    expect(JSON.parse(b.routeJson!)).toMatchObject({ action: "skip" });
    void j;
  });
  it("runs the conditional stage's branch", async () => {
    for (const [risky, expected] of [[true, ["A", "HARD", "END"]], [false, ["A", "EASY", "END"]]] as const) {
      h = openDb(":memory:"); h.db.insert(projects).values({ id: "p", configJson: "{}" }).run();
      const log: string[] = [];
      add(wf([
        st("A"), { id: "IF", name: "risky?", type: "conditional", config: { condition: { field: "outputs.A.risky", op: "truthy" }, then: "HARD", else: "EASY" } },
        st("EASY", { next: "END" }), st("HARD", { next: "END" }), st("END"),
      ]));
      await engine({}, scripted(log, { A: ok({ risky }) })).tick();
      expect(log).toEqual(expected);
    }
  });
  it("makes a stage's extra instructions and model choice available to its handler, with variables filled in", async () => {
    let seen: StageContext | undefined;
    const def = wf([{ id: "ELIGIBILITY_CHECK", name: "E", type: "factory", handler: "ELIGIBILITY_CHECK", prompt: { instructions: "Be brief on {{job.key}}, attempt {{job.attempt}}, stage {{stage.name}}." }, model: { provider: "anthropic", model: "opus" } }]);
    add(def);
    await engine({ ELIGIBILITY_CHECK: async (c) => { seen = c; return { kind: "ok" }; } }).tick();
    expect(seen!.instructions).toBe("Be brief on E1, attempt 1, stage E.");
    expect(seen!.model).toEqual({ provider: "anthropic", model: "opus" });
    expect(seen!.stage!.id).toBe("ELIGIBILITY_CHECK");
  });
});

describe("success gates", () => {
  it("only advances when the gate holds, and records the evaluation", async () => {
    const log: string[] = [];
    const j = add(wf([st("REV", { type: "review", config: { role: "qa-reviewer" }, successGate: { type: "all", of: [{ type: "verdict_approved" }, { type: "no_blocking_findings" }] }, onFailure: [{ on: "gate", action: "fail" }] }), st("NEXT")]));
    await engine({}, scripted(log, { REV: ok({ verdict: "approve", findings: [{ id: "f1", severity: "major" }] }) })).tick();
    expect(log).toEqual(["REV"]); // an agent saying "approve" is not enough: a blocking finding remains
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "FAILED" });
    expect(getJob(h.db, j.id)!.lastError).toMatch(/success gate not met.*f1/);
    const e = h.db.select().from(stageExecutions).get()!;
    expect(JSON.parse(e.gateJson!)).toMatchObject({ passed: false, trace: { type: "all", children: [{ passed: true }, { passed: false }] } });
  });
  it("does not trust a claim of completion: a required artifact must exist", async () => {
    const j = add(wf([st("WRITE", { successGate: { type: "artifact_exists", path: "docs/out.md" }, onFailure: [{ on: "gate", action: "block" }] })]));
    await engine({}, scripted([])).tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "BLOCKED" });
  });
  it("lets a stage that passes its gate move on", async () => {
    const log: string[] = [];
    add(wf([st("A", { successGate: { type: "fields_present", fields: ["text"] } }), st("B")]));
    await engine({}, scripted(log)).tick();
    expect(log).toEqual(["A", "B"]);
  });
});

describe("failure routing", () => {
  it("retries a failing stage the configured number of times, persisting the attempt count and delay, then fails", async () => {
    const j = add(wf([st("A", { retry: { max: 2, delaySeconds: 30, backoff: true }, onFailure: [{ on: "error", action: "retry" }] })]));
    const e = engine({}, scripted([], { A: async () => ({ kind: "retry", reason: "flaky" }) }));
    await e.tick();
    let row = getJob(h.db, j.id)!;
    expect(row).toMatchObject({ status: "queued", stageAttempts: 1, lastError: "flaky" });
    expect(row.notBefore!.getTime() - Date.now()).toBeGreaterThan(25_000); // delaySeconds, not the engine default
    h.db.update(jobs).set({ notBefore: null }).run(); await e.tick();
    row = getJob(h.db, j.id)!;
    expect(row.stageAttempts).toBe(2);
    expect(row.notBefore!.getTime() - Date.now()).toBeGreaterThan(55_000); // backoff doubled it
    h.db.update(jobs).set({ notBefore: null }).run(); await e.tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "FAILED" });
    expect(getJob(h.db, j.id)!.lastError).toMatch(/A failed after 3 attempt\(s\): flaky/);
    expect(history(j.id)).toEqual(["A:failed", "A:failed", "A:failed"]);
  });
  it("uses a constant delay when backoff is off, and a zero-retry stage fails straight away", async () => {
    const j = add(wf([st("A", { retry: { max: 3, delaySeconds: 10, backoff: false } })]));
    const e = engine({}, scripted([], { A: async () => ({ kind: "retry", reason: "x" }) }));
    await e.tick(); h.db.update(jobs).set({ notBefore: null }).run(); await e.tick();
    expect(getJob(h.db, j.id)!.notBefore!.getTime() - Date.now()).toBeLessThan(11_000);
    const z = add(wf([st("Z", { retry: { max: 0 } })]), "z");
    await engine({}, scripted([], { Z: async () => ({ kind: "retry", reason: "x" }) })).tick();
    expect(getJob(h.db, z.id)).toMatchObject({ stage: "FAILED" });
  });
  it("sends a failed review back to an earlier stage with its findings, up to the fix-cycle limit, then asks a person", async () => {
    const seenFindings: string[] = [];
    const log: string[] = [];
    const rev = nth(
      async () => ({ kind: "remediate", reason: "1 blocking finding(s)", output: { findings: [{ id: "f1", severity: "major", file: "a.ts", line: 3, issue: "null deref", fix: "guard it" }] } }),
      async () => ({ kind: "remediate", reason: "again", output: { findings: [{ id: "f2", severity: "major", file: "a.ts", line: 3, issue: "still", fix: "x" }] } }),
      ok({ verdict: "approve", findings: [] }),
    );
    const j = add(wf([
      st("BUILD", { prompt: { template: "Fix: {{findings}}" } }),
      st("REVIEW", { type: "review", config: { role: "qa-reviewer", blocking: ["blocker", "major"] }, onFailure: [{ on: "findings", action: "goto", target: "BUILD" }] }),
    ]));
    const e = engine({}, scripted(log, { REVIEW: rev, BUILD: async (c) => { const { latestFindingsText } = await import("../src/workflows/context.js"); seenFindings.push(latestFindingsText(h.db, c.job.id)); return { kind: "ok", output: { text: "x" } }; } }), { maxRemediationAttempts: 3 });
    await e.tick();
    expect(log).toEqual(["BUILD", "REVIEW", "BUILD", "REVIEW", "BUILD", "REVIEW"]);
    expect(seenFindings[0]).toBe("");
    expect(seenFindings[1]).toMatch(/\[major\] a\.ts:3 null deref \(fix: guard it\)/); // the findings are what the fixing stage is given
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "COMPLETED", remediationAttempts: 2 });
    const route = h.db.select().from(stageExecutions).all().find((r) => r.routeJson?.includes("goto"))!;
    expect(JSON.parse(route.routeJson!)).toMatchObject({ action: "goto", to: "BUILD", cycle: 1, of: 3 });
  });
  it("bounds every failure loop: the rule's own cycle cap and the project's, then a person decides", async () => {
    const j = add(wf([st("A"), st("B", { onFailure: [{ on: "findings", action: "goto", target: "A", maxCycles: 2 }] })]));
    await engine({}, scripted([], { B: async () => ({ kind: "remediate", reason: "never good enough", output: { findings: [{ id: "x", severity: "major" }] } }) }), { maxRemediationAttempts: 10 }).tick();
    const row = getJob(h.db, j.id)!;
    expect(row).toMatchObject({ stage: "NEEDS_ATTENTION", remediationAttempts: 2 });
    expect(row.lastError).toMatch(/remediation attempts exhausted \(2\)/);
    expect(history(j.id).filter((x) => x.startsWith("B")).length).toBe(3);
    const k = add(wf([st("A"), st("B", { onFailure: [{ on: "findings", action: "goto", target: "A" }] })]), "k");
    await engine({}, scripted([], { B: async () => ({ kind: "remediate", reason: "x", output: { findings: [] } }) }), { maxRemediationAttempts: 1 }).tick();
    expect(getJob(h.db, k.id)).toMatchObject({ stage: "NEEDS_ATTENTION", remediationAttempts: 1 }); // the project's limit is lower than the workflow's
  });
  it("skips an optional stage when its failure rule says so, but never a required one", async () => {
    const log: string[] = [];
    const j = add(wf([st("A", { required: false, onFailure: [{ on: "error", action: "skip" }], retry: { max: 0 } }), st("B")]));
    await engine({}, scripted(log, { A: async () => ({ kind: "retry", reason: "nope" }) })).tick();
    expect(log).toEqual(["A", "B"]);
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "COMPLETED" });
    expect(h.db.select().from(decisions).all().some((d) => d.kind === "route.skip")).toBe(true);
    // a stored snapshot is data: even one edited by hand to skip a required stage is not honoured
    const raw = JSON.parse(JSON.stringify(assertValid(wf([st("R", { retry: { max: 0 } }), st("S")])))) as { stages: { onFailure: unknown[] }[] };
    raw.stages[0]!.onFailure = [{ on: "error", action: "skip" }];
    const r = enqueue(h.db, { projectId: "p", externalId: "r", externalKey: "R" }).job;
    h.db.update(jobs).set({ workflowId: "wf_x", workflowSnapshotJson: JSON.stringify(raw), stage: "R" }).where(eq(jobs.id, r.id)).run();
    await engine({}, scripted([], { R: async () => ({ kind: "retry", reason: "nope" }) })).tick();
    expect(getJob(h.db, r.id)).toMatchObject({ stage: "BLOCKED" }); // the engine refused the snapshot rather than skip
  });
  it("applies block, manual and fail actions, and rules in order (retry, then fall through)", async () => {
    for (const [action, stage] of [["block", "BLOCKED"], ["manual", "NEEDS_ATTENTION"], ["fail", "FAILED"]] as const) {
      h = openDb(":memory:"); h.db.insert(projects).values({ id: "p", configJson: "{}" }).run();
      const j = add(wf([st("A", { retry: { max: 0 }, onFailure: [{ on: "error", action }] })]));
      await engine({}, scripted([], { A: async () => ({ kind: "retry", reason: "r" }) })).tick();
      expect(getJob(h.db, j.id)!.stage).toBe(stage);
    }
    h = openDb(":memory:"); h.db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    const j = add(wf([st("A", { required: false, retry: { max: 1 }, onFailure: [{ on: "error", action: "retry" }, { on: "error", action: "skip" }] }), st("B")]));
    await engine({}, scripted([], { A: async () => ({ kind: "retry", reason: "r" }) })).tick();
    h.db.update(jobs).set({ notBefore: null }).run(); await engine({}, scripted([], { A: async () => ({ kind: "retry", reason: "r" }) })).tick();
    expect(history(j.id)).toEqual(["A:failed", "A:failed", "B:succeeded"]);
  });
  it("routes timeouts and gate failures by their own kind", async () => {
    const j = add(wf([st("A", { timeoutSeconds: 1, retry: { max: 0 }, onFailure: [{ on: "timeout", action: "block" }] })]));
    await engine({}, scripted([], { A: () => new Promise(() => {}) })).tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "BLOCKED" });
    expect(history(j.id)).toEqual(["A:timed_out"]);
  }, 10_000);
  it("never retries, skips or routes around a critical finding, or a stage that needs a person", async () => {
    const j = add(wf([st("A", { required: false, onFailure: [{ on: "any", action: "skip" }], retry: { max: 5 } }), st("B")]));
    await engine({}, scripted([], { A: async () => ({ kind: "remediate", reason: "bad", output: { findings: [{ id: "s", severity: "critical" }] } }) })).tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    for (const kind of ["blocked", "needs_attention"] as const) {
      const k = add(wf([st("A", { required: false, onFailure: [{ on: "any", action: "skip" }, { on: "any", action: "retry" }] }), st("B")]), `k-${kind}`);
      await engine({}, scripted([], { A: async () => ({ kind, reason: "person needed" }) })).tick();
      expect(getJob(h.db, k.id)!.stage).toBe(kind === "blocked" ? "BLOCKED" : "NEEDS_ATTENTION");
      expect(ranStages(k.id)).toEqual(["A"]);
    }
  });
});

describe("limits no workflow can raise", () => {
  it("stops a job that has used its stage-attempt allowance (the last-resort loop guard)", async () => {
    const j = add(wf([st("A"), st("B", { onFailure: [{ on: "findings", action: "goto", target: "A" }] })], { maxStageExecutions: 6 }));
    await engine({}, scripted([], { B: async () => ({ kind: "remediate", reason: "again", output: { findings: [] } }) }), { maxRemediationAttempts: 10 }).tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(getJob(h.db, j.id)!.lastError).toMatch(/already run 6 stage attempts/);
    expect(history(j.id)).toHaveLength(6);
  });
  it("fails a job that outlives the workflow's time limit", async () => {
    const j = add(wf([st("A")], { timeoutSeconds: 60 }));
    h.db.update(jobs).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(eq(jobs.id, j.id)).run();
    await engine({}, scripted([])).tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "FAILED" });
    expect(getJob(h.db, j.id)!.lastError).toMatch(/time limit of 60s/);
  });
  it("clamps a hand-edited snapshot's retry count and timeout to the system maxima instead of trusting it", async () => {
    const raw = JSON.parse(JSON.stringify(assertValid(wf([st("A")])))) as { stages: { retry: { max: number }; timeoutSeconds: number }[] };
    raw.stages[0]!.retry.max = 1000; raw.stages[0]!.timeoutSeconds = 99_999_999;
    const r = enqueue(h.db, { projectId: "p", externalId: "r", externalKey: "R" }).job;
    h.db.update(jobs).set({ workflowId: "wf_x", workflowSnapshotJson: JSON.stringify(raw), stage: "A" }).where(eq(jobs.id, r.id)).run();
    await engine({}, scripted([])).tick();
    expect(getJob(h.db, r.id)).toMatchObject({ stage: "BLOCKED", lastError: expect.stringMatching(/snapshot is not valid/) }); // schema ceilings reject it outright
  });
  it("blocks a stage whose required input stage has not succeeded", async () => {
    const j = add(wf([st("A", { next: "B" }), st("B", { requires: ["C"] }), st("C")]));
    await engine({}, scripted([])).tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "BLOCKED", lastError: expect.stringMatching(/needs the output of C/) });
  });
});

describe("mandatory safety gates are enforced by the engine itself", () => {
  const snapshotOf = (mutate: (d: { stages: Record<string, unknown>[] }) => void) => {
    const d = JSON.parse(JSON.stringify(buildDefaultDefinition(policy))) as { stages: Record<string, unknown>[] };
    mutate(d);
    return JSON.stringify(d);
  };
  const jobWith = (snapshot: string, stage = "DISCOVERED") => {
    const j = enqueue(h.db, { projectId: "p", externalId: "s", externalKey: "S" }).job;
    h.db.update(jobs).set({ workflowId: "wf_x", workflowSnapshotJson: snapshot, stage }).where(eq(jobs.id, j.id)).run();
    return j;
  };
  it("refuses a snapshot that routes around a mandatory review (validation is not the only line of defence)", async () => {
    const j = jobWith(snapshotOf((d) => { d.stages.find((s) => s.id === "AUTOMATED_TESTING")!.next = "PULL_REQUEST_CREATION"; }));
    await engine(simulatedHandlers()).tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "BLOCKED", lastError: expect.stringMatching(/snapshot is not valid.*PULL_REQUEST_CREATION/) });
    expect(ranStages(j.id)).toEqual([]); // nothing ran
  });
  it("blocks opening the PR if the reviews have not passed since the code last changed", async () => {
    // a valid snapshot, but the job is placed at PULL_REQUEST_CREATION with no review history
    const j = jobWith(JSON.stringify(buildDefaultDefinition(policy)), "PULL_REQUEST_CREATION");
    const ran: string[] = [];
    await engine({ ...simulatedHandlers(), PULL_REQUEST_CREATION: async () => { ran.push("PR"); return { kind: "ok" }; } }).tick();
    expect(ran).toEqual([]);
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "BLOCKED", lastError: expect.stringMatching(/cannot (run before|run: the code changed after) (ELIGIBILITY_CHECK|LOCAL_MODEL_REVIEW)/) });
  });
  it("blocks again when the code changed after the review passed", async () => {
    const j = enqueue(h.db, { projectId: "p", externalId: "s2", externalKey: "S2" }).job;
    h.db.update(jobs).set({ workflowId: "wf_x", workflowSnapshotJson: JSON.stringify(buildDefaultDefinition(policy)), stage: "DISCOVERED" }).where(eq(jobs.id, j.id)).run();
    let fixed = false;
    // run the whole flow; the final stage after REMEDIATION must pass the reviews again, which the default routes force anyway
    const handlers: HandlerRegistry = { ...simulatedHandlers(),
      AUTOMATED_TESTING: nth(async () => ({ kind: "remediate", reason: "red", output: { findings: [{ id: "c", severity: "blocker" }] } }), ok()),
      REMEDIATION: async () => { fixed = true; return { kind: "ok" }; },
    };
    await engine(handlers).tick();
    expect(fixed).toBe(true);
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "COMPLETED" });
    const order = ranStages(j.id);
    expect(order.lastIndexOf("LOCAL_MODEL_REVIEW")).toBeGreaterThan(order.lastIndexOf("REMEDIATION"));
    expect(order.indexOf("PULL_REQUEST_CREATION")).toBeGreaterThan(order.lastIndexOf("FINAL_VALIDATION"));
  });
  it("cannot be switched off by a workflow's retry policy, prompt or model: a custom workflow still runs the factory's own handler for them", async () => {
    // an aggressive configuration on the mandatory review: no retries, a different model, extra instructions. It must still run and still gate.
    const def = JSON.parse(JSON.stringify(buildDefaultDefinition(policy))) as { stages: Record<string, unknown>[] };
    const lm = def.stages.find((s) => s.id === "LOCAL_MODEL_REVIEW")!;
    lm.retry = { max: 0, backoff: false }; lm.model = { provider: "anthropic", model: "haiku" }; lm.prompt = { instructions: "Be quick." };
    const j = jobWith(JSON.stringify(def));
    const seen: StageContext[] = [];
    await engine({ ...simulatedHandlers(), LOCAL_MODEL_REVIEW: async (c) => { seen.push(c); return { kind: "needs_attention", reason: "critical security finding" }; } }).tick();
    expect(seen).toHaveLength(1);
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(ranStages(j.id)).not.toContain("PULL_REQUEST_CREATION");
  });
});

describe("snapshots and recovery", () => {
  it("a job keeps running its own snapshot when the workflow is edited, renamed, disabled or reassigned", async () => {
    const w = createWorkflow(h.db, { meta: { name: "Live", description: "", tags: [] }, definition: wf([st("A"), st("B"), st("C")]) });
    assign(h.db, { scope: "project", targetId: "p", workflowId: w.id });
    const r = resolveWorkflow(h.db, { projectId: "p", labels: [] });
    if (!r.ok) throw new Error(r.reason);
    const j = enqueue(h.db, { projectId: "p", externalId: "e", externalKey: "E", resolved: { workflowId: r.workflowId, workflowVersion: r.version, definition: r.definition, entryStage: r.entryStage, record: r.record } }).job;
    expect(j).toMatchObject({ workflowId: w.id, workflowVersion: 1, stage: "A" });
    expect(JSON.parse(j.workflowResolutionJson!)).toMatchObject({ source: "project" });
    // the library changes after the job started
    updateWorkflow(h.db, w.id, { definition: wf([st("A"), st("X")]), meta: { name: "Renamed", enabled: false } });
    const log: string[] = [];
    await engine({}, scripted(log)).tick();
    expect(log).toEqual(["A", "B", "C"]); // the original three stages
    expect(getJob(h.db, j.id)).toMatchObject({ workflowVersion: 1, stage: "COMPLETED" });
    // the next job picks up the new version, if the workflow is usable
    expect(resolveWorkflow(h.db, { projectId: "p", labels: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/disabled/) });
  });
  it("a service shutdown mid-stage resumes at the same stage without repeating finished ones or spending an attempt", async () => {
    const j = add(wf([st("A"), st("B"), st("C")]));
    const log: string[] = [];
    const e1 = engine({}, scripted(log, { B: async () => { e1.abortActive("shutdown"); return new Promise(() => {}); } }));
    await e1.tick();
    expect(history(j.id)).toEqual(["A:succeeded", "B:cancelled"]);
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "B", status: "queued", stageAttempts: 0 });
    const e2 = engine({}, scripted(log)); // "restart"
    await e2.tick();
    expect(log).toEqual(["A", "B", "B", "C"]);
    expect(history(j.id).filter((x) => x.startsWith("A"))).toEqual(["A:succeeded"]); // A ran once
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "COMPLETED" });
  });
  it("recovers a crashed job (expired lease) at its current stage, closing the dangling attempt", async () => {
    const j = add(wf([st("A"), st("B")]));
    h.db.update(jobs).set({ status: "running", leaseOwner: "dead", leaseExpiresAt: new Date(Date.now() - 1000), stage: "B" }).where(eq(jobs.id, j.id)).run();
    h.db.insert(stageExecutions).values({ jobId: j.id, stage: "B", attempt: 1, outcome: "started", idempotencyKey: `${j.id}:B:1` }).run();
    expect(recoverExpired(h.db, new Date())).toEqual([j.id]);
    const log: string[] = [];
    await engine({}, scripted(log)).tick();
    expect(log).toEqual(["B"]);
    expect(history(j.id)).toEqual(["B:failed", "B:succeeded"]);
  });
  it("keeps retry state across a restart: attempts used stay used", async () => {
    const j = add(wf([st("A", { retry: { max: 1 } })]));
    await engine({}, scripted([], { A: async () => ({ kind: "retry", reason: "x" }) })).tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stageAttempts: 1 });
    await engine({}, scripted([], { A: async () => ({ kind: "retry", reason: "x" }) })).tick(); // a brand new engine instance
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "FAILED" });
    expect(history(j.id)).toHaveLength(2);
  });
  it("a manual retry resumes at the stage the job stopped at, with the workflow's own stage names", async () => {
    const j = add(wf([st("A"), st("B", { retry: { max: 0 } }), st("C")]));
    await engine({}, scripted([], { B: async () => ({ kind: "retry", reason: "boom" }) })).tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "FAILED", heldFromStage: "B" });
    retryJob(h.db, j.id, "test");
    const log: string[] = [];
    await engine({}, scripted(log)).tick();
    expect(log).toEqual(["B", "C"]);
  });
  it("still runs jobs created before workflows existed (no snapshot) on the built-in graph", async () => {
    const j = enqueue(h.db, { projectId: "p", externalId: "old", externalKey: "OLD" }).job;
    expect(j.workflowSnapshotJson).toBeNull();
    await engine(simulatedHandlers()).tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "COMPLETED" });
    expect(ranStages(j.id)).toHaveLength(17);
  });
});
