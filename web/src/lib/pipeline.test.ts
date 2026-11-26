import { describe, expect, it } from "vitest";
import { customDefinition, defaultDefinition } from "../test-fixtures";
import { deriveFlow, describeFailures, fallbackDefinition, stageNames, stripOrder, stripStates, wasSkipped } from "./pipeline";
import type { Execution, Invocation, Job } from "./types";

const job = (o: Partial<Job> = {}): Job => ({ id: "j1", key: "JAM-1", project: "p", workflow: "default", stage: "CLAUDE_REVIEW", status: "running", heldFromStage: null, remediationAttempts: 0, stageAttempts: 0, autonomous: false, dryRun: false, prUrl: null, lastError: null, notBefore: null, createdAt: 1000, updatedAt: 1000, ...o });
let n = 0;
const exec = (stage: string, outcome = "succeeded", o: Partial<Execution> = {}): Execution => { n++; return { id: n, stage, attempt: 1, outcome, error: null, output: null, startedAt: 1000 + n * 1000, finishedAt: 1500 + n * 1000, ...o }; };
const inv = (stageExecutionId: number, model: string | null): Invocation => ({ id: 100 + stageExecutionId, stageExecutionId, agent: "a", model, exitCode: 0, durationMs: 1000, finished: true, usage: null, hasLog: false, at: 1 });
const def = defaultDefinition();

describe("flow derivation: the built-in Default Workflow", () => {
  it("marks finished steps and the running step, and counts a fix route only when it was really taken", () => {
    n = 0;
    const f = deriveFlow(job({ stage: "CLAUDE_REVIEW" }), def, [exec("AUTOMATED_TESTING"), exec("LOCAL_MODEL_REVIEW", "succeeded", { route: { action: "goto", to: "REMEDIATION", cycle: 1, of: 3, phase: "code" } }), exec("REMEDIATION"), exec("AUTOMATED_TESTING")], []);
    expect(f.nodes.AUTOMATED_TESTING).toMatchObject({ state: "done", attempts: 2 });
    expect(f.nodes.LOCAL_MODEL_REVIEW!.state).toBe("done"); // it did its work and sent the job back
    expect(f.nodes.CLAUDE_REVIEW!.state).toBe("run");
    expect(f.loopsUsed.has("LOCAL_MODEL_REVIEW>REMEDIATION")).toBe(true);
    expect(f.loopsUsed.has("CI_VALIDATION>REMEDIATION")).toBe(false);
    expect(f.taken.has("REMEDIATION>AUTOMATED_TESTING")).toBe(true); // the success edge out of the fix step
    expect(f.cycles).toEqual({ code: { used: 1, of: 3 } });
  });
  it("marks the step a held job stopped at (waiting for a person is blocked, failed is failed)", () => {
    n = 0;
    const blocked = deriveFlow(job({ stage: "NEEDS_ATTENTION", status: "waiting", heldFromStage: "FINAL_VALIDATION" }), def, [exec("FINAL_VALIDATION", "failed")], []);
    expect(blocked.nodes.FINAL_VALIDATION!.state).toBe("blocked"); expect(blocked.active).toBe("FINAL_VALIDATION");
    const failed = deriveFlow(job({ stage: "FAILED", status: "failed", heldFromStage: "FINAL_VALIDATION" }), def, [exec("FINAL_VALIDATION", "failed")], []);
    expect(failed.nodes.FINAL_VALIDATION!.state).toBe("fail");
    const paused = deriveFlow(job({ stage: "PAUSED", status: "waiting", heldFromStage: "IMPLEMENTATION" }), def, [], []);
    expect(paused.nodes.IMPLEMENTATION!.state).toBe("wait");
  });
  it("does not count re-checks while waiting as attempts or time on the step", () => {
    n = 0;
    const waits = Array.from({ length: 12 }, () => exec("MERGING", "waiting"));
    const f = deriveFlow(job({ stage: "MERGING", status: "queued" }), def, [exec("PULL_REQUEST_CREATION"), ...waits], []);
    expect(f.nodes.MERGING!.attempts).toBe(0); expect(f.nodes.MERGING!.durationMs).toBe(0);
    expect(f.nodes.MERGING!.state).toBe("wait");
    expect(f.nodes.PULL_REQUEST_CREATION!.attempts).toBe(1);
  });
  it("marks the end node done once the job completed, with the edge into it taken", () => {
    n = 0;
    const f = deriveFlow(job({ stage: "COMPLETED", status: "done" }), def, [exec("LINEAR_COMPLETION")], []);
    expect(f.nodes.COMPLETED!.state).toBe("done"); expect(f.taken.has("LINEAR_COMPLETION>COMPLETED")).toBe(true);
  });
  it("draws strips from the workflow's own order, never a fixed list", () => {
    const order = stripOrder(def);
    expect(order[0]).toBe("DISCOVERED"); expect(order).not.toContain("REMEDIATION"); // fix steps are not on the success path
    const s = stripStates(job({ stage: "AUTOMATED_TESTING" }), order);
    expect(s[order.indexOf("IMPLEMENTATION")]).toBe("done"); expect(s[order.indexOf("AUTOMATED_TESTING")]).toBe("run"); expect(s[order.indexOf("CI_VALIDATION")]).toBe("idle");
    expect(stripStates(job({ stage: "COMPLETED", status: "done" }), order).every((x) => x === "done")).toBe(true);
    expect(stripStates(job(), [])).toEqual([]);
  });
});

