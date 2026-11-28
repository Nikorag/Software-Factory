import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createContext } from "../src/app/context.js";
import { Engine } from "../src/core/engine.js";
import { retryJob } from "../src/core/jobs.js";
import { artifacts, decisions, jobs, stageExecutions } from "../src/db/schema.js";
import { SandboxUnavailable } from "../src/exec/commands.js";
import { sandboxAvailable } from "../src/exec/sandbox.js";
import { defaults, GOOD_SRC, GOOD_TEST, tickTasks, untick, write } from "./helpers/impl-agent.js";
import { exists } from "./helpers/scripted-agent.js";
import { sh } from "./helpers/git-fixture.js";
import { decisionKinds, harness, impl, job, type H } from "./helpers/impl-harness.js";

describe.skipIf(!sandboxAvailable())("implementation pipeline (real engine, git, sandboxed commands; scripted agents)", () => {
  let h: H;
  beforeEach(async () => { h = await harness(); });

  it("takes a committed spec to a tested, reviewed, final-validated implementation, a raised PR, and waits for a human", async () => {
    await h.engine.tick();
    expect(h.hist()).toEqual([
      "IMPLEMENTATION_PREPARATION:succeeded", "IMPLEMENTATION:succeeded", "AUTOMATED_TESTING:succeeded", "LOCAL_MODEL_REVIEW:succeeded",
      "CLAUDE_REVIEW:succeeded", "FINAL_VALIDATION:succeeded", "PULL_REQUEST_CREATION:succeeded", "CI_VALIDATION:succeeded", "MERGE_VALIDATION:succeeded",
      "MERGING:waiting", // PR-only: the factory raised the PR and now waits for a human to merge it
    ]);
    expect(job(h)).toMatchObject({ stage: "MERGING", status: "queued" });
    expect(existsSync(join(h.wt, "src/due.js"))).toBe(true);
    expect(sh(h.wt, "status", "--porcelain")).toBe("");
    expect(sh(h.wt, "log", "--format=%an|%s", "origin/main..HEAD").split("\n")).toEqual(expect.arrayContaining(["Software Factory|impl(JAM-1): pass 1"]));
    expect(sh(h.repo, "status", "--porcelain")).toBe(""); // the original checkout is untouched
  });
  it("records the agent's commentary in a successful agent step's output, and none for a step with no agent", async () => {
    await h.engine.tick();
    const out = (stage: string) => JSON.parse(h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, stage)).get()!.outputJson!);
    expect(typeof out("IMPLEMENTATION").commentary).toBe("string");
    expect(out("IMPLEMENTATION").commentary.length).toBeGreaterThan(0);
    expect(out("IMPLEMENTATION").commentary).toBe(out("IMPLEMENTATION").summary); // the implementer's, not the converge check's
    expect(out("IMPLEMENTATION").summary).toBeDefined(); // still recorded for the PR body
    expect(out("IMPLEMENTATION_PREPARATION").commentary).toBeUndefined();
  });
  it("ran the project's real checks in the sandbox (baseline, tests, final) and recorded the evidence", async () => {
    await h.engine.tick();
    const prep = JSON.parse(h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "IMPLEMENTATION_PREPARATION")).get()!.outputJson!);
    expect(prep.baseline.map((r: { kind: string; ok: boolean; sandboxed: boolean }) => [r.kind, r.ok, r.sandboxed])).toEqual([["lint", true, true], ["test", true, true]]);
    expect(decisionKinds(h)).toContain("baseline");
    const fin = JSON.parse(h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "FINAL_VALIDATION")).get()!.outputJson!);
    const art = h.ctx.handle.db.select().from(artifacts).where(eq(artifacts.kind, "completion-report")).get()!;
    const report = readFileSync(art.path, "utf8");
    expect(report).toContain("PASS `test`"); expect(report).toContain("MET FR-001"); expect(report).toContain("factory/JAM-1");
    expect(fin.report).toBe(art.path);
  });
  it("gives the implementer the sandboxed check tool and nothing that runs code directly", async () => {
    await h.engine.tick();
    const first = impl(h)[0]!;
    expect(first.profile).toBe("implementer");
    expect(first.bashAllow).toHaveLength(1);
    expect(first.bashAllow![0]).toMatch(/jobs\/.+\/factory-exec$/);
    expect(first.prompt).toContain(`${first.bashAllow![0]} test`);
    expect(first.prompt).toMatch(/refused/); expect(first.prompt).toMatch(/never delete, skip or weaken/i);
    expect(first.prompt).toContain('<ticket untrusted-data="true">'); // the ticket (and any human answers) reaches the implementer, fenced as data
    expect(first.prompt).toMatch(/\[HUMAN\]/);                       // and it is told how to defer work only a person can do
  });
  it("reviews with Haiku (read-only) and a different, default-model Claude for the final gate", async () => {
    await h.engine.tick();
    const review = h.claude.calls.find((c) => c.role === "qa-reviewer" && "verdict" in ((c.jsonSchema?.properties ?? {}) as object) && !("earlier" in ((c.jsonSchema?.properties ?? {}) as object)))!;
    expect(review).toMatchObject({ model: "haiku", profile: "read-only" });
    expect(review.prompt).toContain("```diff"); expect(review.prompt).toContain("src/due.js");
    expect(review.prompt).not.toContain("specs/jam-1"); // code only: spec artefacts are excluded from the diff
    expect(h.claude.calls.find((c) => c.role === "final-reviewer")).toMatchObject({ model: "default", profile: "read-only" });
    expect(h.claude.calls.some((c) => c.role === "security-reviewer")).toBe(false); // an ordinary change is not security-sensitive
  });
});

