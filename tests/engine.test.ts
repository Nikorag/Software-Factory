import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FactoryConfig, WorkflowsConfig, type StageName } from "../src/config/schema.js";
import { openDb, type DbHandle } from "../src/db/client.js";
import { decisions, jobs, projects, stageExecutions } from "../src/db/schema.js";
import * as control from "../src/core/control.js";
import { Engine, type HandlerRegistry, type StageHandler } from "../src/core/engine.js";
import { cancelJob, enqueue, getJob, recoverExpired, retryJob, claimNext } from "../src/core/jobs.js";
import { simulatedHandlers } from "../src/core/simulation.js";
import { STAGES } from "../src/config/schema.js";
import type { ClaudeLimits } from "../src/agents/usage.js";

let h: DbHandle;
beforeEach(() => { h = openDb(":memory:"); h.db.insert(projects).values({ id: "p", configJson: "{}" }).run(); });

const config = (over: Record<string, unknown> = {}) => ({
  factory: FactoryConfig.parse({ workflow: { planning_mode: "speckit" }, ...over }),
  workflows: WorkflowsConfig.parse({ defaults: { timeoutSeconds: 5, maxRetries: 2 } }),
});
const engine = (handlers: HandlerRegistry, cfg = config(), extra = {}) =>
  new Engine({ db: h.db, logger: pino({ level: "silent" }), config: cfg, handlers, backoffBaseMs: 0, heartbeatMs: 10, abortSettleMs: 50, ...extra }); // most hangs here ignore their signal
const add = (dryRun = false, ext = "e1") => enqueue(h.db, { projectId: "p", externalId: ext, externalKey: ext.toUpperCase(), dryRun }).job;
const history = (id: string) => h.db.select().from(stageExecutions).where(eq(stageExecutions.jobId, id)).all().map((r) => `${r.stage}:${r.outcome}`);

describe("happy path", () => {
  it("runs all 19 executable stages to COMPLETED in order, persisting history", async () => {
    const job = add();
    await engine(simulatedHandlers()).tick();
    const j = getJob(h.db, job.id)!;
    expect(j).toMatchObject({ stage: "COMPLETED", status: "done", leaseOwner: null });
    expect(history(job.id)).toEqual(STAGES.slice(0, -1).map((s) => `${s}:succeeded`).filter((x) => !x.startsWith("SPECIFICATION_REMEDIATION") && !x.startsWith("REMEDIATION") && !x.startsWith("CONFLICT_RESOLUTION")));
  });
  it("haiku_prompt mode goes from requirements straight to implementation: no Spec Kit stages run", async () => {
    const job = add();
    await engine(simulatedHandlers(), config({ workflow: { planning_mode: "haiku_prompt" } })).tick();
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "COMPLETED", status: "done" });
    const ran = history(job.id).map((x) => x.split(":")[0]);
    expect(ran.slice(0, 5)).toEqual(["DISCOVERED", "ELIGIBILITY_CHECK", "REQUIREMENTS_ANALYSIS", "IMPLEMENTATION_PREPARATION", "IMPLEMENTATION"]);
    expect(ran.some((s) => s!.startsWith("SPECIFICATION_"))).toBe(false);
  });
  it("a directed remediate (merge conflicts) moves the job there without spending a fix cycle", async () => {
    const job = add();
    let hops = 0;
    const e = engine({ ...simulatedHandlers(), CI_VALIDATION: async () => (hops++ === 0 ? { kind: "remediate", to: "CONFLICT_RESOLUTION", reason: "conflicts" } : { kind: "ok" }) });
    await e.tick();
    const j = getJob(h.db, job.id)!;
    expect(j).toMatchObject({ stage: "COMPLETED", remediationAttempts: 0 });
    expect(history(job.id)).toContain("CONFLICT_RESOLUTION:succeeded");
    expect(h.db.select().from(decisions).where(eq(decisions.jobId, job.id)).all().map((d) => d.kind)).toContain("stage.redirect");
  });
});