describe("flow derivation: a custom workflow", () => {
  const custom = customDefinition();
  it("shows a stage skipped by its condition as skipped (not done), and the branch the conditional took", () => {
    n = 0;
    const f = deriveFlow(job({ stage: "REVIEW", status: "running" }), custom, [
      exec("ELIGIBILITY_CHECK"), exec("TRIAGE"), exec("DOCS_CHECK", "succeeded", { output: '{"held":false,"to":"BUILD"}', route: { action: "branch", to: "BUILD", reason: "outputs.TRIAGE.docsOnly truthy (was false)" } }),
      exec("BUILD"),
    ], []);
    expect(f.nodes.DOCS_CHECK!.routes[0]!.route.action).toBe("branch");
    expect(f.taken.has("DOCS_CHECK>BUILD")).toBe(true); expect(f.taken.has("DOCS_CHECK>WRITE_DOCS")).toBe(false);
    expect(f.nodes.WRITE_DOCS?.state ?? "idle").toBe("idle");
    expect(f.nodes.REVIEW!.state).toBe("run");
    n = 0;
    const skipped = deriveFlow(job({ stage: "BUILD" }), custom, [exec("WRITE_DOCS", "succeeded", { output: '{"skipped":true,"reason":"its condition did not hold"}', route: { action: "skip", reason: "its condition did not hold" } })], []);
    expect(skipped.nodes.WRITE_DOCS).toMatchObject({ state: "skipped", skippedReason: "its condition did not hold" });
  });
  it("recognises a skipped execution even when its output was clipped to invalid JSON", () => {
    n = 0;
    expect(wasSkipped(exec("X", "succeeded", { output: '{"skipped":true,"reason":"a very long reas' }))).toBe(true);
    expect(wasSkipped(exec("X", "failed", { output: '{"skipped":true}' }))).toBe(false);
    expect(wasSkipped(exec("X", "succeeded", { output: '{"skipped":false}' }))).toBe(false);
  });
  it("counts retries (not the waiting polls), keeps the gate result and the models that really ran", () => {
    n = 0;
    const e1 = exec("BUILD", "failed", { error: "boom", route: { action: "retry", rule: 0, attempt: 1, of: 3, delayMs: 2000 } });
    const e2 = exec("BUILD", "waiting");
    const e3 = exec("BUILD", "succeeded", { gate: { passed: true, trace: { type: "exit_code_zero", passed: true, detail: "exit code was 0" } } });
    const e4 = exec("REVIEW", "succeeded");
    const f = deriveFlow(job({ stage: "REVIEW" }), custom, [e1, e2, e3, e4], [inv(e3.id, "claude-haiku"), inv(e3.id, "claude-haiku"), inv(e4.id, "claude-opus"), inv(e4.id, null)]);
    expect(f.nodes.BUILD).toMatchObject({ attempts: 2, retries: 1, state: "done", models: ["claude-haiku"] });
    expect(f.nodes.BUILD!.gate?.trace?.detail).toBe("exit code was 0");
    expect(f.nodes.REVIEW!.models).toEqual(["claude-opus"]);
    expect(f.taken.has("BUILD>REVIEW")).toBe(true);
  });
  it("records loops used and the fix-cycle counters from the routes the engine stored", () => {
    n = 0;
    const f = deriveFlow(job({ stage: "FIXUP", remediationAttempts: 1 }), custom, [exec("REVIEW", "succeeded", { route: { action: "goto", to: "FIXUP", rule: 0, cycle: 1, of: 2, phase: "code" } })], []);
    expect(f.loopsUsed).toEqual(new Set(["REVIEW>FIXUP"])); expect(f.cycles.code).toEqual({ used: 1, of: 2 });
    expect(f.nodes.FIXUP!.state).toBe("run");
  });
  it("ignores executions of stages that are not in the workflow, instead of inventing nodes", () => {
    n = 0;
    const f = deriveFlow(job({ stage: "BUILD" }), custom, [exec("SOMETHING_ELSE")], []);
    expect(f.nodes.SOMETHING_ELSE).toBeUndefined();
  });
});

describe("naming and fallbacks", () => {
  it("takes names from the definition, and builds a fallback from the job's own history when none was recorded", () => {
    expect(stageNames(customDefinition()).DOCS_CHECK).toBe("Docs only?");
    n = 0;
    const fb = fallbackDefinition([], [exec("IMPLEMENTATION"), exec("AUTOMATED_TESTING")], job({ stage: "CLAUDE_REVIEW" }));
    expect(fb.stages.map((s) => s.id)).toEqual(["IMPLEMENTATION", "AUTOMATED_TESTING", "CLAUDE_REVIEW"]);
    expect(fb.stages[1]!.name).toBe("Run checks");
  });
  it("describes failure rules in plain words", () => {
    const rev = customDefinition().stages.find((s) => s.id === "REVIEW")!;
    expect(describeFailures(rev, { FIXUP: "Fix up" })).toEqual(["Findings to fix: send the job to “Fix up” (at most 2 fix cycles)."]);
  });
});