describe.skipIf(!sandboxAvailable())("preconditions", () => {
  it("blocks when the project has no test command: the factory will not implement or merge unverified work", async () => {
    const h = await harness({ commands: { lint: "node --check src/todos.js" } });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "IMPLEMENTATION_PREPARATION" });
    expect(job(h).lastError).toMatch(/No test command is configured/);
    expect(impl(h)).toHaveLength(0);
  });
  it("blocks when the default branch's own checks already fail (failures could not be attributed to the change)", async () => {
    const h = await harness({ baseTest: 'import test from "node:test";\ntest("already broken", () => { throw new Error("pre-existing failure"); });\n' });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "BLOCKED", heldFromStage: "IMPLEMENTATION_PREPARATION" });
    expect(job(h).lastError).toMatch(/already fail on main/);
    expect(job(h).lastError).toContain("pre-existing failure");
    expect(impl(h)).toHaveLength(0);
  });
  it("stops for a human, rather than run project code unconfined, when sandboxing is required but unavailable", async () => {
    const h = await harness();
    const e = new Engine({ db: h.ctx.handle.db, logger: pino({ level: "silent" }), config: h.ctx.config, backoffBaseMs: 0,
      handlers: createContext(h.ctx.config, { db: h.ctx.handle, logger: pino({ level: "silent" }), linear: h.linear, agents: { anthropic: h.claude, local: h.claude }, runCommand: async () => { throw new SandboxUnavailable(); } }).handlers });
    await e.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(job(h).lastError).toMatch(/sandbox-exec is not available/);
  });
  it("retries when the implementer finishes without changing any code", async () => {
    const h = await harness();
    h.claude.b.implement = () => {};
    await h.engine.tick();
    expect(h.hist()).toContain("IMPLEMENTATION:failed");
    expect(job(h).lastError).toMatch(/without changing any code/);
  });
});

const BUGGY_SRC = 'export function isOverdue(due, today) { return due <= today; }\n'; // wrongly treats "due today" as overdue