describe("enqueue idempotency", () => {
  it("returns the existing active job instead of duplicating", () => {
    const a = enqueue(h.db, { projectId: "p", externalId: "x", externalKey: "X" });
    const b = enqueue(h.db, { projectId: "p", externalId: "x", externalKey: "X" });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
  });
  it("only one of two competing claims wins", () => {
    add();
    const now = new Date();
    expect(claimNext(h.db, "A", now, 1000)).toBeDefined();
    expect(claimNext(h.db, "B", now, 1000)).toBeUndefined();
  });
});

describe("retries", () => {
  it("retries transient failures then succeeds, with attempts recorded", async () => {
    let n = 0;
    const flaky: StageHandler = async () => (++n < 3 ? { kind: "retry", reason: "net" } : { kind: "ok" });
    const job = add();
    const e = engine({ ...simulatedHandlers(), ELIGIBILITY_CHECK: flaky });
    while ((await e.tick()) > 0 && getJob(h.db, job.id)!.status !== "done");
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
    expect(history(job.id).filter((x) => x.startsWith("ELIGIBILITY"))).toEqual(["ELIGIBILITY_CHECK:failed", "ELIGIBILITY_CHECK:failed", "ELIGIBILITY_CHECK:succeeded"]);
  });
  it("fails after retries are exhausted (no infinite loop) and records why", async () => {
    const job = add();
    const e = engine({ ...simulatedHandlers(), ELIGIBILITY_CHECK: async () => { throw new Error("boom"); } });
    for (let i = 0; i < 6; i++) await e.tick();
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "FAILED", status: "failed", heldFromStage: "ELIGIBILITY_CHECK" });
    expect(getJob(h.db, job.id)!.lastError).toMatch(/boom/);
    expect(history(job.id).filter((x) => x.includes("failed")).length).toBe(3);
  });
  it("applies exponential backoff via notBefore", async () => {
    const job = add();
    let t = 1_000_000;
    const e = engine({ ...simulatedHandlers(), ELIGIBILITY_CHECK: async () => ({ kind: "retry", reason: "x" }) }, config(), { now: () => new Date(t), backoffBaseMs: 1000 });
    await e.tick();
    expect(await e.tick()).toBe(0); // still backing off
    t += 1000;
    expect(await e.tick()).toBe(1);
    expect(getJob(h.db, job.id)!.stageAttempts).toBe(2);
  });
  it("times out a hung handler and treats it as a failure", async () => {
    const job = add();
    const cfg = { ...config(), workflows: WorkflowsConfig.parse({ defaults: { timeoutSeconds: 1, maxRetries: 0 } }) };
    await engine({ ...simulatedHandlers(), ELIGIBILITY_CHECK: () => new Promise(() => {}) }, cfg).tick();
    expect(history(job.id)).toContain("ELIGIBILITY_CHECK:timed_out");
    expect(getJob(h.db, job.id)!.stage).toBe("FAILED");
  }, 10_000);
});

describe("remediation", () => {
  it("loops review -> remediation -> test, capped at maxRemediationAttempts", async () => {
    const job = add();
    const always: StageHandler = async () => ({ kind: "remediate", reason: "bug" });
    await engine({ ...simulatedHandlers(), LOCAL_MODEL_REVIEW: always }).tick();
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "NEEDS_ATTENTION", remediationAttempts: 3, status: "waiting" });
    expect(history(job.id).filter((x) => x === "REMEDIATION:succeeded")).toHaveLength(3);
  });
  it("completes when remediation fixes the finding", async () => {
    const job = add();
    let reviews = 0;
    await engine({ ...simulatedHandlers(), CLAUDE_REVIEW: async () => (++reviews === 1 ? { kind: "remediate", reason: "x" } : { kind: "ok" }) }).tick();
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "COMPLETED", remediationAttempts: 1 });
  });
  it("respects a lower configured cap", async () => {
    const job = add();
    await engine({ ...simulatedHandlers(), AUTOMATED_TESTING: async () => ({ kind: "remediate", reason: "t" }) }, config({ maxRemediationAttempts: 1 })).tick();
    expect(getJob(h.db, job.id)!.remediationAttempts).toBe(1);
    expect(getJob(h.db, job.id)!.stage).toBe("NEEDS_ATTENTION");
  });
});

