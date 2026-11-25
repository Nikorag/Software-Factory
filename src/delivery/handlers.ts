import { readFileSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import type { StageHandler, StageResult } from "../core/engine.js";
import { artifacts, jobs, stageExecutions } from "../db/schema.js";
import { createStageKit, type StageKitDeps } from "../app/stage-kit.js";
import type { ProjectConfig } from "../config/schema.js";
import type { Hosts } from "../host/index.js";
import { GitHubError, type CheckInfo, type GitHubClient, type PrInfo } from "../github/client.js";
import { enqueueOutbox } from "../linear/outbox.js";
import { checkBranchProtection, createGhApi, parseRemote } from "../repo/inspect.js";
import { git as realGit, GitError, type GitFn } from "../repo/git.js";
import { pushBranch, PushRejected } from "../repo/push.js";
import { WorktreeError } from "../repo/worktrees.js";

export interface DeliveryTiming { ciPollMs: number; ciMaxMs: number; noCiGraceMs: number; mergePollMs: number; mergeMaxMs: number }
export const DEFAULT_TIMING: DeliveryTiming = { ciPollMs: 30_000, ciMaxMs: 60 * 60_000, noCiGraceMs: 3 * 60_000, mergePollMs: 10 * 60_000, mergeMaxMs: 14 * 24 * 3600_000 };

export interface DeliveryDeps extends StageKitDeps {
  dataDir: string;
  github: (project: ProjectConfig) => GitHubClient;
  /** Per-project host (GitHub or Bitbucket): repo slug, git credentials and branch protection. Absent = GitHub (as before). */
  hosts?: Hosts;
  push?: typeof pushBranch;
  timing?: Partial<DeliveryTiming>;
  now?: () => Date;
}

/** owner/name for gh: from config for managed clones, else from the checkout's origin remote. */
export async function repoSlug(project: ProjectConfig, git: GitFn = realGit): Promise<string> {
  if (project.host === "bitbucket") {
    if (project.bitbucket.repo) return project.bitbucket.repo;
    const bb = parseRemote(await git(project.repository, ["remote", "get-url", "origin"])).bitbucket;
    if (!bb) throw new Error(`cannot determine the Bitbucket repository for ${project.id} from its origin remote`);
    return `${bb.owner}/${bb.repo}`;
  }
  if (project.github.repo) return project.github.repo;
  const url = await git(project.repository, ["remote", "get-url", "origin"]);
  const gh = parseRemote(url).github;
  if (!gh) throw new Error(`cannot determine the GitHub repository for ${project.id} from its origin remote`);
  return `${gh.owner}/${gh.repo}`;
}

const FOOTER = (key: string, url: string) => `\n\n---\n**Raised by the Software Factory** for [${key}](${url}). It is **not** merged automatically: a human reviews and merges this PR.`;

/**
 * PULL_REQUEST_CREATION .. LINEAR_COMPLETION. Delivery mode is PR-ONLY by decision: the factory pushes the branch and
 * opens the pull request, watches CI, reports readiness, and then waits for a human to merge. There is deliberately no
 * merge operation anywhere in this module or in `GitHubClient`.
 */
export function createDeliveryHandlers(d: DeliveryDeps) {
  const git = d.git ?? realGit;
  const push = d.push ?? pushBranch;
  const now = d.now ?? (() => new Date());
  const t: DeliveryTiming = { ...DEFAULT_TIMING, ...d.timing };
  const { prepare, record } = createStageKit(d);

  /** How long this job has been in a stage, from its first attempt (waits create many attempts). */
  const waitedMs = (jobId: string, stage: string): number => {
    const first = d.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.stage, stage))).orderBy(asc(stageExecutions.id)).limit(1).get();
    return first ? now().getTime() - first.startedAt.getTime() : 0;
  };
  const ghStop = (e: unknown): StageResult | undefined => {
    if (e instanceof GitHubError) return e.retryable ? { kind: "retry", reason: `GitHub: ${e.message}` } : { kind: "needs_attention", reason: `GitHub refused the request: ${e.message}` };
    if (e instanceof WorktreeError) return { kind: "blocked", reason: e.message };
    return undefined;
  };
  const prOf = (jobId: string): number | undefined => {
    const url = d.db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.prUrl;
    const m = url ? /\/pull\/(\d+)/.exec(url) : null;
    return m ? Number(m[1]) : undefined;
  };

  const pullRequestCreation: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    try {
      const repo = await repoSlug(project, git);
      const gh = d.github(project);
      if ((await git(p.cwd, ["status", "--porcelain"])).length) return { kind: "needs_attention", reason: "refusing to push: the worktree has uncommitted changes" };
      await push(p.cwd, p.info.branch, { defaultBranch: project.defaultBranch, account: project.github.account, env: d.hosts && project.host === "bitbucket" ? await d.hosts.gitAuth(project) : undefined, git });
      const reportRow = d.db.select().from(artifacts).where(and(eq(artifacts.jobId, ctx.job.id), eq(artifacts.kind, "completion-report"))).orderBy(asc(artifacts.id)).all().at(-1);
      let report = "";
      try { report = reportRow ? readFileSync(reportRow.path, "utf8") : ""; } catch { /* the PR is still worth raising */ }
      const existing = await gh.findPr(repo, p.info.branch);
      if (existing && existing.state !== "OPEN") {
        return { kind: "needs_attention", reason: `A pull request for ${p.info.branch} already exists and is ${existing.state} (${existing.url}). The factory will not reopen or replace it.` };
      }
      let pr: PrInfo;
      if (existing) {
        pr = existing; // idempotent: a retry, or new commits after remediation
        await gh.commentOnPr(repo, pr.number, `Updated by the Software Factory (head ${p.info.branch}@${(await git(p.cwd, ["rev-parse", "--short", "HEAD"]))}).`);
      } else {
        pr = await gh.createPr(repo, { head: p.info.branch, base: project.defaultBranch, title: `${p.issue.identifier}: ${p.issue.title}`, body: `${report || `Implements ${p.issue.identifier}.`}${FOOTER(p.issue.identifier, p.issue.url)}` });
      }
      d.db.update(jobs).set({ prUrl: pr.url }).where(eq(jobs.id, ctx.job.id)).run();
      enqueueOutbox(d.db, ctx.job.id, p.issue.id, { kind: "link_pr", url: pr.url, title: `${p.issue.identifier}: ${p.issue.title}` }, `${ctx.job.id}:pr:link:${pr.number}`);
      enqueueOutbox(d.db, ctx.job.id, p.issue.id, { kind: "comment", body: `**Pull request raised:** ${pr.url}\n\nChecks run in a sandbox and passed; independent and final reviews approved. It is **not auto-merged**: please review and merge it.` }, `${ctx.job.id}:pr:comment:${pr.number}`);
      return { kind: "ok", output: { url: pr.url, number: pr.number, reused: Boolean(existing) } };
    } catch (e) {
      if (e instanceof PushRejected) return { kind: "needs_attention", reason: e.message };
      if (e instanceof GitError) return { kind: "retry", reason: e.message.replace(/AUTHORIZATION: basic \S+/gi, "AUTHORIZATION: [REDACTED]") };
      const s = ghStop(e);
      if (s) return s;
      throw e;
    }
  };

  const ciValidation: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    const number = prOf(ctx.job.id);
    if (!number) return { kind: "fail", reason: "no pull request recorded for this job" };
    try {
      const repo = await repoSlug(project, git);
      const gh = d.github(project);
      const checks = await gh.checks(repo, number);
      const waited = waitedMs(ctx.job.id, "CI_VALIDATION");
      if (checks.length === 0) {
        if (waited < t.noCiGraceMs) return { kind: "wait", reason: "no checks reported yet", delayMs: t.ciPollMs };
        record(ctx.job.id, "ci.none", "no CI checks reported for the PR", "the repository may have no workflow that runs on pull requests");
        return { kind: "ok", output: { checks: [], note: "no CI checks exist for this PR" } };
      }
      const pending = checks.filter((c) => c.bucket === "pending");
      const bad = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
      if (bad.length === 0 && pending.length > 0) {
        if (waited > t.ciMaxMs) return { kind: "needs_attention", reason: `CI is still pending after ${Math.round(t.ciMaxMs / 60_000)} minutes: ${pending.map((c) => c.name).join(", ")}` };
        return { kind: "wait", reason: `CI pending: ${pending.map((c) => c.name).join(", ")}`, delayMs: t.ciPollMs };
      }
      // Only GitHub Actions checks have logs the agent can read and a workflow it can fix. Anything else (Vercel, external CI,
      // deploy previews) is reported to the human, never looped on: remediation would burn every attempt on something it cannot see.
      const actionable = bad.filter((c) => /\/actions\/runs\/\d+/.test(c.link));
      const external = bad.filter((c) => !actionable.includes(c));
      if (actionable.length > 0) {
        const findings = [];
        for (const c of actionable) {
          const log = await gh.failedLog(repo, c);
          findings.push({ id: `ci:${c.workflow ? `${c.workflow}/` : ""}${c.name}`, severity: "blocker", file: c.workflow || c.name, line: null, issue: `CI check "${c.name}" ${c.bucket === "cancel" ? "was cancelled" : "failed"} (${c.link})${log ? `\n--- log tail ---\n${log}` : ""}`, fix: "Fix the cause so this check passes. Do not disable, skip or weaken the check." });
        }
        return { kind: "remediate", reason: `CI failed: ${actionable.map((c) => c.name).join(", ")}`, output: { findings, checks: summarise(checks), externalFailing: summarise(external) } };
      }
      if (external.length > 0) {
        const names = external.map((c) => `${c.workflow ? `${c.workflow}/` : ""}${c.name}`).join(", ");
        record(ctx.job.id, "ci.external-failing", names, "not a GitHub Actions check: the factory cannot read its log or fix it");
        enqueueOutbox(d.db, ctx.job.id, p.issue.id, { kind: "comment", body: `**Heads-up:** these checks are failing and the factory cannot act on them (they are not GitHub Actions runs): ${names}. Please look before merging.` }, `${ctx.job.id}:ci:external`);
        return { kind: "ok", output: { checks: summarise(checks), externalFailing: summarise(external) } };
      }
      return { kind: "ok", output: { checks: summarise(checks) } };
    } catch (e) {
      const s = ghStop(e);
      if (s) return s;
      throw e;
    }
  };
  const summarise = (cs: CheckInfo[]) => cs.map((c) => ({ name: c.name, workflow: c.workflow, bucket: c.bucket }));

  /** Informational: is the PR mergeable and what does GitHub enforce? It never blocks on a missing review, and never merges. */
  const mergeValidation: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    const number = prOf(ctx.job.id);
    if (!number) return { kind: "fail", reason: "no pull request recorded for this job" };
    try {
      const repo = await repoSlug(project, git);
      const pr = await d.github(project).getPr(repo, number);
      if (pr.state === "CLOSED") return { kind: "fail", reason: `The pull request was closed without merging (${pr.url}).` };
      if (pr.mergeable === "CONFLICTING") return { kind: "needs_attention", reason: `The pull request has merge conflicts with ${pr.baseRefName} (${pr.url}). A human must rebase or resolve them; the factory does not rewrite history.` };
      const [owner, name] = repo.split("/") as [string, string];
      const protection = d.hosts && project.host === "bitbucket" ? await d.hosts.protection(project, repo) : await checkBranchProtection({ owner, repo: name }, project.defaultBranch, createGhApi(project.github.account));
      const notes = [
        pr.reviewDecision ? `review: ${pr.reviewDecision}` : "no review decision yet",
        `mergeable: ${pr.mergeable}/${pr.mergeStateStatus}`,
        protection.status === "protected" ? `branch protection requires: ${protection.requiredChecks.join(", ") || "(no required checks)"}` : `branch protection: ${protection.status}`,
      ];
      enqueueOutbox(d.db, ctx.job.id, p.issue.id, { kind: "comment", body: `**Ready for human review and merge** (${pr.url}). ${notes.join("; ")}.` }, `${ctx.job.id}:merge-ready`);
      return { kind: "ok", output: { mode: "pr-only", ready: pr.mergeable !== "CONFLICTING", notes, protection: protection.status } };
    } catch (e) {
      const s = ghStop(e);
      if (s) return s;
      throw e;
    }
  };

  /** PR-only: this stage never merges. It waits until a human merges (or closes) the pull request. */
  const merging: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    const number = prOf(ctx.job.id);
    if (!number) return { kind: "fail", reason: "no pull request recorded for this job" };
    try {
      const repo = await repoSlug(project, git);
      const pr = await d.github(project).getPr(repo, number);
      if (pr.state === "MERGED") { record(ctx.job.id, "pr.merged", pr.url, `merged by a human at ${pr.mergedAt}`); return { kind: "ok", output: { merged: true, mergedAt: pr.mergedAt } }; }
      if (pr.state === "CLOSED") return { kind: "fail", reason: `The pull request was closed without merging (${pr.url}).` };
      if (waitedMs(ctx.job.id, "MERGING") > t.mergeMaxMs) return { kind: "needs_attention", reason: `The pull request has been open for ${Math.round(t.mergeMaxMs / 86_400_000)} days without being merged (${pr.url}).` };
      return { kind: "wait", reason: `awaiting a human to merge ${pr.url}`, delayMs: t.mergePollMs };
    } catch (e) {
      const s = ghStop(e);
      if (s) return s;
      throw e;
    }
  };

  /** After a human merged: tell Linear, then remove the finished worktree (preserved if it is somehow dirty). */
  const linearCompletion: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const url = d.db.select().from(jobs).where(eq(jobs.id, ctx.job.id)).get()?.prUrl;
    enqueueOutbox(d.db, ctx.job.id, p.issue.id, { kind: "comment", body: `**Merged.** ${url ?? ""}\n\nCompleted by the Software Factory after human review.` }, `${ctx.job.id}:completed`);
    try {
      await d.worktrees.remove(ctx.job.id, { deleteBranch: "force" }); // safe: the PR was verified merged in the previous stage
    } catch (e) {
      if (e instanceof WorktreeError && e.code === "dirty") record(ctx.job.id, "worktree.preserved", "dirty at cleanup");
      else throw e;
    }
    return { kind: "ok", output: { pr: url } };
  };

  return {
    PULL_REQUEST_CREATION: pullRequestCreation,
    CI_VALIDATION: ciValidation,
    MERGE_VALIDATION: mergeValidation,
    MERGING: merging,
    LINEAR_COMPLETION: linearCompletion,
  };
}
