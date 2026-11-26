import { describe, expect, it } from "vitest";
import { buildTimeline, decisionText, statsOf, summarise } from "./timeline";
import type { Decision, Execution, Invocation, Job, JobDetail } from "./types";

const T0 = 1_700_000_000_000;
const job = (o: Partial<Job> = {}): Job => ({ id: "j", key: "JAM-1", project: "p", workflow: "feature", stage: "CLAUDE_REVIEW", status: "running", heldFromStage: null, remediationAttempts: 1, stageAttempts: 0, autonomous: false, dryRun: false, prUrl: null, lastError: null, notBefore: null, createdAt: T0, updatedAt: T0 + 400_000, ...o });
let id = 0;
const ex = (stage: string, outcome: string, start: number, end: number | null, o: Partial<Execution> = {}): Execution => ({ id: ++id, stage, attempt: 1, outcome, error: null, output: null, startedAt: T0 + start * 1000, finishedAt: end === null ? null : T0 + end * 1000, ...o });
const dec = (kind: string, decision: string, at: number, rationale: string | null = null): Decision => ({ id: ++id, kind, decision, rationale, actor: "factory", at: T0 + at * 1000 });
const inv = (execId: number, agent: string, ms: number, exit: number | null = 0): Invocation => ({ id: ++id, stageExecutionId: execId, agent, model: "m", exitCode: exit, durationMs: ms, finished: true, usage: null, hasLog: true, at: T0 });
const detail = (executions: Execution[], decisions: Decision[] = [], invocations: Invocation[] = [], j = job()): JobDetail => ({ job: j, stageOrder: [], executions, decisions, invocations, artifacts: [], worktree: null, outbox: [] });