describe.skipIf(!sandboxAvailable())("remediation: failing checks are fed back, fixed, and re-verified", () => {
  it("a genuinely failing test (run for real in the sandbox) goes to remediation, the SAME session fixes it, and checks pass", async () => {
    const h = await harness();
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", BUGGY_SRC); write(cwd, "test/due.test.js", GOOD_TEST_FOR_BUG); tickTasks(cwd, dir); };
    h.claude.b.remediate = (cwd) => write(cwd, "src/due.js", GOOD_SRC);
    h.claude.b.remediation = () => ({ accepted: ["check:test"], rejected: [], summary: "fixed the off-by-one" });
    await h.engine.tick();
    expect(h.stages().slice(0, 7)).toEqual(["IMPLEMENTATION_PREPARATION", "IMPLEMENTATION", "AUTOMATED_TESTING", "REMEDIATION", "AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW"]);
    expect(job(h).remediationAttempts).toBe(1);
    const rem = impl(h)[1]!;
    expect(rem.prompt).toContain("check:test");
    expect(rem.prompt).toMatch(/not ok|today is not overdue/);       // the real failing output reached the agent
    expect(rem.resumeSessionId).toBe("sess-impl");                    // the implementer's own session is resumed
    expect(rem.bashAllow).toEqual(impl(h)[0]!.bashAllow);
    expect(sh(h.wt, "log", "--format=%s", "-1")).toMatch(/fix\(JAM-1\)|impl|spec/);
    expect(sh(h.wt, "log", "--format=%s", "origin/main..HEAD")).toContain("fix(JAM-1): address review findings");
  });
  it("condenses a long failure log with Haiku and gives the fixer the summary plus the log tail", async () => {
    const h = await harness();
    const noisy = `import test from "node:test";\ntest("noisy", () => { console.log("x".repeat(4000)); throw new Error("deep failure"); });\n`;
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "test/noisy.test.js", noisy); tickTasks(cwd, dir); };
    h.claude.b.classify = () => ({ summary: "SUMMARY-TEXT: the noisy test throws deliberately", failingTests: ["noisy"] });
    h.claude.b.remediate = (cwd) => write(cwd, "test/noisy.test.js", 'import test from "node:test";\ntest("noisy", () => {});\n');
    await h.engine.tick();
    const call = h.claude.calls.find((c) => c.role === "classifier")!;
    expect(call.model).toBe("haiku"); expect(call.profile).toBe("read-only");
    expect(impl(h)[1]!.prompt).toContain("SUMMARY-TEXT"); expect(impl(h)[1]!.prompt).toContain("deep failure");
    expect(h.stages()).toContain("FINAL_VALIDATION");
  });
  it("an independent (Haiku) blocker is remediated, then the review passes", async () => {
    const h = await harness();
    h.claude.b.codeReview = (n) => (n === 1 ? { verdict: "changes_required", findings: [{ id: "C1", severity: "blocker", file: "src/due.js", line: 1, issue: "wrong for equal dates", fix: "use <" }] } : { verdict: "approve", findings: [] });
    h.claude.b.remediate = (cwd) => write(cwd, "src/due.js", GOOD_SRC + "// equal dates are not overdue\n");
    h.claude.b.remediation = () => ({ accepted: ["C1"], rejected: [], summary: "fixed" });
    await h.engine.tick();
    expect(h.stages().slice(2, 9)).toEqual(["AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "REMEDIATION", "AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW", "FINAL_VALIDATION"]);
    expect(impl(h)[1]!.prompt).toContain("wrong for equal dates");
    expect(job(h).remediationAttempts).toBe(1);
  });
  it("records rejected findings with their reasons, and shows them to the final reviewer to challenge", async () => {
    const h = await harness();
    h.claude.b.codeReview = (n) => (n === 1 ? { verdict: "changes_required", findings: [{ id: "C9", severity: "major", file: "src/due.js", line: 1, issue: "missing null check", fix: "add" }] } : { verdict: "approve", findings: [] });
    h.claude.b.remediation = () => ({ accepted: [], rejected: [{ id: "C9", reason: "callers validate input per FR-003" }], summary: "rejected" });
    await h.engine.tick();
    expect(h.ctx.handle.db.select().from(decisions).where(eq(decisions.kind, "remediation.rejected")).get()).toMatchObject({ decision: "C9", rationale: "callers validate input per FR-003" });
    expect(h.claude.calls.find((c) => c.role === "final-reviewer")!.prompt).toContain("callers validate input per FR-003");
    expect(readFileSync(h.ctx.handle.db.select().from(artifacts).where(eq(artifacts.kind, "completion-report")).get()!.path, "utf8")).toContain("callers validate input per FR-003");
  });
  it("stops at NEEDS_ATTENTION after three failed remediation cycles instead of looping", async () => {
    const h = await harness();
    h.claude.b.finalReview = () => ({ verdict: "changes_required", criteria: [{ id: "FR-001", met: false, evidence: "no test for the edge case" }], findings: [] });
    h.claude.b.remediate = (cwd, _dir, n) => write(cwd, "src/due.js", `${GOOD_SRC}// attempt ${n}\n`); // real (if insufficient) fixes each cycle
    h.claude.b.remediation = () => ({ accepted: ["criterion:FR-001"], rejected: [], summary: "tried" });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION", remediationAttempts: 3 });
    expect(impl(h).filter((c) => c.resumeSessionId)).toHaveLength(3);
    expect(job(h).lastError).toMatch(/remediation attempts exhausted/);
  });
});

describe.skipIf(!sandboxAvailable())("final validation gates (deterministic, independent of any reviewer)", () => {
  const gateFinding = (h: H, id: string) => {
    const rows = h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "FINAL_VALIDATION")).all();
    return rows.some((r) => r.outputJson?.includes(`"gate:${id}"`));
  };
  it("catches tests that were skipped to make checks pass", async () => {
    const h = await harness();
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "test/due.test.js", GOOD_TEST + 'test.skip("hard case", () => { throw new Error("nope"); });\n'); tickTasks(cwd, dir); };
    h.claude.b.remediate = (cwd) => write(cwd, "test/due.test.js", GOOD_TEST);
    await h.engine.tick();
    expect(gateFinding(h, "test-weakening")).toBe(true);
    expect(h.stages()).toContain("REMEDIATION");
    expect(job(h).remediationAttempts).toBe(1);
  });
  it("catches deleted test files", async () => {
    const h = await harness();
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "test/due.test.js", GOOD_TEST); rmSync(join(cwd, "test/todos.test.js")); tickTasks(cwd, dir); };
    h.claude.b.remediate = (cwd) => write(cwd, "test/todos.test.js", 'import test from "node:test";\nimport assert from "node:assert";\nimport { list } from "../src/todos.js";\ntest("empty", () => assert.deepEqual(list(), []));\n');
    await h.engine.tick();
    expect(gateFinding(h, "test-deleted")).toBe(true);
  });
  it("catches unticked tasks and uncommitted leftovers", async () => {
    const h = await harness();
    h.claude.b.implement = (cwd) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "test/due.test.js", GOOD_TEST); }; // forgot to tick tasks
    await h.engine.tick();
    expect(gateFinding(h, "tasks-open")).toBe(true);
  });
  it("a remediation that breaks the build is caught by the factory's own re-run (never by trusting the agent) and fixed", async () => {
    const h = await harness();
    let finals = 0, fixes = 0;
    h.claude.b.finalReview = () => (++finals === 1 ? { verdict: "changes_required", criteria: [{ id: "FR-001", met: false, evidence: "x" }], findings: [] } : defaults().finalReview(2));
    h.claude.b.remediate = (cwd) => write(cwd, "src/due.js", ++fixes === 1 ? "export function isOverdue( {\n" : GOOD_SRC); // 1st "fix" breaks the build, 2nd repairs it
    await h.engine.tick();
    const testing = h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "AUTOMATED_TESTING")).all();
    expect(testing.some((r) => r.outputJson?.includes("check:test") || r.outputJson?.includes("check:lint"))).toBe(true); // the break was detected by a real run
    expect(job(h).remediationAttempts).toBe(2);
    expect(h.stages().slice(-5)).toEqual(["FINAL_VALIDATION", "PULL_REQUEST_CREATION", "CI_VALIDATION", "MERGE_VALIDATION", "MERGING"]);
  });
});