describe("holds and manual retry", () => {
  it("blocks when no handler exists, and resumes at the same stage on retry", async () => {
    const job = add();
    const rest = simulatedHandlers();
    delete rest.ELIGIBILITY_CHECK;
    await engine(rest).tick();
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "BLOCKED", heldFromStage: "ELIGIBILITY_CHECK" });
    retryJob(h.db, job.id, "test");
    await engine(simulatedHandlers()).tick();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
  });
  it("routes needs_attention and fail results to the right states", async () => {
    const a = add(false, "a"), b = add(false, "b");
    const e = engine({ ...simulatedHandlers(), REQUIREMENTS_ANALYSIS: async ({ job }) => job.id === a.id ? { kind: "needs_attention", reason: "ambiguous" } : { kind: "fail", reason: "nope" } }, config({ maxConcurrentJobs: 2 }));
    while ((await e.tick()) > 0); // one project runs one job at a time by default, so these two take two passes
    expect(getJob(h.db, a.id)!.stage).toBe("NEEDS_ATTENTION");
    expect(getJob(h.db, b.id)!.stage).toBe("FAILED");
  });
  it("refuses to retry a job that is not held", () => {
    const job = add();
    expect(() => retryJob(h.db, job.id, "t")).toThrow(/not retryable/);
  });
});

describe("cancellation", () => {
  it("cancels a queued job immediately", () => {
    const job = add();
    expect(cancelJob(h.db, job.id, "t")).toMatchObject({ status: "cancelled", stage: "CANCELLED" });
  });
  it("aborts a running handler via its signal and marks the job cancelled", async () => {
    const job = add();
    let sawAbort = false;
    const slow: StageHandler = ({ signal, job }) => new Promise((res) => {
      cancelJob(h.db, job.id, "t");
      signal.addEventListener("abort", () => { sawAbort = true; res({ kind: "ok" }); });
    });
    await engine({ ...simulatedHandlers(), ELIGIBILITY_CHECK: slow }).tick();
    expect(sawAbort).toBe(true);
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "CANCELLED", status: "cancelled", heldFromStage: "ELIGIBILITY_CHECK" });
    expect(history(job.id)).toContain("ELIGIBILITY_CHECK:cancelled");
  });
});

describe("Claude usage limit", () => {
  const reading = (over = {}): ClaudeLimits => ({ fiveHour: { utilization: 1, resetsAt: Date.parse("2030-01-01T05:00:00Z"), status: "rejected" }, sevenDay: null, status: "rejected", capturedAt: 0, ...over });
  it("starts nothing while exhausted, leaves jobs queued untouched, and runs them once the reset passes", async () => {
    const job = add();
    let clock = Date.parse("2030-01-01T00:00:00Z");
    const e = engine(simulatedHandlers(), config(), { claudeLimits: () => reading(), now: () => new Date(clock) });
    expect(e.start()).toBe(0);
    expect(await e.tick()).toBe(0);
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "DISCOVERED", status: "queued" });
    expect(history(job.id)).toEqual([]);
    expect(h.db.select().from(decisions).all()).toEqual([]);
    clock = Date.parse("2030-01-01T05:00:01Z"); // past the reset: no manual action needed
    await e.tick();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
  });
  it("a window with an unknown reset does not gate", async () => {
    const job = add();
    await engine(simulatedHandlers(), config(), { claudeLimits: () => reading({ fiveHour: { utilization: 1, resetsAt: null, status: "rejected" } }) }).tick();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
  });
  it("does not abort a job that is already running when the limit is reached", async () => {
    const job = add();
    let limited = false, aborted = false;
    const hang: StageHandler = ({ signal }) => new Promise((res) => {
      limited = true; // the limit is hit mid-run
      signal.addEventListener("abort", () => { aborted = true; });
      setTimeout(() => res({ kind: "ok" }), 60);
    });
    const e = engine({ ...simulatedHandlers(), IMPLEMENTATION: hang }, config(), { claudeLimits: () => (limited ? reading({ fiveHour: { utilization: 1, resetsAt: Date.now() + 3_600_000, status: "rejected" } }) : null) });
    await e.tick();
    expect(aborted).toBe(false);
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
  });
});

