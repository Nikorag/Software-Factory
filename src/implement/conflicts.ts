import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, count, eq } from "drizzle-orm";
import type { z } from "zod";
import type { StageHandler, StageResult } from "../core/engine.js";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs, worktrees } from "../db/schema.js";
import type { ProjectConfig } from "../config/schema.js";
import { GitHubError, type GitHubClient } from "../github/client.js";
import { git as realGit, GitError, type GitFn } from "../repo/git.js";
import { repoSlug } from "../delivery/handlers.js";
import { latestPlan } from "../planning/plan.js";
import { conflictPrompt } from "./prompts.js";
import { ConflictResolution } from "./schemas.js";
import type { AgentCall, AgentOutcome } from "../app/stage-kit.js";
import { createStageKit } from "../app/stage-kit.js";

export const DEFAULT_MAX_CONFLICT_RESOLUTIONS = 3;
const MIN = 60_000;
const MARKERS = /^(<<<<<<<|>>>>>>>)( |$)/m;

export interface ConflictDeps {
  db: FactoryDb;
  git: GitFn;
  project: (id: string) => ProjectConfig;
  github?: (project: ProjectConfig) => GitHubClient;
  /** Credentials for fetching from the project's remote (account-scoped; the global login is never switched). */
  fetchEnv?: (project: ProjectConfig) => Promise<NodeJS.ProcessEnv | undefined>;
  maxResolutions: () => number;
}

/** How many conflict resolutions this job has already attempted (each is a `conflict.attempt` decision, never reset). */
export const conflictAttempts = (db: FactoryDb, jobId: string): number =>
  db.select({ n: count() }).from(decisions).where(and(eq(decisions.jobId, jobId), eq(decisions.kind, "conflict.attempt"))).get()?.n ?? 0;

/**
 * CONFLICT_RESOLUTION: the PR cannot merge because the target branch moved. Fetch it, MERGE it into the job branch (never a rebase: that
 * would need a force-push, which is forbidden), let the implementer resolve the conflicting files from an understanding of both sides, and
 * commit the merge. Nothing is pushed here: the normal flow re-verifies everything (checks, reviews), pushes with the usual
 * non-forced push to the PR branch, and re-runs the PR checks. Bounded by `workflow.max_conflict_resolutions`; a genuine ambiguity
 * stops for a human with the specific question. The default branch is only ever read.
 */