describe("job timeline", () => {
  const run = () => {
    id = 0;
    const tests1 = ex("AUTOMATED_TESTING", "succeeded", 10, 70, { output: JSON.stringify({ checks: "passed" }) });
    const review = ex("LOCAL_MODEL_REVIEW", "succeeded", 70, 100, { output: JSON.stringify({ remediate: "2 blocking finding(s) in the code review", details: { findings: [1, 2] } }) });
    const fix = ex("REMEDIATION", "succeeded", 100, 220, { output: JSON.stringify({ accepted: [1, 2], rejected: [{ id: "x" }], summary: "fixed the null case" }) });
    const tests2 = ex("AUTOMATED_TESTING", "succeeded", 220, 260);
    const claude = ex("CLAUDE_REVIEW", "started", 260, null);
    return detail(
      [ex("DISCOVERED", "succeeded", 0, 1), tests1, review, fix, tests2, claude],
      [dec("remediation", "LOCAL_MODEL_REVIEW -> REMEDIATION (attempt 1)", 100, "2 blocking finding(s)"), dec("human.answer", "answered while held at REQUIREMENTS_ANALYSIS", 5, "Use port 7777")],
      [inv(fix.id, "anthropic/implementer", 119_000), inv(claude.id, "anthropic/final-reviewer", 4000, null)],
    );
  };

  it("tells the story in order: each step, how it ended and why, with runs after a fix numbered", () => {
    const t = buildTimeline(run(), 3);
    expect(t.map((e) => `${e.title}|${e.tone}|run${e.run}`)).toEqual([
      "Discovered|ok|run1", "You answered|info|run1", "Run checks|ok|run1", "Independent review|loop|run1", "Fix findings · cycle 1 of 3|ok|run1", "Run checks|ok|run2", "Claude review|run|run1",
    ]);
  });
  it("says why a review sent work back, and what the fix did", () => {
    const t = buildTimeline(run(), 3);
    expect(t.find((e) => e.tone === "loop")!.summary).toBe("Sent back for fixes: 2 blocking finding(s) in the code review");
    expect(t.find((e) => e.cycle === 1)!.summary).toContain("fixed 2, rejected 1 with reasons");
    expect(t.find((e) => e.cycle === 1)!.summary).toContain("fixed the null case");
  });
  it("attaches decisions to the step that was running, and keeps a decision made outside any step as its own entry", () => {
    const t = buildTimeline(run(), 3);
    const review = t.find((e) => e.title === "Independent review")!, fixRow = t.find((e) => e.cycle === 1)!;
    expect([...review.events, ...fixRow.events].some((x) => x.label === "Sent back" && /attempt 1/.test(x.text))).toBe(true);
    const answer = t.find((e) => e.title === "You answered")!;
    expect(answer.stage).toBeUndefined();
    expect(answer.summary).toContain("Use port 7777");
  });
  it("shows the agent runs behind a step, and marks one still running", () => {
    const t = buildTimeline(run(), 3);
    expect(t.find((e) => e.cycle === 1)!.runs.map((r) => r.agent)).toEqual(["anthropic/implementer"]);
    expect(t.find((e) => e.title === "Claude review")!.runs[0]!.exitCode).toBeNull();
    expect(statsOf(t)).toMatchObject({ fixCycles: 1, runs: 2 });
  });
  it("counts fix cycles from the last retry, since a retry resets the budget", () => {
    id = 0;
    const fixes = [ex("REMEDIATION", "succeeded", 10, 20), ex("REMEDIATION", "succeeded", 30, 40), ex("REMEDIATION", "succeeded", 100, 110), ex("REMEDIATION", "succeeded", 120, 130)];
    const t = buildTimeline(detail(fixes, [dec("job.retry", "resume at IMPLEMENTATION", 60)]), 3);
    expect(t.filter((e) => e.cycle).map((e) => e.cycle)).toEqual([1, 2, 1, 2]);                 // not 1, 2, 3, 4 ("cycle 4 of 3")
    expect(t.find((e) => e.title === "You retried")).toBeTruthy();
  });
  it("puts what was found first and the agent's own prose last", () => {
    expect(summarise({ accepted: [1], rejected: [], summary: "R1 was valid. A long explanation." })).toBe("fixed 1 · R1 was valid. A long explanation.");
  });
  it("explains a failure in the step's own words, and a timeout", () => {
    id = 0;
    const t = buildTimeline(detail([ex("SPECIFICATION_GENERATION", "failed", 0, 60, { error: "spec-writer: security boundary violation (protected path changed: .claude/x)\nmore lines" }), ex("IMPLEMENTATION", "timed_out", 60, 3660, { error: "exceeded 3600s" })]));
    expect(t[0]).toMatchObject({ tone: "fail", summary: "spec-writer: security boundary violation (protected path changed: .claude/x)" });
    expect(t[1]).toMatchObject({ tone: "fail", summary: "timed out: exceeded 3600s" });
    expect(statsOf(t).problems).toBe(2);
  });
  it("ends with where a held job is stopped and why", () => {
    id = 0;
    const t = buildTimeline(detail([ex("FINAL_VALIDATION", "failed", 0, 30, { error: "FR-004 has no test" })], [], [], job({ stage: "NEEDS_ATTENTION", status: "waiting", heldFromStage: "FINAL_VALIDATION", lastError: "remediation attempts exhausted (3): FR-004 has no test" })));
    expect(t.at(-1)).toMatchObject({ title: "Needs your attention", tone: "wait", nodeId: "fval", summary: "remediation attempts exhausted (3): FR-004 has no test" });
  });
  it("summarises outputs sensibly, and says nothing rather than guess at output that was cut short", () => {
    expect(summarise({ passes: 2, files: 5, workflow: "feature" })).toBe("2 implementation passes · 5 files changed · feature workflow");
    expect(summarise({ findings: [] })).toBe("no findings");
    expect(summarise(null)).toBeUndefined();
    id = 0;
    const t = buildTimeline(detail([ex("CLAUDE_REVIEW", "succeeded", 0, 10, { output: '{"details":{"findings":[{"id":"a","issue":"very long…' })]));
    expect(t[0]!.summary).toBeUndefined();
  });
  it("a human answer shows the held-at line and the answer, not the (possibly long) questions; old one-line rows still work", () => {
    const questions = Array.from({ length: 20 }, (_, i) => `${i + 1}. Which port should the service listen on, and why that one?`).join("\n");
    const text = decisionText({ kind: "human.answer", decision: `answered while held at REQUIREMENTS_ANALYSIS\n\n${questions}`, rationale: "Use port 7777" });
    expect(text).toBe("answered while held at Requirements — Use port 7777");
    expect(decisionText({ kind: "human.answer", decision: "answered while held at BLOCKED", rationale: "yes" })).toBe("answered while held at Blocked — yes");
    expect(decisionText({ kind: "remediation", decision: "a\nb", rationale: null })).toBe("a\nb"); // other kinds are untouched
  });
});

