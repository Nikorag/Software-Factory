import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { artifacts, decisions, stageExecutions } from "../db/schema.js";
import { createHash } from "node:crypto";
import type { StageHandler, StageResult } from "../core/engine.js";
import { runProjectCommand, SandboxUnavailable, type CommandKind, type CommandResult } from "../exec/commands.js";
import { writeExecWrapper } from "../exec/factory-exec.js";
import { git as realGit } from "../repo/git.js";
import { createStageKit, type StageKitDeps } from "../app/stage-kit.js";
import { readSpecBundle, validateSpecArtifacts } from "../speckit/artifacts.js";
import { commitAll } from "../speckit/tools.js";
import { addedLines, changedFiles, codeDiff, historyAddedLines, NON_CODE } from "./diff.js";
import { claudeReviewPrompt, codeReviewPrompt, convergePrompt, extractCriteria, failureSummaryPrompt, finalReviewPrompt, implRemediationPrompt, implementPrompt, implementPromptDirect, securityReviewPrompt, specExcerpt } from "./prompts.js";
import { latestPlan, planExcerpt, type StoredPlan } from "../planning/plan.js";
import type { PlanningMode, ProjectConfig } from "../config/schema.js";
import { createConflictHandler, DEFAULT_MAX_CONFLICT_RESOLUTIONS } from "./conflicts.js";
import type { GitHubClient } from "../github/client.js";
import { ClaudeReview, CodeReview, Converge, DirectResult, FailureSummary, FinalReview, ImplRemediation, ImplementResult, SecurityReview } from "./schemas.js";
import { scanForSecrets } from "./secrets.js";
import { findProtectedChanges } from "../agents/guard.js";
import { deferrals, fixCycles, historyText, HUMAN_ONLY_REASON, isDeferrable, openTasks, previousFailures, recordDeferral, sameCodeRun, triage, type Finding } from "./history.js";
import type { AgentCall, AgentOutcome } from "../app/stage-kit.js";
import type { z } from "zod";

export interface ImplDeps extends StageKitDeps {
  dataDir: string;
  /** The profile's planning mode (live). `haiku_prompt`: the implementer works from the generated prompt and there is no spec to validate. Default: speckit. */
  planningMode?: () => PlanningMode;
  /** Pull request access, git fetch credentials and the retry bound for CONFLICT_RESOLUTION (the PR's merge conflicts, resolved by the implementer). */
  github?: (project: ProjectConfig) => GitHubClient;
  fetchEnv?: (project: ProjectConfig) => Promise<NodeJS.ProcessEnv | undefined>;
  maxConflictResolutions?: () => number;
  /** How many implement-and-converge rounds a project allows (live: read each stage). */
  maxPasses?: (projectId: string) => number;
  /** The project's agent access (live): decides whether prompts describe the check-tool-only limits. */
  agentAccess?: (projectId: string) => "restricted" | "unrestricted";
  settings: { protectedPaths: string[]; commandTimeoutSeconds: number; sandbox: { required: boolean; readAllow?: string[]; writeAllow?: string[] } };
  runCommand?: typeof runProjectCommand; // injectable for tests
}

const MIN = 60_000;
const CHECK_ORDER: Exclude<CommandKind, "install">[] = ["build", "typecheck", "lint", "test"];
const BLOCKING = new Set(["blocker", "major", "critical", "high"]);
export const isBlocking = (sev: string) => BLOCKING.has(sev);
const DEFAULT_PASSES = 3;
/** How Claude Code reports a `--resume` it cannot honour. */
const RESUME_FAILED = /no conversation found|session[^\n]{0,40}(not found|expired|does not exist)|(could not|unable to|failed to) resume/i;