describe("pause and emergency stop", () => {
  it("does not start jobs while paused, and runs them after resume", async () => {
    const job = add();
    control.pause(h.db, "t");
    expect(await engine(simulatedHandlers()).tick()).toBe(0);
    expect(getJob(h.db, job.id)!.status).toBe("queued");
    control.resume(h.db, "t");
    await engine(simulatedHandlers()).tick();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
  });
  it("emergency stop aborts the active agent, holds the job as PAUSED, and it resumes after clear + resume", async () => {
    const job = add();
    let aborted = false;
    const hang: StageHandler = ({ signal }) => new Promise(() => {
      control.emergencyStop(h.db, "t", "fire");
      signal.addEventListener("abort", () => { aborted = true; });
    });
    await engine({ ...simulatedHandlers(), IMPLEMENTATION: hang }).tick();
    expect(aborted).toBe(true);
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "PAUSED", heldFromStage: "IMPLEMENTATION" });
    expect(await engine(simulatedHandlers()).tick()).toBe(0); // still stopped
    control.clearEmergencyStop(h.db, "t");
    expect(await engine(simulatedHandlers()).tick()).toBe(0); // cleared but still paused
    control.resume(h.db, "t");
    await engine(simulatedHandlers()).tick();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
    expect(h.db.select().from(decisions).all().some((d) => d.kind === "control.emergency_stop")).toBe(true);
  });
});

describe("crash recovery", () => {
  it("re-queues an orphaned running job and replays its interrupted stage without duplicating completed ones", async () => {
    const job = add();
    // Simulate a process that completed two stages then died mid-stage.
    const crashed = engine({ ...simulatedHandlers(), REQUIREMENTS_ANALYSIS: () => new Promise(() => {}) }, config(), { leaseMs: 1, owner: "dead" });
    const original = Date.now;
    void crashed.tick(); // never resolves; abandon it
    await new Promise((r) => setTimeout(r, 50));
    expect(getJob(h.db, job.id)!.stage).toBe("REQUIREMENTS_ANALYSIS");
    // The hung engine keeps heartbeating in-process, so stop its lease by hand to model a dead process.
    h.db.update(jobs).set({ leaseOwner: "dead", leaseExpiresAt: new Date(original() - 1000) }).where(eq(jobs.id, job.id)).run();
    expect(recoverExpired(h.db, new Date())).toEqual([job.id]);
    expect(history(job.id)).toContain("REQUIREMENTS_ANALYSIS:failed");
    await engine(simulatedHandlers()).tick();
    const hist = history(job.id);
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
    expect(hist.filter((x) => x === "DISCOVERED:succeeded")).toHaveLength(1);
    expect(hist.filter((x) => x === "ELIGIBILITY_CHECK:succeeded")).toHaveLength(1);
    expect(hist.filter((x) => x === "REQUIREMENTS_ANALYSIS:succeeded")).toHaveLength(1);
  });
  it("does not recover jobs whose lease is still valid", () => {
    add();
    claimNext(h.db, "A", new Date(), 60_000);
    expect(recoverExpired(h.db, new Date())).toEqual([]);
  });
});

describe("dry run", () => {
  const spy = () => { const called: StageName[] = []; const wrap = (s: StageName): StageHandler => async () => { called.push(s); return { kind: "ok" }; }; return { called, wrap }; };
  it("skips mutating stages, runs read-only ones, and records the plan", async () => {
    const { called, wrap } = spy();
    const handlers = Object.fromEntries(STAGES.filter((s) => s !== "COMPLETED").map((s) => [s, wrap(s)]));
    const job = add(true);
    await engine(handlers).tick();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
    expect(called).toContain("REQUIREMENTS_ANALYSIS");
    for (const m of ["IMPLEMENTATION", "MERGING", "PULL_REQUEST_CREATION", "LINEAR_COMPLETION", "SPECIFICATION_GENERATION"] as StageName[]) expect(called).not.toContain(m);
    expect(h.db.select().from(decisions).all().filter((d) => d.kind === "dry-run").length).toBeGreaterThanOrEqual(5);
  });
  it("is also enabled globally by config", async () => {
    const { called, wrap } = spy();
    add();
    await engine({ ...simulatedHandlers(), IMPLEMENTATION: wrap("IMPLEMENTATION") }, config({ dryRun: true })).tick();
    expect(called).toEqual([]);
  });
});

