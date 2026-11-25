import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs, linearOutbox, stageExecutions, worktrees } from "../src/db/schema.js";
import { sandboxAvailable } from "../src/exec/sandbox.js";
import { flushOutbox } from "../src/linear/outbox.js";
import { GitHubError } from "../src/github/client.js";
import { defaults, tickTasks, untick, write } from "./helpers/impl-agent.js";
import { recordDeferral } from "../src/implement/history.js";
import { check } from "./helpers/fake-github.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { sh } from "./helpers/git-fixture.js";
import { decisionKinds, harness, impl, job, type H } from "./helpers/impl-harness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Drive the engine like a scheduler would until a condition holds (waits re-queue with a short delay in tests). */
async function until(h: H, cond: () => boolean, ticks = 80) { for (let i = 0; i < ticks && !cond(); i++) { await h.engine.tick(); if (!cond()) await sleep(12); } }
const origin = (h: H) => join(h.repo, "..", "origin.git");
const flush = (h: H) => flushOutbox({ db: h.ctx.handle.db, client: h.linear, linear: h.ctx.config.linear, logger: h.ctx.logger, backoffBaseMs: 0 });
const stageOf = (h: H) => job(h).stage;
const FAST = { mergePollMs: 15 };

describe.skipIf(!sandboxAvailable())("PR-only delivery: push, open the PR, watch CI, wait for a human, complete", () => {
  it("raises the PR with the evidence report, never merges, and completes only after a human merges", async () => {
    const h = await harness({ timing: FAST });
    await until(h, () => stageOf(h) === "MERGING");
    // The branch really reached the (local bare) origin, with the implementation on it.
    expect(sh(origin(h), "branch", "--list", "factory/JAM-1")).toContain("factory/JAM-1");
    expect(sh(origin(h), "log", "--format=%s", "factory/JAM-1", "-1")).toBeTruthy();
    expect(sh(origin(h), "show", "factory/JAM-1:src/due.js")).toContain("isOverdue");
    expect(sh(origin(h), "branch", "--list", "main")).toContain("main"); // main untouched by the push
    // The PR
    expect(h.github.created).toHaveLength(1);
    const pr = h.github.created[0]!;
    expect(pr).toMatchObject({ repo: "Nikorag/todo", head: "factory/JAM-1", base: "main", title: "JAM-1: Optional due dates for todos" });
    expect(pr.body).toContain("Acceptance criteria"); expect(pr.body).toContain("MET FR-001"); expect(pr.body).toContain("PASS `test`");
    expect(pr.body).toMatch(/not\*\* merged automatically/);
    expect(job(h).prUrl).toBe("https://github.com/Nikorag/todo/pull/1");
    // Waiting for a human: more ticks change nothing and cost nothing
    const attemptsBefore = job(h).stageAttempts;
    for (let i = 0; i < 5; i++) { await h.engine.tick(); await sleep(20); }
    expect(h.github.prs[0]!.state).toBe("OPEN");
    expect(h.github.created).toHaveLength(1);
    expect(job(h)).toMatchObject({ stage: "MERGING", status: "queued", stageAttempts: attemptsBefore });
    expect(h.github.calls.filter((c) => /merge/i.test(c))).toEqual([]);
    // Linear: PR linked, comments queued, status "Ready for review"
    const ops = h.ctx.handle.db.select().from(linearOutbox).all();
    expect(ops.some((o) => o.kind === "link_pr" && o.payloadJson.includes("/pull/1"))).toBe(true);
    expect(ops.filter((o) => o.kind === "comment").map((o) => o.payloadJson).join()).toMatch(/not auto-merged|Ready for human review/);
    await flush(h);
    expect(h.linear.calls.some((c) => c.startsWith("linkPr:") && c.endsWith("/pull/1"))).toBe(true);
    expect(h.linear.issues.get(job(h).externalId)!.state.name).toBe("Ready for review");
    // A human merges in the GitHub UI -> the factory notices and completes
    h.github.humanMerges(1);
    await until(h, () => stageOf(h) === "COMPLETED");
    expect(job(h)).toMatchObject({ stage: "COMPLETED", status: "done" });
    expect(decisionKinds(h)).toContain("pr.merged");
    expect(existsSync(h.wt)).toBe(false); // finished worktree removed
    expect(sh(h.repo, "branch", "--list", "factory/JAM-1")).toBe(""); // local branch cleaned up
    await flush(h);
    expect(h.linear.issues.get(job(h).externalId)!.state.name).toBe("Done");
    expect(h.linear.issues.get(job(h).externalId)!.comments.map((c) => c.body).join("\n")).toMatch(/Merged/);
    expect(h.github.calls.filter((c) => /merge/i.test(c))).toEqual([]); // still: the factory never merged
  });

  it("STRUCTURAL GUARANTEE: there is no merge capability anywhere in the GitHub client or delivery code", () => {
    const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    for (const f of ["src/github/client.ts", "src/bitbucket/client.ts", "src/host/index.ts", "src/delivery/handlers.ts", "src/repo/push.ts"]) {
      const code = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/["']merge["']/);                 // `gh pr merge`
      expect(code, f).not.toMatch(/pulls\/\S*\/merge|enablePullRequestAutoMerge|mergePullRequest|--auto|--squash|--rebase/);
      expect(code, f).not.toMatch(/\bmergePr\b|\bmerge\s*\(/);
      expect(code, f).not.toMatch(/pullrequests\S*\/merge|\/merge["'`]|close_source_branch:\s*true/);   // Bitbucket: no merge endpoint, and never ask it to delete the source branch
    }
    const iface = src("src/github/client.ts").slice(src("src/github/client.ts").indexOf("export interface GitHubClient"), src("src/github/client.ts").indexOf("export class GitHubError"));
    expect(iface).not.toMatch(/merge/i);
    expect(readdirSync(join(process.cwd(), "src", "delivery"))).toEqual(["handlers.ts"]);
  });

  it("is idempotent: a retried PR stage reuses the open PR (and pushes new commits) instead of opening a second", async () => {
    const h = await harness({ timing: FAST });
    await until(h, () => stageOf(h) === "MERGING");
    h.ctx.handle.db.update(jobs).set({ stage: "PULL_REQUEST_CREATION", status: "queued", notBefore: null }).where(eq(jobs.id, h.jobId)).run();
    await until(h, () => stageOf(h) === "MERGING");
    expect(h.github.created).toHaveLength(1);
    expect(h.github.comments.some((c) => /Updated by the Software Factory/.test(c))).toBe(true);
  });
  it("lists human-only work in the PR body, and posts anything deferred later as one comment, once", async () => {
    const h = await harness({ timing: FAST });
    h.claude.b.implement = (cwd, dir) => { write(cwd, "src/due.js", "export function isOverdue(due, today) { return due < today; }\n"); write(cwd, "test/due.test.js", 'import test from "node:test";\ntest("x", () => {});\n'); tickTasks(cwd, dir); untick(cwd, dir, "T012", "[HUMAN]"); };
    await until(h, () => stageOf(h) === "MERGING");
    expect(h.github.created[0]!.body).toMatch(/## Needs human verification[\s\S]*\*\*T012\*\* Run the manual scenario/);
    expect(h.ctx.handle.db.select().from(linearOutbox).all().map((o) => o.payloadJson).join()).toMatch(/1 item\(s\) need human verification/);
    recordDeferral(h.ctx.handle.db, h.jobId, { id: "R3", severity: "major", file: "src/due.js", issue: "check the date picker on a phone" }, "needs a real device");
    for (let i = 0; i < 2; i++) { // a re-push after a fix cycle, then a plain retry of the same stage
      h.ctx.handle.db.update(jobs).set({ stage: "PULL_REQUEST_CREATION", status: "queued", notBefore: null }).where(eq(jobs.id, h.jobId)).run();
      await until(h, () => stageOf(h) === "MERGING");
    }
    const posted = h.github.comments.filter((c) => c.includes("Needs human verification"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("check the date picker on a phone");
    expect(posted[0]).not.toContain("T012"); // already in the body
  });
});

describe.skipIf(!sandboxAvailable())("CI", () => {
  it("waits while checks are pending (spending no retries) and proceeds when they pass", async () => {
    const gh = new FakeGitHub();
    gh.checkPolls = [[check("app", "pending")], [check("app", "pending")], [check("app", "pending")], [check("app", "pass"), check("sdk", "pass")]];
    const h = await harness({ github: gh, timing: FAST });
    await until(h, () => stageOf(h) === "MERGING");
    const waits = h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "CI_VALIDATION")).all();
    expect(waits.filter((r) => r.outcome === "waiting").length).toBeGreaterThanOrEqual(3);
    expect(waits.at(-1)!.outcome).toBe("succeeded");
    expect(waits.filter((r) => r.outcome === "failed")).toHaveLength(0);
  });
  it("needs attention if CI never finishes, instead of waiting forever", async () => {
    const gh = new FakeGitHub();
    gh.checkPolls = [[check("slow", "pending")]];
    const h = await harness({ github: gh, timing: { ciMaxMs: 60, ciPollMs: 5, ...FAST } });
    await until(h, () => stageOf(h) === "NEEDS_ATTENTION");
    expect(job(h).lastError).toMatch(/CI is still pending.*slow/);
  });
  it("a failing check goes to remediation with its log, the same agent session fixes it, the PR is updated, and CI re-runs", async () => {
    const gh = new FakeGitHub();
    gh.checkPolls = [[check("app", "fail")], [check("app", "pass")]];
    gh.logs.app = "FAIL: Error: snapshot mismatch in due.test.js (CI log tail)";
    const h = await harness({ github: gh, timing: FAST });
    h.claude.b.remediate = (cwd) => write(cwd, "src/due.js", "export function isOverdue(due, today) { return due < today; }\n// fixed for CI\n");
    await until(h, () => stageOf(h) === "MERGING");
    const rem = impl(h).at(-1)!;
    expect(rem.prompt).toContain("ci:CI/app");
    expect(rem.prompt).toContain("snapshot mismatch in due.test.js");
    expect(rem.resumeSessionId).toBe("sess-impl");
    expect(job(h).remediationAttempts).toBe(1);
    expect(h.github.created).toHaveLength(1); // same PR
    expect(h.github.comments.some((c) => /Updated by the Software Factory/.test(c))).toBe(true);
    expect(sh(origin(h), "show", "factory/JAM-1:src/due.js")).toContain("fixed for CI"); // the fix was pushed
    expect(h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "CI_VALIDATION")).all().map((r) => r.outcome)).toEqual(["succeeded", "succeeded"]);
  });
  it("a failing EXTERNAL check (Vercel, not a GitHub Actions run) is reported to the human, never looped on (seen on Zonto-Hub PR #112)", async () => {
    const gh = new FakeGitHub();
    gh.checkPolls = [[check("app", "pass"), check("Vercel", "fail", "", "https://vercel.com/nikorag/zonto/abc")]];
    const h = await harness({ github: gh, timing: FAST });
    await until(h, () => stageOf(h) === "MERGING");
    expect(job(h).remediationAttempts).toBe(0);
    expect(h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "REMEDIATION")).all()).toHaveLength(0);
    expect(decisionKinds(h)).toContain("ci.external-failing");
    expect(h.ctx.handle.db.select().from(linearOutbox).all().map((o) => o.payloadJson).join()).toMatch(/failing and the factory cannot act on them.*Vercel/);
  });
  it("with both kinds failing, only the actionable GitHub Actions check is remediated", async () => {
    const gh = new FakeGitHub();
    gh.checkPolls = [[check("app", "fail"), check("Vercel", "fail", "", "https://vercel.com/x")], [check("app", "pass"), check("Vercel", "fail", "", "https://vercel.com/x")]];
    const h = await harness({ github: gh, timing: FAST });
    await until(h, () => stageOf(h) === "MERGING");
    const prompt = impl(h).at(-1)!.prompt;
    expect(prompt).toContain("ci:CI/app");
    expect(prompt).not.toContain("Vercel");
  });
  it("after a fix cycle re-pushes, the no-CI grace window and the CI time limit start again from the push (not the first CI run)", async () => {
    let skew = 0;
    const now = () => new Date(Date.now() + skew);
    const gh = new FakeGitHub();
    gh.checkPolls = [[check("app", "fail")], [], [], [check("app", "pass")]]; // the new head's checks are not registered at first
    gh.logs.app = "FAIL";
    const h = await harness({ github: gh, now, timing: { noCiGraceMs: 30_000, ciPollMs: 5, ciMaxMs: 60_000, ...FAST } });
    h.claude.b.remediate = (cwd) => { write(cwd, "src/due.js", "export function isOverdue(due, today) { return due < today; }\n// fixed for CI\n"); skew += 10 * 60_000; }; // the fix cycle takes 10 minutes
    await until(h, () => stageOf(h) === "MERGING" || stageOf(h) === "NEEDS_ATTENTION");
    expect(stageOf(h)).toBe("MERGING");
    expect(decisionKinds(h)).not.toContain("ci.none"); // before: 10 min > 3 min grace, so "no checks yet" was taken as "no CI exists"
    const ci = h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "CI_VALIDATION")).all();
    expect(ci.filter((r) => r.outcome === "waiting").length).toBeGreaterThanOrEqual(2);
    expect(ci.at(-1)!.outputJson).toContain('"bucket":"pass"');
  });
  it("a CI failure the implementer defers to a human (it needs a secret) is posted on the PR instead of being looped on", async () => {
    const gh = new FakeGitHub();
    gh.checkPolls = [[check("deploy", "fail")]];
    gh.logs.deploy = "Error: DEPLOY_TOKEN is not set";
    const h = await harness({ github: gh, timing: FAST });
    h.claude.b.remediation = () => ({ accepted: [], rejected: [], deferred: [{ id: "ci:CI/deploy", reason: "needs the DEPLOY_TOKEN repository secret, which only a maintainer can add" }], summary: "" });
    await until(h, () => ["MERGING", "NEEDS_ATTENTION", "FAILED"].includes(stageOf(h)));
    expect(stageOf(h)).toBe("MERGING");
    expect(job(h).remediationAttempts).toBe(1);
    expect(decisionKinds(h)).toContain("ci.deferred-failing");
    expect(h.github.comments.filter((c) => c.includes("Needs human verification"))).toHaveLength(1);
    expect(h.github.comments.join("\n")).toContain("DEPLOY_TOKEN repository secret");
  });
  it("a repository with no CI at all is not an error: the factory waits a grace period, records it, and carries on", async () => {
    // FakeGitHub default: no checks. Virtual clock: each reading is 1s later, so the 2.5s grace spans exactly three polls on any machine.
    const h = await harness({ timing: { noCiGraceMs: 2500, ciPollMs: 5, ...FAST }, clockStepMs: 1000 });
    await until(h, () => stageOf(h) === "MERGING");
    expect(decisionKinds(h)).toContain("ci.none");
    const rows = h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "CI_VALIDATION")).all();
    expect(rows.filter((r) => r.outcome === "waiting").length).toBeGreaterThanOrEqual(2);
    expect(rows.at(-1)!.outcome).toBe("succeeded");
  });
});