describe.skipIf(!sandboxAvailable())("secrets, protected paths and security: these stop for a human", () => {
  it("a committed secret stops the job immediately, even though a later commit could delete it (history is what ships)", async () => {
    const h = await harness();
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "test/due.test.js", GOOD_TEST); write(cwd, "src/cfg.js", "export const KEY = 'AKIAIOSFODNN7EXAMPLE';\n"); tickTasks(cwd, dir); };
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(job(h).lastError).toMatch(/possible secret was committed.*aws-access-key.*history/s);
    expect(job(h).lastError).not.toContain("AKIAIOSFODNN7");
    expect(h.stages()).not.toContain("AUTOMATED_TESTING"); // failed fast
    expect(exists(h.wt, "src/cfg.js")).toBe(true); // left for inspection
  });
  it("a secret added then removed in a later remediation commit is still caught", async () => {
    const h = await harness();
    h.claude.b.finalReview = (n) => (n === 1 ? { verdict: "changes_required", criteria: [{ id: "FR-001", met: false, evidence: "x" }], findings: [] } : defaults().finalReview(n));
    h.claude.b.remediate = (cwd) => write(cwd, "src/leak.js", "export const T = 'ghp_" + "a".repeat(36) + "';\n");
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(job(h).lastError).toMatch(/github-token/);
  });
  it("an implementer touching a protected path fails the run and needs attention", async () => {
    const h = await harness();
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "test/due.test.js", GOOD_TEST); write(cwd, ".github/workflows/ci.yml", "name: x\n"); tickTasks(cwd, dir); };
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(job(h).lastError).toMatch(/boundary violation.*\.github\/workflows\/ci\.yml/);
    expect(decisionKinds(h)).toContain("agent.violation");
  });
  it("a security-sensitive change gets a dedicated security review by Claude; a CRITICAL finding stops for a human, never remediated", async () => {
    const h = await harness();
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "src/runner.js", "import { execSync } from 'node:child_process';\nexport const run = (c) => execSync(c);\n"); write(cwd, "test/due.test.js", GOOD_TEST); tickTasks(cwd, dir); };
    h.claude.b.security = () => ({ findings: [{ id: "S1", severity: "critical", file: "src/runner.js", line: 2, issue: "shell injection via run(c)", exploit: "attacker-controlled c", fix: "use execFile with an args array" }] });
    await h.engine.tick();
    const sec = h.claude.calls.find((c) => c.role === "security-reviewer")!;
    expect(sec).toMatchObject({ model: "default", profile: "read-only" });
    expect(sec.prompt).toContain("src/runner.js");
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION", remediationAttempts: 0 });
    expect(job(h).lastError).toMatch(/Critical security finding.*src\/runner\.js:2.*shell injection/s);
    expect(h.stages()).not.toContain("REMEDIATION");
  });
  it("with no independent reviewer the review is skipped (no model call, a skip is recorded) but the security review still runs", async () => {
    const h = await harness({ noReviewer: true });
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "src/runner.js", "import { execSync } from 'node:child_process';\nexport const run = (c) => execSync(c);\n"); write(cwd, "test/due.test.js", GOOD_TEST); tickTasks(cwd, dir); };
    h.claude.b.security = () => ({ findings: [] });
    await h.engine.tick();
    expect(h.hist()).toContain("LOCAL_MODEL_REVIEW:succeeded");
    expect(decisionKinds(h)).toContain("review.skipped");
    expect(decisionKinds(h)).not.toContain("code-review.independent");
    expect(h.claude.calls.some((c) => c.role === "qa-reviewer" && c.model === "haiku")).toBe(false); // the independent reviewer was never called
    expect(h.claude.calls.some((c) => c.role === "security-reviewer")).toBe(true);
    expect(h.stages()).toContain("CLAUDE_REVIEW");
  });
  it("a HIGH security finding is remediated like any other blocking finding", async () => {
    const h = await harness();
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "src/auth.js", "export const ok = (u) => u === 'admin';\n"); write(cwd, "test/due.test.js", GOOD_TEST); tickTasks(cwd, dir); };
    let n = 0;
    h.claude.b.security = () => ({ findings: ++n === 1 ? [{ id: "S2", severity: "high", file: "src/auth.js", line: 1, issue: "hard-coded admin", exploit: "anyone named admin", fix: "check a real credential" }] : [] });
    await h.engine.tick();
    expect(job(h).remediationAttempts).toBe(1);
    expect(impl(h)[1]!.prompt).toContain("hard-coded admin");
  });
});