describe("wait (poll later without failing)", () => {
  it("re-queues for later, keeps the stage, and never consumes the retry budget (even after many waits)", async () => {
    const job = add();
    let t = 1_000_000, polls = 0;
    const e = engine({ ...simulatedHandlers(), ELIGIBILITY_CHECK: async () => (++polls < 25 ? { kind: "wait", reason: "CI pending", delayMs: 60_000 } : { kind: "ok" }) }, config(), { now: () => new Date(t) });
    for (let i = 0; i < 40; i++) { await e.tick(); t += 60_001; if (getJob(h.db, job.id)!.stage === "COMPLETED") break; }
    expect(polls).toBe(25);
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED"); // 24 waits > maxRetries (2) and nothing failed
    expect(history(job.id).filter((x) => x === "ELIGIBILITY_CHECK:waiting")).toHaveLength(24);
    expect(getJob(h.db, job.id)!.stageAttempts).toBe(0);
  });
  it("is not claimable before its delay has passed", async () => {
    const job = add();
    let t = 5_000_000;
    const e = engine({ ...simulatedHandlers(), ELIGIBILITY_CHECK: async () => ({ kind: "wait", reason: "later", delayMs: 600_000 }) }, config(), { now: () => new Date(t) });
    await e.tick();
    expect(await e.tick()).toBe(0);
    expect(getJob(h.db, job.id)).toMatchObject({ status: "queued", stage: "ELIGIBILITY_CHECK", lastError: null });
    t += 600_001;
    expect(await e.tick()).toBe(1);
  });
});

describe("immediate abort (stop, cancel, shutdown) reaches a running stage without waiting for the heartbeat", () => {
  const hang = (started: () => void): StageHandler => ({ signal }) => new Promise(() => { started(); void signal; });
  const withHeartbeat = { heartbeatMs: 60_000 }; // so only the direct abort can explain a fast stop

  it("abortActive('estop') stops the agent at once and holds the job PAUSED", async () => {
    const job = add();
    let started = false;
    const e = engine({ ...simulatedHandlers(), IMPLEMENTATION: hang(() => { started = true; }) }, config(), withHeartbeat);
    const run = e.tick();
    while (!started) await new Promise((r) => setTimeout(r, 5));
    expect(e.activeJobIds()).toEqual([job.id]);
    expect(e.abortActive("estop")).toBe(1);
    await run;
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "PAUSED", heldFromStage: "IMPLEMENTATION" });
    expect(e.activeJobIds()).toEqual([]);
  });
  it("abortActive('shutdown') re-queues the job exactly where it was, spending no attempt, and it resumes after restart", async () => {
    const job = add();
    let started = false;
    const e = engine({ ...simulatedHandlers(), IMPLEMENTATION: hang(() => { started = true; }) }, config(), withHeartbeat);
    const run = e.tick();
    while (!started) await new Promise((r) => setTimeout(r, 5));
    e.abortActive("shutdown");
    await run;
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "IMPLEMENTATION", status: "queued", stageAttempts: 0, leaseOwner: null, heldFromStage: null });
    expect(history(job.id).at(-1)).toBe("IMPLEMENTATION:cancelled");
    await engine(simulatedHandlers()).tick(); // "restart": a fresh engine finishes it
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
  });
  it("abortJob('cancel') aborts that one job's agent immediately", async () => {
    const job = add();
    let started = false;
    const e = engine({ ...simulatedHandlers(), IMPLEMENTATION: hang(() => { started = true; }) }, config(), withHeartbeat);
    const run = e.tick();
    while (!started) await new Promise((r) => setTimeout(r, 5));
    cancelJob(h.db, job.id, "t");
    expect(e.abortJob(job.id, "cancel")).toBe(true);
    expect(e.abortJob("not-running", "cancel")).toBe(false);
    await run;
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "CANCELLED", status: "cancelled" });
  });
});

const decisionsOf = (id: string, kind: string) => h.db.select().from(decisions).where(eq(decisions.jobId, id)).all().filter((d) => d.kind === kind);