describe.skipIf(!sandboxAvailable())("what a human (or GitHub) can do to the PR", () => {
  it("closing the PR without merging fails the job with that reason and keeps the worktree", async () => {
    const h = await harness({ timing: FAST });
    await until(h, () => stageOf(h) === "MERGING");
    h.github.humanCloses(1);
    await until(h, () => stageOf(h) === "FAILED");
    expect(job(h).lastError).toMatch(/closed without merging/);
    expect(existsSync(h.wt)).toBe(true);
  });
  it("merge conflicts need a human: the factory does not rewrite history", async () => {
    const gh = new FakeGitHub(); gh.mergeable = "CONFLICTING";
    const h = await harness({ github: gh, timing: FAST });
    await until(h, () => stageOf(h) === "NEEDS_ATTENTION");
    expect(job(h).lastError).toMatch(/merge conflicts.*does not rewrite history/);
  });
  it("gives up waiting for a human after the configured time, instead of waiting forever", async () => {
    const h = await harness({ timing: { mergePollMs: 10, mergeMaxMs: 50 } });
    await until(h, () => stageOf(h) === "NEEDS_ATTENTION");
    expect(job(h).lastError).toMatch(/without being merged/);
  });
  it("refuses to push over someone else's commits (never force-pushes) and leaves the remote untouched", async () => {
    const h = await harness({ timing: FAST });
    // Someone pushed a different commit to factory/JAM-1 before the factory did.
    const other = join(h.repo, "..", "other");
    sh(join(h.repo, ".."), "clone", "-q", origin(h), other);
    sh(other, "checkout", "-q", "-b", "factory/JAM-1"); sh(other, "commit", "-q", "--allow-empty", "-m", "someone elses work"); sh(other, "push", "-q", "origin", "factory/JAM-1");
    const before = sh(origin(h), "rev-parse", "factory/JAM-1");
    await until(h, () => stageOf(h) === "NEEDS_ATTENTION");
    expect(job(h).lastError).toMatch(/never force-pushes/);
    expect(sh(origin(h), "rev-parse", "factory/JAM-1")).toBe(before);
    expect(h.github.created).toHaveLength(0);
  });
  it("will not reopen or replace a PR that already exists but is closed", async () => {
    const gh = new FakeGitHub();
    gh.prs.push({ number: 7, url: "https://github.com/Nikorag/todo/pull/7", title: "old", state: "CLOSED", isDraft: false, headRefName: "factory/JAM-1", headRefOid: "x", baseRefName: "main", mergedAt: null, mergeable: "UNKNOWN", mergeStateStatus: "", reviewDecision: "" });
    const h = await harness({ github: gh, timing: FAST });
    await until(h, () => stageOf(h) === "NEEDS_ATTENTION");
    expect(job(h).lastError).toMatch(/already exists and is CLOSED/);
    expect(gh.created).toHaveLength(0);
  });
  it("GitHub outages retry; refusals (auth, not found) stop for a human", async () => {
    const gh = new FakeGitHub();
    gh.failures.push({ method: "findPr", times: 1, error: new GitHubError("HTTP 503 service unavailable", true) });
    const h = await harness({ github: gh, timing: FAST });
    await until(h, () => ["MERGING", "FAILED", "NEEDS_ATTENTION"].includes(stageOf(h)), 400);
    expect(h.ctx.handle.db.select().from(stageExecutions).where(eq(stageExecutions.stage, "PULL_REQUEST_CREATION")).all().map((r) => r.outcome)).toContain("failed"); // the outage
    const gh2 = new FakeGitHub();
    gh2.failures.push({ method: "createPr", times: 9, error: new GitHubError("HTTP 403: Resource not accessible by personal access token", false) });
    const h2 = await harness({ github: gh2, timing: FAST });
    await until(h2, () => stageOf(h2) === "NEEDS_ATTENTION");
    expect(job(h2).lastError).toMatch(/GitHub refused the request.*403/);
  }, 60_000);
});

describe.skipIf(!sandboxAvailable())("dry run", () => {
  it("pushes nothing and opens no PR", async () => {
    const h = await harness({ timing: FAST });
    h.ctx.handle.db.update(jobs).set({ dryRun: true }).run();
    await h.engine.tick();
    expect(h.github.created).toHaveLength(0);
    expect(h.github.calls).toEqual([]);
    expect(sh(origin(h), "branch", "--list", "factory/JAM-1")).toBe("");
    expect(h.ctx.handle.db.select().from(worktrees).get()!.state).toBe("active");
  });
});

void defaults;