describe.skipIf(!sandboxAvailable())("completeness: converge loop", () => {
  it("runs another implementation pass (same session) when converge appends tasks, then finishes when converged", async () => {
    const h = await harness();
    h.claude.b.converge = (n) => (n === 1 ? { converged: false, appendedTasks: 2, summary: "edge cases untested" } : { converged: true, appendedTasks: 0, summary: "done" });
    await h.engine.tick();
    expect(impl(h).filter((c) => /speckit-implement/.test(c.prompt))).toHaveLength(2);
    expect(impl(h)[1]!.prompt).toContain("pass 2");
    expect(impl(h)[1]!.prompt).toContain("edge cases untested");
    expect(impl(h)[1]!.resumeSessionId).toBe("sess-impl");
    expect(decisionKinds(h)).toContain("implementation.pass");
    expect(h.stages()).toContain("FINAL_VALIDATION");
  });
  it("needs attention if the implementation never converges with the spec (bounded passes)", async () => {
    const h = await harness();
    h.claude.b.converge = () => ({ converged: false, appendedTasks: 1, summary: "still gaps" });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(job(h).lastError).toMatch(/did not converge.*3 passes/);
    expect(job(h).lastError).toMatch(/Implementation passes.*Settings.*retry/);                       // and says what to do about it
    expect(impl(h).filter((c) => /speckit-implement/.test(c.prompt))).toHaveLength(3);
  });
  it("the number of passes is a setting: a higher limit gets the extra passes, and a project's own limit beats the profile's", async () => {
    const wide = await harness({ passes: 5 });
    wide.claude.b.converge = () => ({ converged: false, appendedTasks: 1, summary: "still gaps" });
    await wide.engine.tick();
    expect(job(wide).lastError).toMatch(/after 5 passes/);
    expect(impl(wide).filter((c) => /speckit-implement/.test(c.prompt))).toHaveLength(5);
    const narrow = await harness({ passes: 8, projectPasses: 2 });
    narrow.claude.b.converge = () => ({ converged: false, appendedTasks: 1, summary: "still gaps" });
    await narrow.engine.tick();
    expect(job(narrow).lastError).toMatch(/after 2 passes/);
    expect(impl(narrow).filter((c) => /speckit-implement/.test(c.prompt))).toHaveLength(2);
  });
  it("converging on a later pass stops there, and retrying after raising the limit resumes instead of starting over", async () => {
    const h = await harness();
    let calls = 0;
    h.claude.b.converge = () => (++calls >= 5 ? { converged: true, appendedTasks: 0, summary: "done" } : { converged: false, appendedTasks: 1, summary: "gaps" });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION", heldFromStage: "IMPLEMENTATION" });   // 3 passes were not enough
    h.ctx.config.factory.maxImplementationPasses = 6;                                                    // the user raises it in Settings (applied live)
    retryJob(h.ctx.handle.db, h.jobId, "test");
    await h.engine.tick();
    expect(h.stages()).toContain("FINAL_VALIDATION");                                                    // it carried on and finished the work
  });
});

describe.skipIf(!sandboxAvailable())("dry run", () => {
  it("skips implementation and every stage that depends on it, and reports instead of failing", async () => {
    const h = await harness();
    h.ctx.handle.db.update(jobs).set({ dryRun: true }).run();
    await h.engine.tick();
    expect(h.claude.calls).toHaveLength(0);
    expect(existsSync(join(h.wt, "src/due.js"))).toBe(false);
    expect(h.stages().slice(0, 6)).toEqual(["IMPLEMENTATION_PREPARATION", "IMPLEMENTATION", "AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW", "FINAL_VALIDATION"]);
    expect(h.hist().slice(0, 6).every((x) => x.endsWith(":succeeded"))).toBe(true);
  });
});

const deferredIds = (h: H) => h.ctx.handle.db.select().from(decisions).where(eq(decisions.kind, "human.deferred")).all().map((d) => d.decision);
const implementPasses = (h: H) => impl(h).filter((c) => /speckit-implement/.test(c.prompt));
const remediations = (h: H) => impl(h).filter((c) => !/speckit-implement/.test(c.prompt));
/** A retry releases the job with a backoff; drive the engine the way the scheduler would. */
const settleAll = async (h: H) => { for (let i = 0; i < 6 && !["MERGING", "NEEDS_ATTENTION", "FAILED", "BLOCKED"].includes(job(h).stage); i++) await h.engine.tick(); };
const TO_PR = ["FINAL_VALIDATION", "PULL_REQUEST_CREATION", "CI_VALIDATION", "MERGE_VALIDATION", "MERGING"];