describe("fix-cycle budgets are per phase (specification, code, CI)", () => {
  it("a specification that used its whole budget does not eat into the code's: the first code fix is attempt 1", async () => {
    const job = add();
    let validations = 0, reviews = 0;
    await engine({
      ...simulatedHandlers(),
      SPECIFICATION_VALIDATION: async () => (++validations <= 3 ? { kind: "remediate", reason: "spec gap" } : { kind: "ok" }),
      LOCAL_MODEL_REVIEW: async () => (++reviews === 1 ? { kind: "remediate", reason: "bug" } : { kind: "ok" }),
    }).tick();
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "COMPLETED", remediationAttempts: 1 });
    const fixes = decisionsOf(job.id, "remediation").map((d) => d.decision);
    expect(fixes).toEqual([
      "SPECIFICATION_VALIDATION -> SPECIFICATION_REMEDIATION (attempt 1 of 3, specification phase)",
      "SPECIFICATION_VALIDATION -> SPECIFICATION_REMEDIATION (attempt 2 of 3, specification phase)",
      "SPECIFICATION_VALIDATION -> SPECIFICATION_REMEDIATION (attempt 3 of 3, specification phase)",
      "LOCAL_MODEL_REVIEW -> REMEDIATION (attempt 1 of 3, code phase)",
    ]);
    expect(decisionsOf(job.id, "remediation.budget")[0]).toMatchObject({ decision: "fresh fix-cycle budget for the code phase", rationale: "the specification used 3" });
  });
  it("the specification phase is still capped on its own", async () => {
    const job = add();
    await engine({ ...simulatedHandlers(), SPECIFICATION_VALIDATION: async () => ({ kind: "remediate", reason: "never fixed" }) }).tick();
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "NEEDS_ATTENTION", remediationAttempts: 3 });
    expect(getJob(h.db, job.id)!.lastError).toMatch(/^remediation attempts exhausted \(3\) in the specification phase: never fixed/);
  });
  it("CI gets a fresh budget after the review fixes, which is not reset again when the PR is updated", async () => {
    const job = add();
    let reviews = 0;
    await engine({
      ...simulatedHandlers(),
      CLAUDE_REVIEW: async () => (++reviews <= 3 ? { kind: "remediate", reason: "review finding" } : { kind: "ok" }),
      CI_VALIDATION: async () => ({ kind: "remediate", reason: "CI red" }),
    }).tick();
    const j = getJob(h.db, job.id)!;
    expect(j).toMatchObject({ stage: "NEEDS_ATTENTION", remediationAttempts: 3 });
    expect(j.lastError).toMatch(/exhausted \(3\) in the CI phase: CI red/);
    const fixes = decisionsOf(job.id, "remediation").map((d) => d.decision);
    expect(fixes.filter((d) => d.startsWith("CLAUDE_REVIEW"))).toHaveLength(3);
    expect(fixes.filter((d) => d.startsWith("CI_VALIDATION"))).toEqual([
      "CI_VALIDATION -> REMEDIATION (attempt 1 of 3, CI phase)", "CI_VALIDATION -> REMEDIATION (attempt 2 of 3, CI phase)", "CI_VALIDATION -> REMEDIATION (attempt 3 of 3, CI phase)",
    ]);
    expect(history(job.id).filter((x) => x === "REMEDIATION:succeeded")).toHaveLength(6);
  });
  it("review findings while fixing CI spend the CI budget (no endless reset)", async () => {
    const job = add();
    let ci = 0;
    await engine({
      ...simulatedHandlers(),
      CI_VALIDATION: async () => (++ci === 1 ? { kind: "remediate", reason: "CI red" } : { kind: "ok" }),
      LOCAL_MODEL_REVIEW: async () => (ci >= 1 ? { kind: "remediate", reason: "regression" } : { kind: "ok" }),
    }).tick();
    expect(getJob(h.db, job.id)!.lastError).toMatch(/exhausted \(3\) in the CI phase: regression/);
    expect(decisionsOf(job.id, "remediation")).toHaveLength(3);
  });
});

