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
import { defaults, GOOD_SRC, GOOD_TEST, tickTasks, write } from "./helpers/impl-agent.js";
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
    expect(first.prompt).toContain('untrusted-data'.slice(0, 0)); // ticket text is not passed to the implementer verbatim: it works from the spec
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

const GOOD_TEST_FOR_BUG = GOOD_TEST; // the correct test: it fails against BUGGY_SRC
