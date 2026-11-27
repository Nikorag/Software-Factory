import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { StageHandler, StageResult } from "../core/engine.js";
import { artifacts, decisions, jobs, stageExecutions } from "../db/schema.js";
import { createStageKit, type StageKitDeps } from "../app/stage-kit.js";
import type { ProjectConfig } from "../config/schema.js";
import type { Hosts } from "../host/index.js";
import { GitHubError, type CheckInfo, type GitHubClient, type PrInfo } from "../github/client.js";
import { enqueueOutbox } from "../linear/outbox.js";
import { checkBranchProtection, createGhApi, parseRemote } from "../repo/inspect.js";
import { git as realGit, GitError, type GitFn } from "../repo/git.js";
import { pushBranch, PushRejected } from "../repo/push.js";
import { WorktreeError } from "../repo/worktrees.js";
import { conflictAttempts, DEFAULT_MAX_CONFLICT_RESOLUTIONS } from "../implement/conflicts.js";
import { deferrals, openTasks, triage } from "../implement/history.js";
import { readSpecBundle } from "../speckit/artifacts.js";
import { addFeedback, applyingFeedback, asFinding, COMMANDS, dropOpenFeedback, feedbackFindingId, isTrusted, parseCommand, pendingFeedback, quote, setFeedbackStatus, type FeedbackRow } from "../core/feedback.js";

export interface DeliveryTiming { ciPollMs: number; ciMaxMs: number; noCiGraceMs: number; mergePollMs: number; mergeMaxMs: number }
// mergePollMs is also how quickly a `/software-factory` PR comment is noticed while the PR waits for a human (a request from the job page wakes the job at once).
export const DEFAULT_TIMING: DeliveryTiming = { ciPollMs: 30_000, ciMaxMs: 60 * 60_000, noCiGraceMs: 3 * 60_000, mergePollMs: 2 * 60_000, mergeMaxMs: 14 * 24 * 3600_000 };

export interface DeliveryDeps extends StageKitDeps {
  dataDir: string;
  github: (project: ProjectConfig) => GitHubClient;
  /** Per-project host (GitHub or Bitbucket): repo slug, git credentials and branch protection. Absent = GitHub (as before). */
  hosts?: Hosts;
  push?: typeof pushBranch;
  /** Automatic merge-conflict resolutions allowed per job (live), see `workflow.max_conflict_resolutions`. */
  maxConflictResolutions?: () => number;
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

/** One line per thing only a person can verify: deferrals recorded during the run, and tasks the spec tagged [HUMAN]. */
export function humanItems(o: { deferred: { id: string; what: string; reason: string }[]; tasksMd: string }): string[] {
  const items: string[] = [];
  const covered = new Set<string>();
  const tasks = openTasks(o.tasksMd);
  for (const x of o.deferred) {
    const task = tasks.find((t) => t.id === x.id);
    items.push(`- [ ] **${x.id}**${task ? ` ${task.text.replace(/\[HUMAN\b[^\]]*\]\s*/i, "")}` : `: ${x.what}`}${x.reason ? `\n  _Why a human:_ ${x.reason}` : ""}`);
    covered.add(x.id);
  }
  for (const t of tasks.filter((t) => t.human && !covered.has(t.id))) items.push(`- [ ] **${t.id}** ${t.text.replace(/\[HUMAN\b[^\]]*\]\s*/i, "")}`);
  return items;
}
const HUMAN_HEADING = "## Needs human verification\nThe factory runs autonomously until this PR and cannot do these itself (manual or visual checks, real devices or servers, or a disputed finding it would otherwise loop on). Please verify them before merging:";

/**
 * The plain-language opening of the PR body. Prefers the implementer's own summary; otherwise a deterministic line from the
 * ticket title and commit subjects. Never returns an empty heading.
 */