describe("stage timeouts never undercut the stage's own work", () => {
  it("uses the built-in budget when the configured timeout is shorter, in every workflow", async () => {
    const job = enqueue(h.db, { projectId: "p", externalId: "b", externalKey: "B", workflow: "bugfix" }).job;
    const cfg = { ...config(), workflows: WorkflowsConfig.parse({ defaults: { timeoutSeconds: 1, maxRetries: 0 } }) };
    // REMEDIATION is reached only via a finding; IMPLEMENTATION always runs. Its handler outlives the configured 1s.
    await engine({ ...simulatedHandlers(), IMPLEMENTATION: () => new Promise((r) => setTimeout(() => r({ kind: "ok" }), 1300)) }, cfg).tick();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
    expect(history(job.id)).not.toContain("IMPLEMENTATION:timed_out");
  }, 10_000);
});

describe("the engine never reclaims a job it is running", () => {
  it("after a sleep pushes the clock past the lease, start() renews it instead of re-queueing the live job", async () => {
    const job = add();
    let t = 10_000_000, started = false, release: () => void = () => {};
    const impl: StageHandler = () => new Promise((r) => { started = true; release = () => r({ kind: "ok" }); });
    const e = engine({ ...simulatedHandlers(), IMPLEMENTATION: impl }, config({ maxConcurrentJobs: 2 }), { now: () => new Date(t), heartbeatMs: 60_000, leaseMs: 60_000 });
    e.start();
    while (!started) await new Promise((r) => setTimeout(r, 5));
    t += 2 * 3600_000; // the Mac slept for two hours: the worker tick runs before any heartbeat
    expect(e.start()).toBe(0); // nothing recovered, and the same job is not claimed a second time
    const j = getJob(h.db, job.id)!;
    expect(j).toMatchObject({ status: "running", leaseOwner: e.owner, stage: "IMPLEMENTATION" });
    expect(j.leaseExpiresAt!.getTime()).toBeGreaterThan(t);
    expect(decisionsOf(job.id, "recovery")).toHaveLength(0);
    expect(history(job.id).at(-1)).toBe("IMPLEMENTATION:started");
    release();
    await e.idle();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
  });
  it("still recovers another (crashed) owner's expired job", () => {
    const job = add();
    claimNext(h.db, "dead-process", new Date(0), 1000);
    const e = engine({}, config(), { now: () => new Date(10_000) });
    control.pause(h.db, "t"); // only recovery, no running
    e.start();
    expect(getJob(h.db, job.id)).toMatchObject({ status: "queued", leaseOwner: null });
    expect(recoverExpired(h.db, new Date(20_000), [job.id])).toEqual([]);
  });
  it("recoverExpired skips excluded jobs", () => {
    const job = add();
    claimNext(h.db, "A", new Date(0), 1000);
    expect(recoverExpired(h.db, new Date(5000), [job.id])).toEqual([]);
    expect(recoverExpired(h.db, new Date(5000))).toEqual([job.id]);
  });
});

describe("cancel then retry of a held job", () => {
  const hold = (id: string, stage: StageName, from: StageName | null) =>
    h.db.update(jobs).set({ stage, status: stage === "FAILED" ? "failed" : "waiting", heldFromStage: from }).where(eq(jobs.id, id)).run();
  it("keeps the stage the job was really at, so retry resumes the work, not the hold", async () => {
    const job = add();
    hold(job.id, "BLOCKED", "REQUIREMENTS_ANALYSIS");
    expect(cancelJob(h.db, job.id, "t")).toMatchObject({ stage: "CANCELLED", heldFromStage: "REQUIREMENTS_ANALYSIS" });
    expect(retryJob(h.db, job.id, "t")).toMatchObject({ stage: "REQUIREMENTS_ANALYSIS", status: "queued" });
    await engine(simulatedHandlers()).tick();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
    expect(history(job.id)[0]).toBe("REQUIREMENTS_ANALYSIS:succeeded");
  });
  it("a cancelled PAUSED job resumes where it paused, not from DISCOVERED", () => {
    const job = add();
    hold(job.id, "PAUSED", "IMPLEMENTATION");
    cancelJob(h.db, job.id, "t");
    expect(retryJob(h.db, job.id, "t").stage).toBe("IMPLEMENTATION");
  });
  it("a job queued in a held stage (left by the old behaviour) is released, not left running forever", async () => {
    const job = add();
    h.db.update(jobs).set({ stage: "BLOCKED", status: "queued" }).where(eq(jobs.id, job.id)).run();
    await engine(simulatedHandlers()).tick();
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "BLOCKED", status: "waiting", leaseOwner: null });
    expect(decisionsOf(job.id, "job.release")).toHaveLength(1);
    expect(await engine(simulatedHandlers()).tick()).toBe(0); // and it no longer occupies a slot or gets reclaimed
  });
});

