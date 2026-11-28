import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { decisions } from "../src/db/schema.js";
import { GATE_WAITING, confirmGate, returnGate } from "../src/core/gates.js";
import { cancelJob, JobError, retryJob } from "../src/core/jobs.js";
import { MAX_FEEDBACK } from "../src/core/feedback.js";
import { statusForStage } from "../src/core/workflow.js";
import { ProjectConfig } from "../src/config/schema.js";
import { sandboxAvailable } from "../src/exec/sandbox.js";
import { harness, impl, job, type H } from "./helpers/impl-harness.js";

const db = (h: H) => h.ctx.handle.db;
const writers = (h: H) => h.claude.calls.filter((c) => c.role === "prompt-writer");
const rows = (h: H, kind: string) => db(h).select().from(decisions).where(eq(decisions.kind, kind)).all();
const proj = (over: Record<string, unknown> = {}) => ProjectConfig.safeParse({ id: "p", name: "P", repository: "/x", ...over });

describe("gate config", () => {
  it("defaults to no gates, accepts a known gate and rejects an unknown one", () => {
    expect(proj().data?.gates).toEqual([]);
    expect(proj({ gates: ["REQUIREMENTS_ANALYSIS"] }).data?.gates).toEqual(["REQUIREMENTS_ANALYSIS"]);
    expect(proj({ gates: ["MERGING"] }).success).toBe(false);
    expect(proj({ gates: ["nonsense"] }).success).toBe(false);
  });
  it("is a held, waiting state", () => { expect(statusForStage("AWAITING_CONFIRMATION")).toBe("waiting"); });
});

describe.skipIf(!sandboxAvailable())("the prompt gate (haiku_prompt mode)", () => {
  it("holds after the prompt is generated, with no implementer running", async () => {
    const h = await harness({ planning: "haiku_prompt", gates: ["REQUIREMENTS_ANALYSIS"] });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "AWAITING_CONFIRMATION", status: "waiting", heldFromStage: "REQUIREMENTS_ANALYSIS" });
    expect(job(h).lastError).toMatch(new RegExp(`^${GATE_WAITING}`));
    expect(h.hist()).toEqual(["REQUIREMENTS_ANALYSIS:succeeded"]);
    expect(rows(h, "prompt.generated")).toHaveLength(1);
    await h.engine.tick(); // still waiting: nothing runs
    expect(impl(h)).toHaveLength(0);
    expect(writers(h)).toHaveLength(1);
  });

  it("Confirm continues at the implementation preparation stage and records who confirmed", async () => {
    const h = await harness({ planning: "haiku_prompt", gates: ["REQUIREMENTS_ANALYSIS"] });
    await h.engine.tick();
    confirmGate(db(h), h.jobId, "dashboard", "haiku_prompt");
    expect(job(h)).toMatchObject({ stage: "IMPLEMENTATION_PREPARATION", status: "queued", heldFromStage: null, lastError: null });
    expect(rows(h, "gate.confirmed")).toMatchObject([{ actor: "dashboard" }]);
    await h.engine.tick();
    expect(h.stages()).toContain("IMPLEMENTATION_PREPARATION");
    expect(writers(h)).toHaveLength(1); // not run again
  });

  it("Ask for changes re-runs prompt generation once with the note, spends no fix cycle, and may be repeated", async () => {
    const h = await harness({ planning: "haiku_prompt", gates: ["REQUIREMENTS_ANALYSIS"] });
    await h.engine.tick();
    returnGate(db(h), h.jobId, "  Also cover leap years  ", "dashboard");
    expect(rows(h, "gate.returned")).toMatchObject([{ actor: "dashboard", rationale: "Also cover leap years" }]);
    await h.engine.tick();
    expect(writers(h)).toHaveLength(2);
    expect(writers(h)[1]!.prompt).toContain("Also cover leap years");
    expect(writers(h)[0]!.prompt).not.toContain("Also cover leap years");
    expect(job(h)).toMatchObject({ stage: "AWAITING_CONFIRMATION", remediationAttempts: 0, stageAttempts: 0 }); // held again
    returnGate(db(h), h.jobId, "and negative years", "dashboard");
    await h.engine.tick();
    expect(writers(h)).toHaveLength(3);
    expect(writers(h)[2]!.prompt).toMatch(/leap years[\s\S]*negative years/);
    expect(job(h).remediationAttempts).toBe(0);
    expect(rows(h, "remediation")).toEqual([]);
    expect(rows(h, "prompt.generated")).toHaveLength(3);
  });

  it("rejects an empty or over-long note and changes nothing", async () => {
    const h = await harness({ planning: "haiku_prompt", gates: ["REQUIREMENTS_ANALYSIS"] });
    await h.engine.tick();
    const before = job(h);
    expect(() => returnGate(db(h), h.jobId, "   ", "x")).toThrow(JobError);
    expect(() => returnGate(db(h), h.jobId, "a".repeat(MAX_FEEDBACK + 1), "x")).toThrow(/too long/);
    expect(job(h)).toEqual(before);
    expect(rows(h, "gate.returned")).toEqual([]);
  });

  it("neither choice works on a job that is not at a gate", async () => {
    const h = await harness({ planning: "haiku_prompt" });
    expect(() => confirmGate(db(h), h.jobId, "x", "haiku_prompt")).toThrow(/not waiting at a gate/);
    expect(() => returnGate(db(h), h.jobId, "note", "x")).toThrow(/not waiting at a gate/);
  });

  it("retry re-runs the gated stage, and cancel works while waiting", async () => {
    const h = await harness({ planning: "haiku_prompt", gates: ["REQUIREMENTS_ANALYSIS"] });
    await h.engine.tick();
    retryJob(db(h), h.jobId, "dashboard");
    expect(job(h)).toMatchObject({ stage: "REQUIREMENTS_ANALYSIS", status: "queued" });
    await h.engine.tick();
    expect(job(h).stage).toBe("AWAITING_CONFIRMATION");
    cancelJob(db(h), h.jobId, "dashboard");
    expect(job(h)).toMatchObject({ stage: "CANCELLED", heldFromStage: "REQUIREMENTS_ANALYSIS" });
  });

  it("a project without gates behaves as before", async () => {
    const h = await harness({ planning: "haiku_prompt" });
    await h.engine.tick();
    expect(job(h).stage).not.toBe("AWAITING_CONFIRMATION");
    expect(rows(h, "hold.AWAITING_CONFIRMATION")).toEqual([]);
  });
});