describe.skipIf(!sandboxAvailable())("work only a human can do is deferred to the PR, never looped on (JAM-414)", () => {
  const leaveManualTask = (h: H, tag = "") => { h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "test/due.test.js", GOOD_TEST); tickTasks(cwd, dir); untick(cwd, dir, "T012", tag); }; };

  it("JAM-414: an implementer that keeps rejecting gate:tasks-open for a manual walkthrough no longer loops to the cap", async () => {
    const h = await harness();
    leaveManualTask(h);
    h.claude.b.remediation = () => ({ accepted: [], rejected: [{ id: "gate:tasks-open", reason: "Same finding as before; out of scope for code changes." }], summary: "rejected" });
    await h.engine.tick();
    // Before: FINAL_VALIDATION -> REMEDIATION -> full test + review + final validation, three times, then NEEDS_ATTENTION.
    expect(job(h)).toMatchObject({ stage: "MERGING", remediationAttempts: 1 });
    expect(remediations(h)).toHaveLength(1);
    expect(h.stages().slice(-10)).toEqual(["FINAL_VALIDATION", "REMEDIATION", "AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW", ...TO_PR]);
    expect(decisionKinds(h)).toContain("code-review.reused");                      // nothing changed, so nothing was reviewed twice
    expect(h.claude.calls.filter((c) => c.role === "qa-reviewer")).toHaveLength(2); // one independent + one Claude review, not four
    expect(deferredIds(h)).toEqual(["T012"]);                                       // the dispute went to a human
    const body = h.github.created[0]!.body;
    expect(body).toContain("## Needs human verification");
    expect(body).toMatch(/\*\*T012\*\* Run the manual scenario in `quickstart.md`/);
  });
  it("a rejection that says only a person can do it is recorded as a deferral straight away", async () => {
    const h = await harness();
    leaveManualTask(h);
    h.claude.b.remediation = () => ({ accepted: [], rejected: [{ id: "gate:tasks-open", reason: "T012 is a manual quickstart walkthrough in a real terminal" }], summary: "" });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "MERGING", remediationAttempts: 1 });
    expect(deferredIds(h)).toEqual(["T012"]);
    expect(h.ctx.handle.db.select().from(decisions).where(eq(decisions.kind, "remediation.rejected")).all()).toHaveLength(0);
    expect(h.github.created[0]!.body).toContain("manual quickstart walkthrough");
  });
  it("an implementer that defers the task explicitly (the new outlet) goes straight on", async () => {
    const h = await harness();
    leaveManualTask(h);
    h.claude.b.remediation = () => ({ accepted: [], rejected: [], deferred: [{ id: "T012", reason: "needs someone to run quickstart.md by hand" }], summary: "" });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "MERGING", remediationAttempts: 1 });
    expect(remediations(h)[0]!.prompt).toMatch(/defer/i);
    expect(h.github.created[0]!.body).toContain("needs someone to run quickstart.md by hand");
  });
  it("a task the spec tagged [HUMAN] never blocks: no fix cycle at all, and it is listed on the PR", async () => {
    const h = await harness();
    leaveManualTask(h, "[HUMAN]");
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "MERGING", remediationAttempts: 0 });
    expect(h.stages()).not.toContain("REMEDIATION");
    expect(h.github.created[0]!.body).toMatch(/\*\*T012\*\* Run the manual scenario/);
  });
  it("hard gates can never be deferred: a deferral of a failing check is refused and the job still has to fix it", async () => {
    const h = await harness();
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", BUGGY_SRC); write(cwd, "test/due.test.js", GOOD_TEST); tickTasks(cwd, dir); };
    let n = 0;
    h.claude.b.remediate = (cwd) => { if (++n === 2) write(cwd, "src/due.js", GOOD_SRC); else write(cwd, "src/note.js", `export const n = ${n};\n`); };
    h.claude.b.remediation = () => (n === 1 ? { accepted: [], rejected: [], deferred: [{ id: "check:test", reason: "a human should look" }], summary: "" } : { accepted: ["check:test"], rejected: [], summary: "fixed" });
    await h.engine.tick();
    expect(decisionKinds(h)).toContain("remediation.deferral-refused");
    expect(deferredIds(h)).toEqual([]);
    expect(job(h).remediationAttempts).toBe(2);
    expect(job(h).stage).toBe("MERGING");
  });
});