export function prSummary(o: { summary?: string | null; title: string; commits?: string[] }): string {
  const given = (o.summary ?? "").trim();
  if (given) return `## Summary\n${given}`;
  const subjects = (o.commits ?? []).map((c) => c.trim()).filter(Boolean);
  const title = o.title.trim();
  const line = [title ? `Implements: ${title}.` : "", subjects.length ? `Commits: ${subjects.join("; ")}.` : ""].filter(Boolean).join(" ");
  return line ? `## Summary\n${line}` : "";
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

  /**
   * How long this job has been in a stage since the branch was last pushed (waits create many attempts). Measured from the latest
   * PULL_REQUEST_CREATION, not the first attempt ever: after a fix cycle re-pushes, CI on the new head starts from zero, and the
   * grace window for "no checks yet" must not already be used up by the previous round.
   */
  const waitedMs = (jobId: string, stage: string): number => {
    const push = d.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.stage, "PULL_REQUEST_CREATION"), eq(stageExecutions.outcome, "succeeded"))).orderBy(desc(stageExecutions.id)).limit(1).get();
    const since = push ? (push.finishedAt ?? push.startedAt) : undefined;
    const first = d.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.stage, stage), ...(push ? [gt(stageExecutions.id, push.id)] : []))).orderBy(asc(stageExecutions.id)).limit(1).get();
    const from = since ?? first?.startedAt;
    return from ? now().getTime() - from.getTime() : 0;
  };

  /** Posts on the PR any human-verification items not posted before (each item once, recorded as a decision). */
  const postHumanItems = async (gh: GitHubClient, repo: string, number: number, jobId: string, items: string[]): Promise<number> => {
    const key = (i: string) => createHash("sha256").update(i).digest("hex").slice(0, 16);
    const posted = new Set(d.db.select().from(decisions).where(and(eq(decisions.jobId, jobId), eq(decisions.kind, "pr.human-items"))).all().map((r) => r.decision));
    const fresh = items.filter((i) => !posted.has(key(i)));
    if (fresh.length === 0) return 0;
    await gh.commentOnPr(repo, number, `${HUMAN_HEADING}\n${fresh.join("\n")}`);
    for (const i of fresh) record(jobId, "pr.human-items", key(i), i.split("\n")[0]);
    return fresh.length;
  };
  const markPosted = (jobId: string, items: string[]) => {
    for (const i of items) record(jobId, "pr.human-items", createHash("sha256").update(i).digest("hex").slice(0, 16), i.split("\n")[0]);
  };
  const itemsFor = (jobId: string, cwd: string, featureDir: string) => humanItems({ deferred: deferrals(d.db, jobId), tasksMd: readSpecBundle(cwd, featureDir).files["tasks.md"] ?? "" });
  const ghStop = (e: unknown): StageResult | undefined => {
    if (e instanceof GitHubError) return e.retryable ? { kind: "retry", reason: `GitHub: ${e.message}` } : { kind: "needs_attention", reason: `GitHub refused the request: ${e.message}` };
    if (e instanceof WorktreeError) return { kind: "blocked", reason: e.message };
    return undefined;
  };
  /**
   * The PR cannot merge: send the job to CONFLICT_RESOLUTION (Claude merges the target branch in and resolves the conflicts) instead of
   * stopping for a human. Bounded per job; past the bound, or when resolution finds a real ambiguity, a human is asked.
   */
  const conflictHop = (jobId: string, pr: PrInfo): StageResult => {
    const max = (d.maxConflictResolutions ?? (() => DEFAULT_MAX_CONFLICT_RESOLUTIONS))();
    const used = conflictAttempts(d.db, jobId);
    if (used >= max) return { kind: "needs_attention", reason: `The pull request has merge conflicts with ${pr.baseRefName} (${pr.url}) and ${used} automatic resolution(s) did not settle it. A human must resolve them (the factory never force-pushes).` };
    return { kind: "remediate", to: "CONFLICT_RESOLUTION", reason: `merge conflicts with ${pr.baseRefName} (${pr.url})`, output: { pr: pr.url, base: pr.baseRefName, attempt: used + 1, of: max } };
  };
  /**
   * Reads PR comments addressed to the factory into the feedback queue. Best-effort: trouble reading comments never stops delivery
   * (requests from the job page still work). Only repository collaborators can instruct the factory; anyone else gets one polite reply.
   */
  const collectComments = async (gh: GitHubClient, repo: string, number: number, jobId: string): Promise<void> => {
    let list;
    try { list = await gh.prComments(repo, number); } catch { return; }
    const reply = async (body: string) => { try { await gh.commentOnPr(repo, number, body); } catch { /* the request is still recorded */ } };
    for (const c of list) {
      const text = parseCommand(c.body);
      if (text === null) continue;
      const base = { source: "github" as const, author: c.author, externalId: c.id, path: c.path, line: c.line, url: c.url };
      if (!isTrusted(c.association)) {
        if (addFeedback(d.db, jobId, { ...base, body: text || c.body, status: "ignored", note: `@${c.author} cannot instruct the factory (${c.association.toLowerCase()}, not a collaborator)` })) {
          record(jobId, "feedback.untrusted", `ignored a ${COMMANDS[0]} comment by @${c.author}`, `author_association ${c.association}: only owners, members and collaborators can instruct the factory`);
          await reply(`@${c.author} only people with write access to this repository can instruct the Software Factory, so this request was not acted on. A maintainer can repeat it.`);
        }
        continue;
      }
      if (!text) {
        if (addFeedback(d.db, jobId, { ...base, body: c.body, status: "ignored", note: "no instruction after the command" })) await reply(`@${c.author} tell the factory what to change, for example:\n\n\`${COMMANDS[0]} rename the helper to formatDueDate and add a test for it\``);
        continue;
      }
      const row = addFeedback(d.db, jobId, { ...base, body: text });
      if (row) record(jobId, "feedback.requested", `PR comment by @${c.author} (#${row.id})`, text.slice(0, 1500));
    }
  };

  /**
   * Requests from the job page or PR comments send the job back through REMEDIATION (then tests, reviews and a push to this same PR).
   * Requests already sent but never pushed (the run failed and was retried) go again. Not a fix cycle: a person asked for it.
   */
  const feedbackHop = async (gh: GitHubClient, repo: string, number: number, jobId: string): Promise<StageResult | undefined> => {
    await collectComments(gh, repo, number, jobId);
    const fresh = pendingFeedback(d.db, jobId);
    const todo = [...applyingFeedback(d.db, jobId), ...fresh];
    if (todo.length === 0) return undefined;
    setFeedbackStatus(d.db, fresh.map((f) => f.id), "applying");
    if (fresh.length) {
      try { await gh.commentOnPr(repo, number, `**On it.** The Software Factory picked up ${fresh.length === 1 ? "this request" : `${fresh.length} requests`} and will push an update to this pull request:\n\n${fresh.map(quote).join("\n\n")}`); } catch { /* acknowledging is a courtesy */ }
    }
    const who = [...new Set(todo.map((f) => (f.source === "github" ? `@${f.author}` : "the job page")))].join(", ");
    return { kind: "remediate", to: "REMEDIATION", reason: `${todo.length} change request(s) from ${who}`, output: { findings: todo.map(asFinding), feedback: todo.map((f) => f.id) } };
  };

  /** What became of each request in the fix passes since it was sent: done, declined (with the implementer's reason) or left for a human. */
  const feedbackOutcomes = (jobId: string, rows: FeedbackRow[]): { lines: string[]; note: (id: number) => string; summary: string } => {
    const runs = d.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.stage, "REMEDIATION"), eq(stageExecutions.outcome, "succeeded"))).orderBy(desc(stageExecutions.id)).all()
      .map((r) => (r.outputJson ? JSON.parse(r.outputJson) : {}) as { rejected?: { id: string; reason: string }[]; deferred?: { id: string; reason: string }[]; summary?: string });
    const notes = new Map<number, string>();
    for (const f of rows) {
      const fid = feedbackFindingId(f.id);
      const rej = runs.map((r) => r.rejected?.find((x) => x.id === fid)).find(Boolean);
      const def = runs.map((r) => r.deferred?.find((x) => x.id === fid)).find(Boolean);
      notes.set(f.id, rej ? `Not changed: ${rej.reason}` : def ? `Left for a human: ${def.reason}` : "Done");
    }
    const lines = rows.map((f) => `${quote(f)}\n\n**${notes.get(f.id)!.startsWith("Done") ? "✓ " : ""}${notes.get(f.id)}**`);
    return { lines, note: (id) => notes.get(id) ?? "Done", summary: runs[0]?.summary ?? "" };
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
      const human = itemsFor(ctx.job.id, p.cwd, p.featureDir);
      let pr: PrInfo;
      if (existing) {
        pr = existing; // idempotent: a retry, or new commits after remediation
        const headRef = `${p.info.branch}@${(await git(p.cwd, ["rev-parse", "--short", "HEAD"]))}`;
        const applied = applyingFeedback(d.db, ctx.job.id);
        if (applied.length) {
          const o = feedbackOutcomes(ctx.job.id, applied);
          await gh.commentOnPr(repo, pr.number, `**Updated by the Software Factory** with the requested changes (head ${headRef}). Checks passed and the reviews approved again.\n\n${o.lines.join("\n\n")}${o.summary ? `\n\n_What changed:_ ${o.summary}` : ""}`);
          setFeedbackStatus(d.db, applied.map((f) => f.id), "done", o.note);
          record(ctx.job.id, "feedback.applied", `pushed ${applied.length} change request(s) to ${pr.url}`, applied.map((f) => `#${f.id}: ${o.note(f.id)}`).join("\n"));
        } else await gh.commentOnPr(repo, pr.number, `Updated by the Software Factory (head ${headRef}).`);
        await postHumanItems(gh, repo, pr.number, ctx.job.id, human);
      } else {
        const impl = d.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, ctx.job.id), eq(stageExecutions.stage, "IMPLEMENTATION"), eq(stageExecutions.outcome, "succeeded"))).orderBy(desc(stageExecutions.id)).limit(1).get();
        let implSummary: string | undefined;
        try { implSummary = impl?.outputJson ? (JSON.parse(impl.outputJson) as { summary?: string }).summary : undefined; } catch { /* fall back below */ }
        let commits: string[] = [];
        try { commits = (await git(p.cwd, ["log", "--format=%s", `${p.info.base}..HEAD`])).split("\n"); } catch { /* the title alone will do */ }
        const summary = prSummary({ summary: implSummary, title: p.issue.title, commits });
        const humanSection = human.length ? `\n\n${HUMAN_HEADING}\n${human.join("\n")}` : "";
        pr = await gh.createPr(repo, { head: p.info.branch, base: project.defaultBranch, title: `${p.issue.identifier}: ${p.issue.title}`, body: `${summary ? `${summary}\n\n` : ""}${report || `Implements ${p.issue.identifier}.`}${humanSection}${FOOTER(p.issue.identifier, p.issue.url)}` });
        markPosted(ctx.job.id, human);
      }
      d.db.update(jobs).set({ prUrl: pr.url }).where(eq(jobs.id, ctx.job.id)).run();
      enqueueOutbox(d.db, ctx.job.id, p.issue.id, { kind: "link_pr", url: pr.url, title: `${p.issue.identifier}: ${p.issue.title}` }, `${ctx.job.id}:pr:link:${pr.number}`);
      enqueueOutbox(d.db, ctx.job.id, p.issue.id, { kind: "comment", body: `**Pull request raised:** ${pr.url}\n\nChecks run in a sandbox and passed; independent and final reviews approved.${human.length ? ` ${human.length} item(s) need human verification (listed on the PR).` : ""} It is **not auto-merged**: please review and merge it.` }, `${ctx.job.id}:pr:comment:${pr.number}`);
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
      // GitHub does not run pull_request workflows while a PR conflicts, so look before waiting for checks that will never come.
      const current = await gh.getPr(repo, number);
      if (current.state === "OPEN" && current.mergeable === "CONFLICTING") return conflictHop(ctx.job.id, current);
      if (current.state === "OPEN") { const f = await feedbackHop(gh, repo, number, ctx.job.id); if (f) return f; }
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
      let deferredFailing: string[] = [];
      const external = bad.filter((c) => !actionable.includes(c));
      if (actionable.length > 0) {
        const findings = [];
        for (const c of actionable) {
          const log = await gh.failedLog(repo, c);
          findings.push({ id: `ci:${c.workflow ? `${c.workflow}/` : ""}${c.name}`, severity: "blocker", file: c.workflow || c.name, line: null, issue: `CI check "${c.name}" ${c.bucket === "cancel" ? "was cancelled" : "failed"} (${c.link})${log ? `\n--- log tail ---\n${log}` : ""}`, fix: "Fix the cause so this check passes. Do not disable, skip or weaken the check." });
        }
        // A CI failure the implementer deferred (it needs a person: a secret, a runner, an external service) is not looped on.
        const t = await triage({ db: d.db, jobId: ctx.job.id, cwd: p.cwd, git, findings });
        if (t.keep.length > 0) return { kind: "remediate", reason: `CI failed: ${t.keep.map((f) => f.id).join(", ")}`, output: { findings: t.keep, checks: summarise(checks), externalFailing: summarise(external), deferred: t.deferred } };
        await postHumanItems(gh, repo, number, ctx.job.id, itemsFor(ctx.job.id, p.cwd, p.featureDir));
        deferredFailing = [...t.deferred, ...t.settled].map((f) => f.id);
        record(ctx.job.id, "ci.deferred-failing", deferredFailing.join(", "), "deferred to a human on the PR: another fix cycle would only repeat itself");
      }
      if (external.length > 0) {
        const names = external.map((c) => `${c.workflow ? `${c.workflow}/` : ""}${c.name}`).join(", ");
        record(ctx.job.id, "ci.external-failing", names, "not a GitHub Actions check: the factory cannot read its log or fix it");
        enqueueOutbox(d.db, ctx.job.id, p.issue.id, { kind: "comment", body: `**Heads-up:** these checks are failing and the factory cannot act on them (they are not GitHub Actions runs): ${names}. Please look before merging.` }, `${ctx.job.id}:ci:external`);
        return { kind: "ok", output: { checks: summarise(checks), externalFailing: summarise(external), ...(deferredFailing.length ? { deferredFailing } : {}) } };
      }
      return { kind: "ok", output: { checks: summarise(checks), ...(deferredFailing.length ? { deferredFailing } : {}) } };
    } catch (e) {
      const s = ghStop(e);
      if (s) return s;
      throw e;
    }
  };
  const summarise = (cs: CheckInfo[]) => cs.map((c) => ({ name: c.name, workflow: c.workflow, bucket: c.bucket }));

  /** Informational: is the PR mergeable and what does GitHub enforce? It never blocks on a missing review, and never merges. Conflicts go to CONFLICT_RESOLUTION. */
  const mergeValidation: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    const number = prOf(ctx.job.id);
    if (!number) return { kind: "fail", reason: "no pull request recorded for this job" };
    try {
      const repo = await repoSlug(project, git);
      const gh = d.github(project);
      const pr = await gh.getPr(repo, number);
      if (pr.state === "CLOSED") { dropOpenFeedback(d.db, ctx.job.id, "the pull request was closed without merging"); return { kind: "fail", reason: `The pull request was closed without merging (${pr.url}).` }; }
      if (pr.mergeable === "CONFLICTING") return conflictHop(ctx.job.id, pr);
      if (pr.state === "OPEN") { const f = await feedbackHop(gh, repo, number, ctx.job.id); if (f) return f; }
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
      const gh = d.github(project);
      const pr = await gh.getPr(repo, number);
      if (pr.state === "MERGED") {
        record(ctx.job.id, "pr.merged", pr.url, `merged by a human at ${pr.mergedAt}`);
        const dropped = dropOpenFeedback(d.db, ctx.job.id, "the pull request was merged before this request was applied");
        if (dropped) record(ctx.job.id, "feedback.dropped", `${dropped} change request(s) not applied`, "the pull request was merged first");
        return { kind: "ok", output: { merged: true, mergedAt: pr.mergedAt } };
      }
      if (pr.state === "CLOSED") { dropOpenFeedback(d.db, ctx.job.id, "the pull request was closed without merging"); return { kind: "fail", reason: `The pull request was closed without merging (${pr.url}).` }; }
      if (pr.mergeable === "CONFLICTING") return conflictHop(ctx.job.id, pr); // the target moved while a human was deciding
      const f = await feedbackHop(gh, repo, number, ctx.job.id);
      if (f) return f;
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