describe("retry", () => {
  it("unarchives an archived job, so it does not run invisibly", async () => {
    const job = add();
    await engine({ ...simulatedHandlers(), ELIGIBILITY_CHECK: async () => ({ kind: "fail", reason: "nope" }) }).tick();
    h.db.update(jobs).set({ archivedAt: new Date() }).where(eq(jobs.id, job.id)).run();
    expect(retryJob(h.db, job.id, "t").archivedAt).toBeNull();
  });
  it("records the error it clears and the job's lifetime fix cycles; a later exhaustion says how many retries it took", async () => {
    const job = add();
    const always = { ...simulatedHandlers(), AUTOMATED_TESTING: async () => ({ kind: "remediate" as const, reason: "tests fail" }) };
    await engine(always).tick();
    const err = getJob(h.db, job.id)!.lastError!;
    retryJob(h.db, job.id, "you");
    const [r1] = decisionsOf(job.id, "job.retry");
    expect(r1).toMatchObject({ decision: "resume at AUTOMATED_TESTING (retry 1)", actor: "you" });
    expect(r1!.rationale).toContain(err);
    expect(r1!.rationale).toContain("Fix cycles: 3 in the phase being retried, 3 in total; manual retries: 1.");
    await engine(always).tick();
    expect(getJob(h.db, job.id)!.lastError).toContain("6 fix cycle(s) in total across 1 manual retry");
    retryJob(h.db, job.id, "you");
    expect(decisionsOf(job.id, "job.retry")[1]!.decision).toBe("resume at AUTOMATED_TESTING (retry 2)");
    expect(decisionsOf(job.id, "job.retry")[1]!.rationale).toContain("6 in total; manual retries: 2.");
  });
});

describe("an aborted stage is released only once its agent has stopped", () => {
  it("cancel waits for the handler to settle before holding the job", async () => {
    const job = add();
    let stopped = false;
    const slowStop: StageHandler = ({ signal }) => new Promise((r) => {
      cancelJob(h.db, job.id, "t");
      signal.addEventListener("abort", () => setTimeout(() => { stopped = true; r({ kind: "ok" }); }, 300)); // SIGTERM grace, post-run checks
    });
    const e = engine({ ...simulatedHandlers(), ELIGIBILITY_CHECK: slowStop }, config(), { abortSettleMs: 5000 });
    const run = e.tick();
    while (getJob(h.db, job.id)!.stage !== "CANCELLED") await new Promise((r) => setTimeout(r, 5));
    const heldWhileRunning = !stopped;
    await run;
    expect(heldWhileRunning).toBe(false);
    expect(getJob(h.db, job.id)).toMatchObject({ stage: "CANCELLED", status: "cancelled" });
  });
  it("a handler that has not stopped in time keeps its job from being claimed (no second agent in the worktree)", async () => {
    const job = add();
    let finish: () => void = () => {}, calls = 0;
    const stuck: StageHandler = () => (++calls > 1 ? Promise.resolve({ kind: "ok" }) : new Promise((r) => { cancelJob(h.db, job.id, "t"); finish = () => r({ kind: "ok" }); })); // ignores its signal
    const e = engine({ ...simulatedHandlers(), ELIGIBILITY_CHECK: stuck }, config(), { abortSettleMs: 30 });
    await e.tick();
    expect(getJob(h.db, job.id)!.stage).toBe("CANCELLED");
    retryJob(h.db, job.id, "t");
    expect(e.start()).toBe(0); // the old agent is still running
    finish();
    await new Promise((r) => setTimeout(r, 10));
    await e.tick();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
    expect(calls).toBe(2);
  });
});