/** Paths/keywords that make a change worth a dedicated security review. */
const SECURITY_PATHS = /(^|\/)(auth|crypto|security|session|login|password|token|secret|permission|acl|sandbox|exec|shell|sql|db|database|migrations?)\b|package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|Dockerfile|\.github\//i;
const SECURITY_CODE = /\b(child_process|exec(?:Sync)?|spawn|eval|new Function|innerHTML|dangerouslySetInnerHTML|crypto\.|jwt|bcrypt|password|Authorization|cookie|SELECT\s|INSERT\s|DELETE\s|process\.env|readFile|writeFile|fetch\()/;
export const isSecuritySensitive = (files: string[], diff: string): boolean => files.some((f) => SECURITY_PATHS.test(f)) || SECURITY_CODE.test(addedLines(diff).join("\n"));

/** Test-weakening patterns: a check "passes" because tests were removed or skipped. */
const WEAKENING = /(\.(skip|only|todo)\(|\bx(it|describe|test)\(|\bit\.skip\b|\b@pytest\.mark\.skip\b|#\[ignore\])/;

export function createImplementationHandlers(d: ImplDeps) {
  const git = d.git ?? realGit;
  const { prepare, agent, record, independent } = createStageKit(d);
  const exec = d.runCommand ?? runProjectCommand;
  const jobDir = (jobId: string) => join(d.dataDir, "jobs", jobId);
  const direct = () => d.planningMode?.() === "haiku_prompt";
  /** What reviewers measure the change against: the generated brief (haiku_prompt) or the specification (speckit). */
  const requirementsFor = (jobId: string, cwd: string, featureDir: string): string => {
    if (!direct()) return specExcerpt(readSpecBundle(cwd, featureDir));
    const plan = latestPlan(d.db, jobId);
    return plan ? planExcerpt(plan) : "";
  };
  const noPlan = (): StageResult => ({ kind: "blocked", reason: "There is no implementation prompt for this job (it was started in another planning mode). Retry the job from requirements analysis, or switch the profile's workflow.planning_mode back." });

  async function commonDir(wt: string): Promise<string> {
    const g = await git(wt, ["rev-parse", "--git-common-dir"]);
    return isAbsolute(g) ? g : resolve(wt, g);
  }

  /** Runs the project's configured checks in order inside the sandbox. A failed build stops the rest. */
  async function runChecks(ctx: { job: { id: string }; signal: AbortSignal }, wt: string, commands: Partial<Record<CommandKind, string>>, kinds: CommandKind[] = CHECK_ORDER, loopback = false): Promise<CommandResult[]> {
    const results: CommandResult[] = [];
    const gitCommonDir = await commonDir(wt);
    for (const kind of kinds) {
      const command = commands[kind];
      if (!command) continue;
      const r = await exec({
        kind, command, worktree: wt, timeoutMs: d.settings.commandTimeoutSeconds * 1000, signal: ctx.signal,
        logFile: join(d.dataDir, "logs", "commands", ctx.job.id, `${Date.now()}-${kind}.log`), profileDir: join(jobDir(ctx.job.id), "profiles"),
        sandbox: { ...d.settings.sandbox, gitCommonDir, loopback },
      });
      results.push(r);
      if (!r.ok && kind === "build") break;
    }
    return results;
  }
  const failed = (rs: CommandResult[]) => rs.filter((r) => !r.ok);
  const brief = (rs: CommandResult[]) => rs.map((r) => ({ kind: r.kind, command: r.command, ok: r.ok, exitCode: r.exitCode, seconds: Math.round(r.durationMs / 1000), sandboxed: r.sandboxed }));

  const sandboxStop = (e: unknown): StageResult | undefined =>
    e instanceof SandboxUnavailable ? { kind: "needs_attention", reason: e.message } : undefined;

  /** A secret anywhere in the branch's history cannot be fixed by another commit: it needs a human (and a history rewrite). */
  async function secretStop(wt: string, base: string): Promise<StageResult | undefined> {
    const hits = scanForSecrets(await historyAddedLines(wt, base, git));
    if (hits.length === 0) return undefined;
    return { kind: "needs_attention", reason: `A possible secret was committed on this branch (${[...new Set(hits.map((h) => h.rule))].join(", ")}). Removing it in a new commit would still leave it in history, so the branch must be rewritten or discarded by a human before anything is pushed. The worktree was left for inspection.` };
  }

  /** Latest blocking findings from the most recent stage that asked for remediation. */
  function latestFindings(jobId: string): unknown[] {
    const row = d.db.select().from(stageExecutions)
      .where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.outcome, "succeeded"), inArray(stageExecutions.stage, ["AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW", "FINAL_VALIDATION", "CI_VALIDATION", "MERGE_VALIDATION", "MERGING"])))
      .orderBy(desc(stageExecutions.id)).limit(1).get();
    const f = ((row?.outputJson ? JSON.parse(row.outputJson) : {}) as { details?: { findings?: { severity: string }[] } }).details?.findings ?? [];
    return f.filter((x) => isBlocking(x.severity));
  }

  const head = (wt: string) => git(wt, ["rev-parse", "HEAD"]);

  /** The latest AUTOMATED_TESTING results (an `ok` run stores them at the top, a `remediate` run under `details`). */
  function latestResults(jobId: string): { kind: string; ok: boolean; command: string }[] {
    const row = d.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.stage, "AUTOMATED_TESTING"), eq(stageExecutions.outcome, "succeeded"))).orderBy(desc(stageExecutions.id)).limit(1).get();
    const o = (row?.outputJson ? JSON.parse(row.outputJson) : {}) as { results?: { kind: string; ok: boolean; command: string }[]; details?: { results?: { kind: string; ok: boolean; command: string }[] } };
    return o.results ?? o.details?.results ?? [];
  }

  /** What reviewers are told about earlier fix cycles: findings, what happened to each, deferrals, and what changed since. */
  async function reviewHistory(jobId: string, wt: string): Promise<string> {
    const cycles = fixCycles(d.db, jobId);
    const last = cycles.at(-1)?.head;
    let stat = "";
    if (last) { try { stat = await git(wt, ["diff", "--stat", last, "HEAD", "--", ".", ...NON_CODE]); } catch { /* an unknown head: no incremental view */ } }
    return historyText(cycles, deferrals(d.db, jobId), stat);
  }

  /** The newest implementer session that actually has an id (a failed run may have none), so a retry continues the conversation. */
  function latestImplementerSession(jobId: string): string | undefined {
    const rows = d.db.query.agentInvocations.findMany({ where: (t, { and: a, eq: e, like }) => a(e(t.jobId, jobId), like(t.agent, "%/implementer")), orderBy: (t, { desc: de }) => de(t.id), limit: 50 }).sync();
    for (const r of rows) {
      try { const id = r.usageJson ? (JSON.parse(r.usageJson) as { sessionId?: string }).sessionId : undefined; if (id) return id; } catch { /* malformed usage: skip */ }
    }
    return undefined;
  }

  /**
   * Runs the implementer, resuming its session when there is one. A session that cannot be resumed (expired, not found) would
   * fail every retry the same way, so fall back once to a fresh session that is told where things stand.
   */
  async function implementer<T extends z.ZodType>(ctx: Parameters<StageHandler>[0], call: AgentCall<T>, wt: string, base: string): Promise<AgentOutcome<T>> {
    const r = await agent(ctx, call);
    if (r.ok || !call.resumeSessionId || r.stop.kind !== "retry" || !RESUME_FAILED.test(r.stop.reason)) return r;
    record(ctx.job.id, "session.resume-failed", `could not resume ${call.resumeSessionId}; starting a fresh session`, r.stop.reason);
    let commits = "";
    try { commits = await git(wt, ["log", "--format=%h %s", `${base}..HEAD`]); } catch { /* none yet */ }
    const summary = [
      "Your previous session on this job could not be resumed, so you are starting fresh in the same worktree and branch. Read the code (and tasks.md, if there is one) to pick up where it left off.",
      `Commits on this branch so far:\n${commits.trim().slice(0, 3000) || "(none)"}`,
      await reviewHistory(ctx.job.id, wt),
    ].filter(Boolean).join("\n\n");
    return agent(ctx, { ...call, resumeSessionId: undefined, prompt: `${summary}\n\n${call.prompt}` });
  }

  async function wrapperFor(jobId: string, wt: string, commands: Partial<Record<CommandKind, string>>, loopback = false): Promise<{ path: string; checks: string[] }> {
    const checks = CHECK_ORDER.filter((k) => commands[k]);
    const path = writeExecWrapper(jobDir(jobId), {
      worktree: wt, profileDir: join(jobDir(jobId), "profiles"), timeoutMs: d.settings.commandTimeoutSeconds * 1000,
      commands: Object.fromEntries(checks.map((k) => [k, commands[k]!])), sandbox: { ...d.settings.sandbox, gitCommonDir: await commonDir(wt), loopback },
    });
    return { path, checks };
  }

  const implementationPreparation: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    if (!project.commands.test) {
      return { kind: "blocked", reason: `No test command is configured for ${project.id}. The factory will not implement or merge without tests: set \`commands.test\` (and ideally lint/typecheck) in config/projects.yaml, then retry.` };
    }
    if (direct()) { if (!latestPlan(d.db, ctx.job.id)) return noPlan(); }
    else {
      const bad = validateSpecArtifacts(readSpecBundle(p.cwd, p.featureDir)).filter((c) => !c.ok);
      if (bad.length) return { kind: "blocked", reason: `The specification no longer validates: ${bad.map((c) => c.id).join(", ")}` };
    }
    try {
      if (project.commands.install) {
        const [inst] = await runChecks(ctx, p.cwd, { install: project.commands.install }, ["install"], project.allowLoopback);
        if (inst && !inst.ok) return { kind: "blocked", reason: `Dependency install failed (\`${inst.command}\`):\n${inst.tail.slice(-1500)}` };
      }
      // Baseline: the checks must pass on the untouched default branch, or failures could not be attributed to the change.
      const baseline = await runChecks(ctx, p.cwd, project.commands, CHECK_ORDER, project.allowLoopback);
      if (failed(baseline).length) {
        return { kind: "blocked", reason: `The project's own checks already fail on ${project.defaultBranch}, before any change (${failed(baseline).map((r) => r.kind).join(", ")}). Fix them first, then retry:\n${failed(baseline)[0]!.tail.slice(-1500)}` };
      }
      record(ctx.job.id, "baseline", `passed: ${baseline.map((r) => r.kind).join(", ")}`);
      return { kind: "ok", output: { baseline: brief(baseline), sandboxed: baseline.every((r) => r.sandboxed) } };
    } catch (e) {
      const s = sandboxStop(e);
      if (s) return s;
      throw e;
    }
  };

  /** haiku_prompt mode: one implementer run from the generated prompt. Verification, review and fix cycles are the stages that follow. */
  const implementDirect = async (ctx: Parameters<StageHandler>[0], p: Extract<Awaited<ReturnType<typeof prepare>>, { ok: true }>, plan: StoredPlan): Promise<StageResult> => {
    const project = d.project(ctx.job.projectId);
    const { path: wrapper, checks } = await wrapperFor(ctx.job.id, p.cwd, project.commands, project.allowLoopback);
    const r = await implementer(ctx, {
      task: "implementation", role: "implementer", cwd: p.cwd, baseRef: p.info.base, timeoutMs: 55 * MIN, schema: DirectResult, bashAllow: [wrapper], resumeSessionId: latestImplementerSession(ctx.job.id),
      prompt: implementPromptDirect({ plan, wrapper, checks, ticket: p.ticket, previousFailures: previousFailures(d.db, ctx.job.id, "IMPLEMENTATION"), unrestricted: d.agentAccess?.(project.id) === "unrestricted" }),
    }, p.cwd, p.info.base);
    if (!r.ok) return r.stop;
    await commitAll(p.cwd, `impl(${p.issue.identifier}): implement`, git);
    const leak = await secretStop(p.cwd, p.info.base);
    if (leak) return leak;
    if ((await changedFiles(p.cwd, p.info.base, { code: true }, git)).length === 0) return { kind: "retry", reason: "the implementer finished without changing any code" };
    for (const x of r.data!.deferred) recordDeferral(d.db, ctx.job.id, { id: x.id, severity: "minor", issue: x.id }, x.reason);
    record(ctx.job.id, "implementation.pass", `implemented from the generated prompt${r.data!.deferred.length ? `, ${r.data!.deferred.length} deferred to a human` : ""}`, r.data!.summary);
    return { kind: "ok", output: { passes: 1, summary: r.data!.summary, deferred: r.data!.deferred, files: (await changedFiles(p.cwd, p.info.base, { code: true }, git)).length } };
  };

  const implementation: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    // A secret already in the branch's history (an earlier, failed attempt) cannot be fixed by another agent run: stop first.
    const early = await secretStop(p.cwd, p.info.base);
    if (early) return early;
    if (direct()) {
      const plan = latestPlan(d.db, ctx.job.id);
      return plan ? implementDirect(ctx, p, plan) : noPlan();
    }
    const project = d.project(ctx.job.projectId);
    const { path: wrapper, checks } = await wrapperFor(ctx.job.id, p.cwd, project.commands, project.allowLoopback);
    let session = latestImplementerSession(ctx.job.id); // a retry continues the earlier conversation
    let gaps: { appended: number; summary: string } | undefined;
    const failures = previousFailures(d.db, ctx.job.id, "IMPLEMENTATION");
    const maxPasses = d.maxPasses?.(project.id) ?? DEFAULT_PASSES;
    for (let pass = 1; pass <= maxPasses; pass++) {
      const before = await head(p.cwd);
      const r = await implementer(ctx, {
        task: "implementation", role: "implementer", cwd: p.cwd, baseRef: p.info.base, timeoutMs: 55 * MIN, schema: ImplementResult, bashAllow: [wrapper], resumeSessionId: session,
        prompt: implementPrompt({ featureDir: p.featureDir, wrapper, checks, pass, gaps, ticket: p.ticket, previousFailures: pass === 1 ? failures : undefined, unrestricted: d.agentAccess?.(project.id) === "unrestricted" }),
      }, p.cwd, p.info.base);
      if (!r.ok) return r.stop;
      session = r.result.sessionId ?? session;
      await commitAll(p.cwd, `impl(${p.issue.identifier}): pass ${pass}`, git);
      const leak = await secretStop(p.cwd, p.info.base);
      if (leak) return leak;
      if ((await changedFiles(p.cwd, p.info.base, { code: true }, git)).length === 0) {
        return { kind: "retry", reason: "the implementer finished without changing any code" };
      }
      const changedThisPass = (await git(p.cwd, ["diff", "--name-only", before, "HEAD", "--", ".", ...NON_CODE])).trim().length > 0;
      for (const x of r.data!.deferred) recordDeferral(d.db, ctx.job.id, { id: x.id, severity: "minor", issue: x.id }, x.reason);
      const c = await agent(ctx, { task: "specification", role: "spec-writer", cwd: p.cwd, baseRef: p.info.base, timeoutMs: 15 * MIN, schema: Converge, prompt: convergePrompt(p.featureDir, { skipped: r.data!.tasksSkipped, deferred: r.data!.deferred }) });
      if (!c.ok) return c.stop;
      await commitAll(p.cwd, `impl(${p.issue.identifier}): converge pass ${pass}`, git);
      const cv = c.data!;
      for (const x of cv.deferred) recordDeferral(d.db, ctx.job.id, { id: x.id, severity: "minor", issue: x.id }, x.reason);
      record(ctx.job.id, "implementation.pass", `pass ${pass}: ${cv.converged ? "converged" : `${cv.appendedTasks} task(s) appended`}${cv.deferred.length ? `, ${cv.deferred.length} deferred to a human` : ""}${changedThisPass ? "" : ", no code change this pass"}`, cv.summary);
      const done = async (extra: Record<string, unknown> = {}): Promise<StageResult> => ({ kind: "ok", output: { passes: pass, summary: r.data!.summary, skipped: r.data!.tasksSkipped, deferred: cv.deferred, files: (await changedFiles(p.cwd, p.info.base, { code: true }, git)).length, ...extra } });
      if (cv.converged) return done();
      if (cv.appendedTasks === 0) {
        // Nothing new for the implementer to do. Gaps the converge step says only a human can close are deferred to the PR.
        if (cv.deferred.length) return done({ note: "remaining gaps deferred to a human" });
        // A pass that changed no code, after which nothing was appended, would only be repeated (live: 14 passes on a migration
        // the implementer cannot generate). Defer what is left to the PR and carry on: reviews and final validation still gate it.
        if (pass > 1 && !changedThisPass) {
          const why = [cv.summary, ...r.data!.tasksSkipped.map((t) => `${t.id}: ${t.reason}`)].filter(Boolean).join("; ");
          recordDeferral(d.db, ctx.job.id, { id: "converge:gaps", severity: "minor", issue: "Gaps the completeness check reported that the implementer could not close" }, why || "no reason given");
          record(ctx.job.id, "implementation.no-progress", `pass ${pass} changed no code and the completeness check appended no tasks; remaining gaps deferred to the PR`, why);
          return done({ note: "no progress: remaining gaps deferred to a human" });
        }
      }
      gaps = { appended: cv.appendedTasks, summary: cv.summary };
    }
    return { kind: "needs_attention", reason: `The implementation did not converge with the spec after ${maxPasses} passes; tasks remain. See the worktree and tasks.md. (Raise "Implementation passes" in Settings → Workflow, then retry the job: it resumes in the same worktree.)` };
  };

  const automatedTesting: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true, note: "no implementation exists in a dry run" } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    const at = await head(p.cwd);
    // A fix cycle that changed no code (findings rejected or deferred) cannot change the result of checks that already passed.
    const prev = await sameCodeRun({ db: d.db, jobId: ctx.job.id, stage: "AUTOMATED_TESTING", cwd: p.cwd, git });
    if (prev && !prev.remediated && Array.isArray(prev.results)) return { kind: "ok", output: { results: prev.results, head: at, reused: true } };
    let results: CommandResult[];
    try { results = await runChecks(ctx, p.cwd, project.commands, CHECK_ORDER, project.allowLoopback); } catch (e) { const s = sandboxStop(e); if (s) return s; throw e; }
    const bad = failed(results);
    if (bad.length === 0) return { kind: "ok", output: { results: brief(results), head: at } };
    const findings = [];
    for (const r of bad) {
      let issue = r.tail.slice(-2500);
      if (r.tail.length > 3000) { // a cheap model condenses long logs; failure to do so must never fail the stage
        const s = await agent(ctx, { task: "classification", role: "classifier", cwd: p.cwd, timeoutMs: 5 * MIN, schema: FailureSummary, prompt: failureSummaryPrompt(r.kind, r.command, r.tail) });
        if (s.ok) issue = `${s.data!.summary}\nFailing: ${s.data!.failingTests.join(", ") || "n/a"}\n--- log tail ---\n${r.tail.slice(-1200)}`;
      }
      findings.push({ id: `check:${r.kind}`, severity: "blocker", file: r.command, line: null, issue: `${r.timedOut ? "TIMED OUT. " : ""}${issue}`, fix: "Make this check pass. Never delete, skip or weaken tests to do so." });
    }
    return { kind: "remediate", reason: `${bad.map((r) => r.kind).join(", ")} failed`, output: { findings, results: brief(results), head: at } };
  };

  /** Drops settled findings and defers disputes that would only loop (see history.ts), returning what still blocks. */
  async function settle<F extends Finding>(jobId: string, wt: string, findings: F[]) {
    const t = await triage({ db: d.db, jobId, cwd: wt, git, findings });
    for (const f of t.deferred) record(jobId, "finding.deferred", `${f.id}: deferred to a human instead of another fix cycle`, f.reason);
    return { findings: t.keep, deferred: t.deferred, settled: t.settled.map((f) => f.id) };
  }

  /** The independent code review (Haiku by default), plus a security review when the change touches sensitive code. */
  const localModelReview: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true, note: "no implementation exists in a dry run" } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const diff = await codeDiff(p.cwd, p.info.base, 60_000, git);
    if (diff.files.length === 0) return { kind: "fail", reason: "there is no code change to review" };
    const at = await head(p.cwd);
    let findings: Finding[];
    let reviewer: string;
    const prev = await sameCodeRun({ db: d.db, jobId: ctx.job.id, stage: "LOCAL_MODEL_REVIEW", cwd: p.cwd, git });
    if (prev && Array.isArray(prev.findings)) {
      // The code has not changed since this review last ran: its findings stand, and what remediation did with them is in the history.
      findings = prev.findings as Finding[];
      reviewer = String(prev.reviewer ?? "previous review");
      record(ctx.job.id, "code-review.reused", "no code change since the last independent review; reusing its findings");
    } else {
      const prompt = codeReviewPrompt({ ticket: p.ticket, spec: requirementsFor(ctx.job.id, p.cwd, p.featureDir), stat: diff.stat, diff: diff.text, results: latestResults(ctx.job.id), history: await reviewHistory(ctx.job.id, p.cwd) });
      const r = await independent(ctx, (task) => agent(ctx, { task, role: "qa-reviewer", prompt, cwd: p.cwd, schema: CodeReview, timeoutMs: 15 * MIN }));
      if (!r.ok) return r.stop;
      findings = [...r.data.findings];
      reviewer = r.reviewer;
      record(ctx.job.id, "code-review.independent", `${r.data.verdict}: ${r.data.findings.length} finding(s)`, r.reviewer);
      if (isSecuritySensitive(diff.files, diff.text)) {
        const s = await agent(ctx, { task: "final_review", role: "security-reviewer", prompt: securityReviewPrompt(diff.text, diff.files), cwd: p.cwd, schema: SecurityReview, timeoutMs: 15 * MIN });
        if (!s.ok) return s.stop;
        const crit = s.data!.findings.filter((f) => f.severity === "critical");
        record(ctx.job.id, "security-review", `${s.data!.findings.length} finding(s), ${crit.length} critical`);
        if (crit.length) return { kind: "needs_attention", reason: `Critical security finding(s), a human must review before this can proceed:\n${crit.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""}: ${f.issue}`).join("\n")}` };
        findings.push(...s.data!.findings.map((f) => ({ id: `sec:${f.id}`, severity: f.severity === "high" ? "major" : f.severity === "medium" ? "minor" : "minor", file: f.file, line: f.line, issue: `[security/${f.severity}] ${f.issue}`, fix: f.fix })));
      }
    }
    const t = await settle(ctx.job.id, p.cwd, findings);
    const out = { findings, reviewer, head: at, deferred: t.deferred, settled: t.settled };
    const must = t.findings.filter((f) => isBlocking(f.severity));
    if (must.length) return { kind: "remediate", reason: `${must.length} blocking finding(s) in the independent code review`, output: { ...out, findings: t.findings } };
    return { kind: "ok", output: out };
  };

  const claudeReview: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true, note: "no implementation exists in a dry run" } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const at = await head(p.cwd);
    let findings: Finding[];
    const reused = await sameCodeRun({ db: d.db, jobId: ctx.job.id, stage: "CLAUDE_REVIEW", cwd: p.cwd, git });
    if (reused && Array.isArray(reused.findings)) {
      findings = reused.findings as Finding[];
      record(ctx.job.id, "code-review.reused", "no code change since the last Claude review; reusing its findings");
    } else {
      const diff = await codeDiff(p.cwd, p.info.base, 4000, git);
      const prev = d.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, ctx.job.id), eq(stageExecutions.stage, "LOCAL_MODEL_REVIEW"), eq(stageExecutions.outcome, "succeeded"))).orderBy(desc(stageExecutions.id)).limit(1).get();
      const earlier = ((prev?.outputJson ? JSON.parse(prev.outputJson) : {}) as { findings?: { id: string; severity: string; file: string; issue: string }[] }).findings ?? [];
      const r = await agent(ctx, {
        task: "final_review", role: "qa-reviewer", cwd: p.cwd, timeoutMs: 20 * MIN, schema: ClaudeReview,
        prompt: claudeReviewPrompt({ ticket: p.ticket, spec: requirementsFor(ctx.job.id, p.cwd, p.featureDir), stat: diff.stat, earlier, results: latestResults(ctx.job.id), base: p.info.base, history: await reviewHistory(ctx.job.id, p.cwd) }),
      });
      if (!r.ok) return r.stop;
      for (const e of r.data!.earlier) record(ctx.job.id, "code-review.verdict", `${e.id}: ${e.valid ? "valid" : "invalid"}`, e.evidence);
      findings = r.data!.findings;
    }
    const t = await settle(ctx.job.id, p.cwd, findings);
    const must = t.findings.filter((f) => isBlocking(f.severity));
    if (must.length) return { kind: "remediate", reason: `${must.length} blocking finding(s) in Claude's review`, output: { findings: t.findings, head: at, deferred: t.deferred, settled: t.settled } };
    return { kind: "ok", output: { findings, head: at, deferred: t.deferred, settled: t.settled } };
  };

  const remediation: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const findings = latestFindings(ctx.job.id) as Finding[];
    if (findings.length === 0) return { kind: "ok", output: { note: "no blocking findings to remediate" } };
    const early = await secretStop(p.cwd, p.info.base); // no agent run can fix a secret already in history
    if (early) return early;
    const project = d.project(ctx.job.projectId);
    const { path: wrapper, checks } = await wrapperFor(ctx.job.id, p.cwd, project.commands, project.allowLoopback);
    const before = await head(p.cwd);
    const r = await implementer(ctx, {
      task: "implementation", role: "implementer", cwd: p.cwd, baseRef: p.info.base, timeoutMs: 40 * MIN, schema: ImplRemediation, bashAllow: [wrapper], resumeSessionId: latestImplementerSession(ctx.job.id),
      prompt: implRemediationPrompt({ unrestricted: d.agentAccess?.(project.id) === "unrestricted", ...(direct() ? {} : { featureDir: p.featureDir }), wrapper, checks, findings, ticket: p.ticket, history: await reviewHistory(ctx.job.id, p.cwd), previousFailures: previousFailures(d.db, ctx.job.id, "REMEDIATION") }),
    }, p.cwd, p.info.base);
    if (!r.ok) return r.stop;
    const byId = (id: string) => findings.find((f) => f.id === id) ?? { id, severity: "minor", issue: id };
    // A "rejection" because only a person can do it is a deferral: it goes on the PR instead of being argued again next cycle.
    const asDeferral = r.data!.rejected.filter((x) => HUMAN_ONLY_REASON.test(x.reason) && isDeferrable(x.id));
    const rejected = r.data!.rejected.filter((x) => !asDeferral.includes(x));
    const deferred = [...r.data!.deferred.filter((x) => isDeferrable(x.id)), ...asDeferral];
    const refused = r.data!.deferred.filter((x) => !isDeferrable(x.id)).map((x) => x.id);
    for (const rej of rejected) record(ctx.job.id, "remediation.rejected", rej.id, rej.reason);
    for (const x of deferred) recordDeferral(d.db, ctx.job.id, byId(x.id), x.reason);
    if (refused.length) record(ctx.job.id, "remediation.deferral-refused", refused.join(", "), "failing checks, weakened tests, protected paths, a dirty tree and conflict markers cannot be deferred to a human");
    await commitAll(p.cwd, `fix(${p.issue.identifier}): address review findings`, git);
    const leak = await secretStop(p.cwd, p.info.base);
    if (leak) return leak;
    const after = await head(p.cwd);
    // Nothing changed and nothing was settled: another test-and-review cycle would see exactly the same thing. Retry this step,
    // which tells the implementer why (previousFailures), instead of spending a full fix cycle.
    if (after === before && rejected.length === 0 && deferred.length === 0) {
      return { kind: "retry", reason: `the implementer changed nothing and neither fixed, rejected nor deferred the findings (${findings.map((f) => f.id).join(", ")})${r.data!.accepted.length ? `; it reported ${r.data!.accepted.join(", ")} as fixed, but made no commit` : ""}` };
    }
    return { kind: "ok", output: { accepted: r.data!.accepted, rejected, deferred, refused, summary: r.data!.summary, head: after, changed: after !== before } };
  };

  const finalValidation: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true, note: "no implementation exists in a dry run" } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    const findings: { id: string; severity: string; file: string; line: number | null; issue: string; fix: string; tasks?: string[] }[] = [];
    const gate = (id: string, issue: string, file = "-", extra: { fix?: string; tasks?: string[] } = {}) => findings.push({ id: `gate:${id}`, severity: "blocker", file, line: null, issue, fix: extra.fix ?? "Fix this and keep all checks passing.", ...(extra.tasks ? { tasks: extra.tasks } : {}) });
    const at = await head(p.cwd);

    let results: CommandResult[];
    try { results = await runChecks(ctx, p.cwd, project.commands, CHECK_ORDER, project.allowLoopback); } catch (e) { const s = sandboxStop(e); if (s) return s; throw e; }
    for (const r of failed(results)) gate(`check-${r.kind}`, `${r.kind} fails: ${r.tail.slice(-800)}`, r.command);

    if ((await git(p.cwd, ["status", "--porcelain"])).length) gate("clean-tree", "the worktree has uncommitted changes");
    const touched = await findProtectedChanges(p.cwd, p.info.base, d.settings.protectedPaths, git);
    for (const f of touched) gate("protected-path", `protected path changed: ${f}`, f);
    const diff = await codeDiff(p.cwd, p.info.base, 1_000_000, git);
    if (diff.files.length === 0) gate("no-change", "the branch contains no code change");
    const leak = await secretStop(p.cwd, p.info.base);
    if (leak) return leak;
    if (/^(<<<<<<<|>>>>>>>) /m.test(diff.text)) gate("conflict-markers", "merge conflict markers are present");
    const weak = addedLines(diff.text).filter((l) => WEAKENING.test(l));
    if (weak.length) gate("test-weakening", `tests were skipped/disabled (${weak.length} line(s), e.g. \`${weak[0]!.trim().slice(0, 80)}\`)`);
    const deleted = (await git(p.cwd, ["diff", "--name-status", `${p.info.base}...HEAD`, "--", ".", ":(exclude)specs"])).split("\n").filter((l) => /^D\s+.*(test|spec)/i.test(l));
    if (deleted.length) gate("test-deleted", `test file(s) deleted: ${deleted.map((l) => l.split(/\s+/)[1]).join(", ")}`);
    // Tasks tagged [HUMAN], or deferred to a human during the run, are not open work for the agents: they go on the PR.
    const deferredIds = new Set(deferrals(d.db, ctx.job.id).map((x) => x.id));
    const open = direct() ? [] : openTasks(readSpecBundle(p.cwd, p.featureDir).files["tasks.md"] ?? "").filter((t) => !t.human && !deferredIds.has(t.id));
    if (open.length) {
      gate("tasks-open", `${open.length} task(s) in tasks.md are not ticked: ${open.map((t) => t.id).join(", ")}. If a task can only be done by a person (manual or visual testing, real devices), tag it [HUMAN] and defer it instead of rejecting this.`, `${p.featureDir}/tasks.md`,
        { tasks: open.map((t) => t.id), fix: "Do the open tasks and tick them; defer any that only a person can do." });
    }
    let t = await settle(ctx.job.id, p.cwd, findings);
    findings.splice(0, findings.length, ...t.findings);
    const deferred = [...t.deferred];

    if (findings.length === 0) {
      const criteria = direct() ? (latestPlan(d.db, ctx.job.id)?.criteria ?? []) : extractCriteria(readSpecBundle(p.cwd, p.featureDir).files["spec.md"] ?? "");
      const rejected = d.db.select().from(decisions).where(and(eq(decisions.jobId, ctx.job.id), eq(decisions.kind, "remediation.rejected"))).all().map((x) => `${x.decision}: ${x.rationale}`);
      type Review = z.infer<typeof FinalReview>;
      let review: Review;
      const prev = await sameCodeRun({ db: d.db, jobId: ctx.job.id, stage: "FINAL_VALIDATION", cwd: p.cwd, git });
      if (prev?.review) {
        review = prev.review as Review; // the final reviewer already judged this exact code; what remediation said about it is in the history
        record(ctx.job.id, "final-review.reused", "no code change since the last final review; reusing its verdict");
      } else {
        const r = await agent(ctx, {
          task: "final_review", role: "final-reviewer", cwd: p.cwd, timeoutMs: 25 * MIN, schema: FinalReview,
          prompt: finalReviewPrompt({ ticket: p.ticket, criteria, stat: diff.stat, results, base: p.info.base, decisions: rejected, history: await reviewHistory(ctx.job.id, p.cwd) }),
        });
        if (!r.ok) return r.stop;
        review = r.data!;
      }
      const unmet = review.criteria.filter((c) => !c.met);
      for (const c of unmet) findings.push({ id: `criterion:${c.id}`, severity: "blocker", file: "-", line: null, issue: `criterion ${c.id} not met: ${c.evidence}`, fix: "Implement it and add a test that fails without it." });
      findings.push(...review.findings.filter((f) => isBlocking(f.severity)));
      if (review.verdict === "changes_required" && findings.length === 0) findings.push({ id: "final:changes", severity: "blocker", file: "-", line: null, issue: "the final reviewer requested changes without specifics", fix: "Re-examine the criteria." });
      t = await settle(ctx.job.id, p.cwd, findings);
      findings.splice(0, findings.length, ...t.findings);
      deferred.push(...t.deferred);
      if (findings.length === 0) {
        const report = buildReport({ key: p.issue.identifier, title: p.issue.title, url: p.issue.url, branch: p.info.branch, base: p.info.base, stat: diff.stat, results, criteria: review.criteria, rejected, remediations: d.db.select().from(decisions).where(and(eq(decisions.jobId, ctx.job.id), eq(decisions.kind, "remediation"))).all().length, commits: await git(p.cwd, ["log", "--format=%h %s", `${p.info.base}..HEAD`]) });
        const file = join(d.dataDir, "reports", `${ctx.job.id}.md`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, report);
        d.db.insert(artifacts).values({ jobId: ctx.job.id, kind: "completion-report", path: file, sha256: createHash("sha256").update(report).digest("hex"), bytes: Buffer.byteLength(report) }).onConflictDoNothing().run();
        return { kind: "ok", output: { report: file, criteria: review.criteria.length, results: brief(results), head: at, review, deferred } };
      }
      return { kind: "remediate", reason: `${findings.length} blocking issue(s) at final validation`, output: { findings, results: brief(results), head: at, review, deferred } };
    }
    return { kind: "remediate", reason: `${findings.length} blocking issue(s) at final validation`, output: { findings, results: brief(results), head: at, deferred } };
  };

  const kit = createStageKit(d);
  const conflictResolution = createConflictHandler(
    { db: d.db, git, project: d.project, github: d.github, fetchEnv: d.fetchEnv, maxResolutions: d.maxConflictResolutions ?? (() => DEFAULT_MAX_CONFLICT_RESOLUTIONS) },
    { ...kit, implementer, wrapperFor, secretStop, ...(d.agentAccess ? { agentAccess: d.agentAccess } : {}) },
  );

  return {
    CONFLICT_RESOLUTION: conflictResolution,
    IMPLEMENTATION_PREPARATION: implementationPreparation,
    IMPLEMENTATION: implementation,
    AUTOMATED_TESTING: automatedTesting,
    LOCAL_MODEL_REVIEW: localModelReview,
    CLAUDE_REVIEW: claudeReview,
    REMEDIATION: remediation,
    FINAL_VALIDATION: finalValidation,
  };
}

export interface ReportInput {
  key: string; title: string; url: string; branch: string; base: string; stat: string; commits: string; remediations: number; rejected: string[];
  results: CommandResult[]; criteria: { id: string; met: boolean; evidence: string }[];
}

/** The evidence a human (or a PR description) needs to trust this change. */
export function buildReport(r: ReportInput): string {
  return [
    `# ${r.key}: ${r.title}`, `Ticket: ${r.url}`, `Branch: \`${r.branch}\` (base \`${r.base}\`), remediation cycles: ${r.remediations}`, "",
    "## Checks (re-run at final validation, sandboxed)", ...r.results.map((x) => `- ${x.ok ? "PASS" : "FAIL"} \`${x.kind}\` (\`${x.command}\`, ${Math.round(x.durationMs / 1000)}s)`), "",
    "## Acceptance criteria", ...r.criteria.map((c) => `- ${c.met ? "MET" : "UNMET"} ${c.id}: ${c.evidence}`), "",
    "## Changes", "```", r.stat.trim(), "```", "", "## Commits", "```", r.commits.trim(), "```", "",
    ...(r.rejected.length ? ["## Review findings the implementer rejected (with reasons)", ...r.rejected.map((x) => `- ${x}`), ""] : []),
  ].join("\n");
}