describe.skipIf(!sandboxAvailable())("reviewers remember earlier cycles", () => {
  it("the re-review is told what was raised, what was rejected and why, and what changed; Claude sees the real check results", async () => {
    const h = await harness();
    h.claude.b.codeReview = (n) => (n === 1 ? { verdict: "changes_required", findings: [{ id: "R1", severity: "major", file: "src/due.js", line: 1, issue: "missing null check on the due date", fix: "add" }] } : { verdict: "approve", findings: [] });
    h.claude.b.remediate = (cwd) => write(cwd, "src/due.js", GOOD_SRC + "// documented\n");
    h.claude.b.remediation = () => ({ accepted: [], rejected: [{ id: "R1", reason: "callers validate input per FR-003" }], summary: "" });
    await h.engine.tick();
    const reviews = h.claude.calls.filter((c) => c.role === "qa-reviewer" && !("earlier" in ((c.jsonSchema?.properties ?? {}) as object)));
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.prompt).not.toContain("Earlier review rounds");
    expect(reviews[1]!.prompt).toContain("Earlier review rounds");
    expect(reviews[1]!.prompt).toMatch(/R1 src\/due\.js: missing null check.*REJECTED.*callers validate input per FR-003/);
    expect(reviews[1]!.prompt).toMatch(/Code changed since the last review:[\s\S]*src\/due\.js/);
    expect(reviews[1]!.prompt).toMatch(/only for code that changed since the last review/);
    const claude = h.claude.calls.find((c) => c.role === "qa-reviewer" && "earlier" in ((c.jsonSchema?.properties ?? {}) as object))!;
    expect(claude.prompt).toMatch(/- test `node --test`: passed/);
    expect(claude.prompt).not.toMatch(/Check results:\n\(none\)/);
    expect(h.claude.calls.find((c) => c.role === "final-reviewer")!.prompt).toContain("callers validate input per FR-003");
  });
  it("a reviewer that re-raises a rejected finding about unchanged code (a new id each time) is deferred to the PR, not looped on", async () => {
    const h = await harness();
    // Seen live on JAM-414: Haiku's "R1" was a differently-worded nitpick each cycle. Here it is the same point under a new id.
    h.claude.b.codeReview = (n) => (n === 1
      ? { verdict: "changes_required", findings: [{ id: "R1", severity: "major", file: "src/due.js", line: 1, issue: "isOverdue does not validate the due date string", fix: "validate" }] }
      : { verdict: "changes_required", findings: [{ id: "R7", severity: "major", file: "src/due.js", line: 1, issue: "isOverdue does not validate the due date string format", fix: "validate" }] });
    h.claude.b.remediate = (cwd) => write(cwd, "test/extra.test.js", 'import test from "node:test";\ntest("x", () => {});\n');
    h.claude.b.remediation = () => ({ accepted: [], rejected: [{ id: "R1", reason: "inputs are validated by the caller (FR-003)" }, { id: "R7", reason: "inputs are validated by the caller (FR-003)" }], summary: "" });
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "MERGING", remediationAttempts: 1 });
    expect(deferredIds(h)).toEqual(["R7"]);
    expect(h.github.created[0]!.body).toMatch(/R7.*validate the due date string format[\s\S]*Disputed/);
  });
});

describe.skipIf(!sandboxAvailable())("no-progress detection", () => {
  it("the converge loop (job 9c1de607): a pass that changes nothing while converge appends nothing stops, and the gap goes to the PR", async () => {
    const h = await harness({ passes: 14 });
    h.claude.b.converge = () => ({ converged: false, appendedTasks: 0, summary: "drizzle/0007 migration missing: run drizzle-kit generate" });
    h.claude.b.implementResult = () => ({ summary: "done", tasksDone: [], tasksSkipped: [{ id: "T009", reason: "cannot run drizzle-kit: only the check tool may run" }], deferred: [] });
    await h.engine.tick();
    expect(implementPasses(h)).toHaveLength(2); // was 14
    const second = implementPasses(h)[1]!.prompt;
    expect(second).toContain("pass 2");
    expect(second).toContain("drizzle/0007 migration missing");
    expect(second).toMatch(/appended no new tasks/);
    expect(second).not.toMatch(/appended new tasks; do those/);
    const converge = h.claude.calls.filter((c) => c.role === "spec-writer");
    expect(converge[0]!.prompt).toContain("T009: cannot run drizzle-kit");      // the implementer's own blockers reach converge
    expect(decisionKinds(h)).toContain("implementation.no-progress");
    expect(deferredIds(h)).toEqual(["converge:gaps"]);
    expect(h.stages().slice(-5)).toEqual(TO_PR);
    expect(h.github.created[0]!.body).toContain("drizzle-kit generate");
  });
  it("gaps converge reports as human-only are deferred at once and the stage carries on", async () => {
    const h = await harness();
    h.claude.b.converge = () => ({ converged: false, appendedTasks: 0, summary: "only the visual check remains", deferred: [{ id: "T012", reason: "visual check in a real terminal" }] });
    await h.engine.tick();
    expect(implementPasses(h)).toHaveLength(1);
    expect(deferredIds(h)).toEqual(["T012"]);
    expect(h.stages()).toContain("FINAL_VALIDATION");
  });
  it("items the implementer defers while implementing are recorded and shown to converge", async () => {
    const h = await harness();
    h.claude.b.implementResult = () => ({ summary: "done", tasksDone: ["T001"], tasksSkipped: [], deferred: [{ id: "T012", reason: "manual scenario" }] });
    await h.engine.tick();
    expect(deferredIds(h)).toEqual(["T012"]);
    expect(h.claude.calls.find((c) => c.role === "spec-writer")!.prompt).toContain("T012: manual scenario");
  });
  it("a remediation that changes nothing and settles nothing retries that step (telling the agent why), not a whole cycle", async () => {
    const h = await harness();
    h.claude.b.codeReview = (n) => (n === 1 ? { verdict: "changes_required", findings: [{ id: "C1", severity: "blocker", file: "src/due.js", line: 1, issue: "wrong for equal dates", fix: "use <" }] } : { verdict: "approve", findings: [] });
    let n = 0;
    h.claude.b.remediate = (cwd) => { if (++n === 2) write(cwd, "src/due.js", GOOD_SRC + "// fixed\n"); };
    h.claude.b.remediation = () => ({ accepted: ["C1"], rejected: [], summary: "fixed" });
    await settleAll(h);
    expect(h.hist().filter((x) => x.startsWith("REMEDIATION"))).toEqual(["REMEDIATION:failed", "REMEDIATION:succeeded"]);
    expect(job(h).remediationAttempts).toBe(1);
    expect(remediations(h)[1]!.prompt).toMatch(/Earlier attempts at this step failed[\s\S]*changed nothing[\s\S]*made no commit/);
    expect(h.stages().filter((x) => x === "AUTOMATED_TESTING")).toHaveLength(2); // one cycle, not two
  });
});