<<<<<<< HEAD
describe("decisions after a standalone entry", () => {
  it("attach to the step that was running, not to an earlier 'You retried' entry that has no end", () => {
    id = 0;
    const impl = ex("IMPLEMENTATION", "succeeded", 100, 400);
    const t = buildTimeline(detail([ex("DISCOVERED", "succeeded", 0, 1), impl], [dec("job.retry", "resume at IMPLEMENTATION", 50), dec("implementation.pass", "pass 1", 200), dec("implementation.pass", "pass 2", 300), dec("human.deferred", "T031", 350)]));
    const retried = t.find((e) => e.title === "You retried")!;
    expect(retried.events).toHaveLength(0);
    const step = t.find((e) => e.stage === "IMPLEMENTATION")!;
    expect(step.events.map((e) => e.label)).toEqual(["Implementation pass", "Implementation pass", "Left for you"]);
  });
});

=======
describe("a step that waits and is re-checked", () => {
  const wait = (stage: string, i: number, reason: string) => ex(stage, "waiting", i * 600, i * 600 + 1, { output: JSON.stringify({ reason, delayMs: 600_000 }) });
  it("is one entry however many times it was checked, saying how many checks and when the last one was", () => {
    id = 0;
    const waits = Array.from({ length: 14 }, (_, i) => wait("MERGING", i + 1, "awaiting a human to merge https://github.com/o/r/pull/3"));
    const t = buildTimeline(detail([ex("PULL_REQUEST_CREATION", "succeeded", 0, 5), ...waits], [], [], job({ stage: "MERGING", status: "queued" })));
    const merging = t.filter((e) => e.stage === "MERGING");
    expect(merging).toHaveLength(1);
    expect(merging[0]).toMatchObject({ tone: "wait", checks: 14, run: 1, title: "Awaiting your merge" });
    expect(merging[0]!.summary).toBe("awaiting a human to merge https://github.com/o/r/pull/3 · checked 14 times");
    expect(merging[0]!.at).toBe(T0 + 600 * 1000);                  // since the first check
    expect(merging[0]!.lastCheckAt).toBe(T0 + 14 * 600 * 1000 + 1000);
  });
  it("ends as one finished entry when the wait is over, still saying it waited", () => {
    id = 0;
    const t = buildTimeline(detail([wait("CI_VALIDATION", 1, "CI pending: build"), wait("CI_VALIDATION", 2, "CI pending: build"), wait("CI_VALIDATION", 3, "CI pending: build"),
      ex("CI_VALIDATION", "succeeded", 2400, 2401, { output: JSON.stringify({ checks: [] }) })]));
    const ci = t.filter((e) => e.stage === "CI_VALIDATION");
    expect(ci).toHaveLength(1);
    expect(ci[0]).toMatchObject({ tone: "ok", run: 1 });
    expect(ci[0]!.checks).toBeUndefined();
    expect(ci[0]!.summary).toContain("after waiting, 3 checks");
  });
  it("keeps a later visit to the same step (after a fix) as its own entry", () => {
    id = 0;
    const t = buildTimeline(detail([wait("CI_VALIDATION", 1, "CI pending"), ex("CI_VALIDATION", "succeeded", 700, 701, { output: JSON.stringify({ remediate: "CI failed: build", details: {} }) }),
      ex("REMEDIATION", "succeeded", 702, 900), wait("CI_VALIDATION", 20, "CI pending"), wait("CI_VALIDATION", 21, "CI pending")]));
    const ci = t.filter((e) => e.stage === "CI_VALIDATION");
    expect(ci).toHaveLength(2);
    expect(ci.map((e) => e.run)).toEqual([1, 2]);
    expect(ci[1]).toMatchObject({ tone: "wait", checks: 2 });
  });
});
>>>>>>> origin/main
