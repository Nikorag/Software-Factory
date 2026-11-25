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

let h: DbHandle;
beforeEach(() => { h = openDb(":memory:"); h.db.insert(projects).values({ id: "p", configJson: "{}" }).run(); });

const config = (over: Record<string, unknown> = {}) => ({
  factory: FactoryConfig.parse({ ...over }),
  workflows: WorkflowsConfig.parse({ defaults: { timeoutSeconds: 5, maxRetries: 2 } }),
});
const engine = (handlers: HandlerRegistry, cfg = config(), extra = {}) =>
  new Engine({ db: h.db, logger: pino({ level: "silent" }), config: cfg, handlers, backoffBaseMs: 0, heartbeatMs: 10, ...extra });
const add = (dryRun = false, ext = "e1") => enqueue(h.db, { projectId: "p", externalId: ext, externalKey: ext.toUpperCase(), dryRun }).job;
const history = (id: string) => h.db.select().from(stageExecutions).where(eq(stageExecutions.jobId, id)).all().map((r) => `${r.stage}:${r.outcome}`);

describe("happy path", () => {
  it("runs all 19 executable stages to COMPLETED in order, persisting history", async () => {
    const job = add();
    await engine(simulatedHandlers()).tick();
    const j = getJob(h.db, job.id)!;
    expect(j).toMatchObject({ stage: "COMPLETED", status: "done", leaseOwner: null });
    expect(history(job.id)).toEqual(STAGES.slice(0, -1).map((s) => `${s}:succeeded`).filter((x) => !x.startsWith("SPECIFICATION_REMEDIATION") && !x.startsWith("REMEDIATION")));
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
    await e.tick();
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