describe.skipIf(!sandboxAvailable())("retries keep their context", () => {
  it("a retried IMPLEMENTATION resumes the implementer's session and is told why the last attempt failed", async () => {
    const h = await harness();
    let n = 0;
    h.claude.b.implement = (cwd, dir) => { if (++n > 1) defaults().implement(cwd, dir, n, undefined as never); };
    await settleAll(h);
    expect(implementPasses(h)).toHaveLength(2);
    expect(implementPasses(h)[0]!.resumeSessionId).toBeUndefined();
    expect(implementPasses(h)[1]!.resumeSessionId).toBe("sess-impl");
    expect(implementPasses(h)[1]!.prompt).toMatch(/Earlier attempts at this step failed[\s\S]*without changing any code/);
    expect(h.stages()).toContain("FINAL_VALIDATION");
  });
  it("REMEDIATION resumes the newest implementer session that has an id, even when the latest run failed without one", async () => {
    const h = await harness();
    h.claude.b.codeReview = (n) => (n === 1 ? { verdict: "changes_required", findings: [{ id: "C1", severity: "blocker", file: "src/due.js", line: 1, issue: "wrong", fix: "x" }] } : { verdict: "approve", findings: [] });
    h.claude.b.remediate = (cwd) => write(cwd, "src/due.js", GOOD_SRC + "// fixed\n");
    h.claude.b.remediation = () => ({ accepted: ["C1"], rejected: [], summary: "fixed" });
    let failed = false;
    h.claude.b.failure = (req) => (req.role === "implementer" && /Fix the findings/.test(req.prompt) && !failed ? ((failed = true), { failure: "transient", error: "overloaded" }) : undefined);
    await settleAll(h);
    const rem = remediations(h);
    expect(rem).toHaveLength(2);
    expect(rem[1]!.resumeSessionId).toBe("sess-impl");
    expect(rem[1]!.prompt).toMatch(/Earlier attempts at this step failed[\s\S]*overloaded/);
  });
  it("a session that can no longer be resumed falls back once to a fresh session that is told where things stand", async () => {
    const h = await harness();
    h.claude.b.codeReview = (n) => (n === 1 ? { verdict: "changes_required", findings: [{ id: "C1", severity: "blocker", file: "src/due.js", line: 1, issue: "wrong", fix: "x" }] } : { verdict: "approve", findings: [] });
    h.claude.b.remediate = (cwd) => write(cwd, "src/due.js", GOOD_SRC + "// fixed\n");
    h.claude.b.remediation = () => ({ accepted: ["C1"], rejected: [], summary: "fixed" });
    h.claude.b.failure = (req) => (req.resumeSessionId ? { failure: "error", error: "No conversation found with session ID: sess-impl" } : undefined);
    await h.engine.tick();
    const rem = remediations(h);
    expect(rem.map((c) => c.resumeSessionId)).toEqual(["sess-impl", undefined]);
    expect(rem[1]!.prompt).toMatch(/could not be resumed[\s\S]*impl\(JAM-1\): pass 1[\s\S]*Fix the findings/);
    expect(decisionKinds(h)).toContain("session.resume-failed");
    expect(h.hist()).not.toContain("REMEDIATION:failed");
  });
  it("human answers reach the implementer and the fixer, not only the spec writer", async () => {
    const h = await harness();
    h.ctx.handle.db.insert(decisions).values({ jobId: h.jobId, kind: "human.answer", decision: "answer", rationale: "ANSWER-42: dates are local time", actor: "human" }).run();
    h.claude.b.codeReview = (n) => (n === 1 ? { verdict: "changes_required", findings: [{ id: "C1", severity: "blocker", file: "src/due.js", line: 1, issue: "wrong", fix: "x" }] } : { verdict: "approve", findings: [] });
    h.claude.b.remediate = (cwd) => write(cwd, "src/due.js", GOOD_SRC + "// fixed\n");
    h.claude.b.remediation = () => ({ accepted: ["C1"], rejected: [], summary: "fixed" });
    await h.engine.tick();
    expect(implementPasses(h)[0]!.prompt).toContain("ANSWER-42: dates are local time");
    expect(remediations(h)[0]!.prompt).toContain("ANSWER-42: dates are local time");
  });
  it("a secret already in the branch history stops IMPLEMENTATION before any agent run is spent (job df39)", async () => {
    const h = await harness();
    write(h.wt, "src/cfg.js", "export const KEY = 'AKIAIOSFODNN7EXAMPLE';\n");
    sh(h.wt, "add", "-A"); sh(h.wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "earlier attempt");
    await h.engine.tick();
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(job(h).lastError).toMatch(/possible secret/);
    expect(impl(h)).toHaveLength(0);
  });
});

const GOOD_TEST_FOR_BUG = GOOD_TEST; // the correct test: it fails against BUGGY_SRC