export function createConflictHandler(d: ConflictDeps, kit: ReturnType<typeof createStageKit> & {
  implementer: <T extends z.ZodType>(ctx: Parameters<StageHandler>[0], call: AgentCall<T>, wt: string, base: string) => Promise<AgentOutcome<T>>;
  wrapperFor: (jobId: string, wt: string, commands: ProjectConfig["commands"], loopback: boolean) => Promise<{ path: string; checks: string[] }>;
  secretStop: (wt: string, base: string) => Promise<StageResult | undefined>;
  agentAccess?: (projectId: string) => "restricted" | "unrestricted";
}): StageHandler {
  const git = d.git ?? realGit;
  const { prepare, record } = kit;
  const ok = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);

  return async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    if (!d.github) return { kind: "needs_attention", reason: "merge-conflict resolution needs the pull request client, which is not configured" };
    const project = d.project(ctx.job.projectId);
    const prUrl = d.db.select().from(jobs).where(eq(jobs.id, ctx.job.id)).get()?.prUrl;
    const number = prUrl ? Number(/\/pull\/(\d+)/.exec(prUrl)?.[1]) : NaN;
    if (!Number.isFinite(number)) return { kind: "fail", reason: "no pull request recorded for this job" };
    if (!p.info.branch.startsWith("factory/") || p.info.branch === project.defaultBranch) return { kind: "needs_attention", reason: `refusing to merge into "${p.info.branch}": only factory/* branches are updated` };

    try {
      const repo = await repoSlug(project, git);
      const pr = await d.github(project).getPr(repo, number);
      if (pr.state === "CLOSED") return { kind: "fail", reason: `The pull request was closed without merging (${pr.url}).` };
      const base = pr.baseRefName || project.defaultBranch;
      const midMerge = await ok(p.cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]); // a crash or timeout left a merge half-resolved: continue it

      let upstream = "";
      if (!midMerge) {
        const attempt = conflictAttempts(d.db, ctx.job.id) + 1;
        const max = d.maxResolutions();
        if (attempt > max) return { kind: "needs_attention", reason: `The pull request has conflicted with ${base} again after ${max} automatic resolution(s) (${pr.url}). Resolve it by hand, or raise workflow.max_conflict_resolutions and retry the job.` };
        if ((await git(p.cwd, ["status", "--porcelain"])).length) return { kind: "needs_attention", reason: "refusing to merge: the worktree has uncommitted changes" };
        record(ctx.job.id, "conflict.attempt", `attempt ${attempt} of ${max}: merging ${base} into ${p.info.branch}`, `${pr.url} reports merge conflicts (${pr.mergeable}/${pr.mergeStateStatus})`);
        await git(p.cwd, ["fetch", "--quiet", "origin", base], { timeoutMs: 120_000, env: await d.fetchEnv?.(project) });
        upstream = (await git(p.cwd, ["rev-parse", "FETCH_HEAD"])).split("\n")[0]!.trim();
        if (await ok(p.cwd, ["merge-base", "--is-ancestor", upstream, "HEAD"])) {
          setBase(ctx.job.id, upstream);
          return { kind: "ok", output: { note: `the branch already contains ${base}`, upstream } };
        }
        try {
          await git(p.cwd, ["merge", "--no-edit", "-m", `Merge ${base} into ${p.info.branch}`, upstream], { timeoutMs: 120_000 });
          setBase(ctx.job.id, upstream); // merged cleanly: the target's changes are no longer "ours" in diffs and gates
          record(ctx.job.id, "conflict.resolved", `${base} merged without conflicts`, "git merged cleanly");
          return { kind: "ok", output: { merged: true, clean: true, upstream } };
        } catch (e) {
          if (!(e instanceof GitError) || !(await ok(p.cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]))) throw e; // not a conflict: a transient or real failure
        }
      } else {
        upstream = (await git(p.cwd, ["rev-parse", "MERGE_HEAD"])).trim();
      }

      const unmerged = async () => (await git(p.cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
      const files = await unmerged();
      const abort = () => git(p.cwd, ["merge", "--abort"]).catch(() => undefined);
      if (files.length > 0) {
        const { path: wrapper, checks } = await kit.wrapperFor(ctx.job.id, p.cwd, project.commands, project.allowLoopback);
        const r = await kit.implementer(ctx, {
          task: "implementation", role: "implementer", cwd: p.cwd, baseRef: upstream, timeoutMs: 40 * MIN, schema: ConflictResolution, bashAllow: [wrapper],
          prompt: conflictPrompt({ base, files, ticket: p.ticket, brief: latestPlan(d.db, ctx.job.id)?.prompt, wrapper, checks, unrestricted: kit.agentAccess?.(project.id) === "unrestricted" }),
        }, p.cwd, upstream);
        if (!r.ok) { await abort(); return r.stop; }
        const res = r.data!;
        if (!res.resolved) {
          await abort();
          record(ctx.job.id, "conflict.ambiguous", files.join(", "), res.ambiguity || res.summary);
          return { kind: "needs_attention", reason: `Merge conflicts with ${base} need a human decision (${pr.url}). Conflicting files: ${files.join(", ")}.\n\n${res.ambiguity || res.summary}\n\nThe branch was left unchanged (the merge was aborted). Resolve it on the branch, push, then retry the job.` };
        }
        record(ctx.job.id, "conflict.resolution", res.files.map((f) => f.path).join(", ") || files.join(", "), res.summary);
      }

      // Whatever the agent reports, verify: no unmerged paths, no markers, merge concluded, tree clean.
      const left = await unmerged();
      const marked = [...new Set([...files, ...left])].filter((f) => { try { return MARKERS.test(readFileSync(join(p.cwd, f), "utf8")); } catch { return false; } });
      if (left.length || marked.length) {
        await abort();
        return { kind: "retry", reason: `the conflicts were not fully resolved (${[...left, ...marked].join(", ")}); the merge was aborted and will be redone` };
      }
      if (await ok(p.cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) await git(p.cwd, ["commit", "--no-edit"]); // resolved and staged, not yet committed
      if ((await git(p.cwd, ["status", "--porcelain"])).length) {
        await abort();
        return { kind: "retry", reason: "the worktree was not clean after resolving the conflicts; the merge was aborted and will be redone" };
      }
      const leak = await kit.secretStop(p.cwd, upstream);
      if (leak) return leak;
      setBase(ctx.job.id, upstream);
      record(ctx.job.id, "conflict.resolved", `${base} merged into ${p.info.branch}; ${files.length} conflicting file(s) resolved`, files.join(", "));
      return { kind: "ok", output: { merged: true, files, upstream } };
    } catch (e) {
      if (e instanceof GitHubError) return e.retryable ? { kind: "retry", reason: `GitHub: ${e.message}` } : { kind: "needs_attention", reason: `GitHub refused the request: ${e.message}` };
      if (e instanceof GitError && /Authentication|authorization|could not read/i.test(e.message)) return { kind: "retry", reason: e.message.replace(/AUTHORIZATION: basic \S+/gi, "AUTHORIZATION: [REDACTED]") };
      throw e;
    }
  };

  /** The branch now contains the target as of `sha`: diffs, gates and the protected-path check must count only the job's own changes. */
  function setBase(jobId: string, sha: string): void {
    d.db.update(worktrees).set({ baseSha: sha }).where(eq(worktrees.jobId, jobId)).run();
  }
}
