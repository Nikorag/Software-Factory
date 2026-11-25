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
import { addedLines, changedFiles, codeDiff, historyAddedLines } from "./diff.js";
import { claudeReviewPrompt, codeReviewPrompt, convergePrompt, extractCriteria, failureSummaryPrompt, finalReviewPrompt, implRemediationPrompt, implementPrompt, securityReviewPrompt, specExcerpt } from "./prompts.js";
import { ClaudeReview, CodeReview, Converge, FailureSummary, FinalReview, ImplementResult, SecurityReview } from "./schemas.js";
import { scanForSecrets } from "./secrets.js";
import { Remediation } from "../speckit/schemas.js";
import { findProtectedChanges } from "../agents/guard.js";

export interface ImplDeps extends StageKitDeps {
  dataDir: string;
  /** How many implement-and-converge rounds a project allows (live: read each stage). */
  maxPasses?: (projectId: string) => number;
  settings: { protectedPaths: string[]; commandTimeoutSeconds: number; sandbox: { required: boolean; readAllow?: string[]; writeAllow?: string[] } };
  runCommand?: typeof runProjectCommand; // injectable for tests
}

const MIN = 60_000;
const CHECK_ORDER: Exclude<CommandKind, "install">[] = ["build", "typecheck", "lint", "test"];
const BLOCKING = new Set(["blocker", "major", "critical", "high"]);
export const isBlocking = (sev: string) => BLOCKING.has(sev);
const DEFAULT_PASSES = 3;

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

  async function commonDir(wt: string): Promise<string> {
    const g = await git(wt, ["rev-parse", "--git-common-dir"]);
    return isAbsolute(g) ? g : resolve(wt, g);
  }

  /** Runs the project's configured checks in order inside the sandbox. A failed build stops the rest. */
  async function runChecks(ctx: { job: { id: string }; signal: AbortSignal }, wt: string, commands: Partial<Record<CommandKind, string>>, kinds: CommandKind[] = CHECK_ORDER): Promise<CommandResult[]> {
    const results: CommandResult[] = [];
    const gitCommonDir = await commonDir(wt);
    for (const kind of kinds) {
      const command = commands[kind];
      if (!command) continue;
      const r = await exec({
        kind, command, worktree: wt, timeoutMs: d.settings.commandTimeoutSeconds * 1000, signal: ctx.signal,
        logFile: join(d.dataDir, "logs", "commands", ctx.job.id, `${Date.now()}-${kind}.log`), profileDir: join(jobDir(ctx.job.id), "profiles"),
        sandbox: { ...d.settings.sandbox, gitCommonDir },
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
      .where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.outcome, "succeeded"), inArray(stageExecutions.stage, ["AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW", "FINAL_VALIDATION", "CI_VALIDATION"])))
      .orderBy(desc(stageExecutions.id)).limit(1).get();
    const f = ((row?.outputJson ? JSON.parse(row.outputJson) : {}) as { details?: { findings?: { severity: string }[] } }).details?.findings ?? [];
    return f.filter((x) => isBlocking(x.severity));
  }

  async function wrapperFor(jobId: string, wt: string, commands: Partial<Record<CommandKind, string>>): Promise<{ path: string; checks: string[] }> {
    const checks = CHECK_ORDER.filter((k) => commands[k]);
    const path = writeExecWrapper(jobDir(jobId), {
      worktree: wt, profileDir: join(jobDir(jobId), "profiles"), timeoutMs: d.settings.commandTimeoutSeconds * 1000,
      commands: Object.fromEntries(checks.map((k) => [k, commands[k]!])), sandbox: { ...d.settings.sandbox, gitCommonDir: await commonDir(wt) },
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
    const bundle = readSpecBundle(p.cwd, p.featureDir);
    const bad = validateSpecArtifacts(bundle).filter((c) => !c.ok);
    if (bad.length) return { kind: "blocked", reason: `The specification no longer validates: ${bad.map((c) => c.id).join(", ")}` };
    try {
      if (project.commands.install) {
        const [inst] = await runChecks(ctx, p.cwd, { install: project.commands.install }, ["install"]);
        if (inst && !inst.ok) return { kind: "blocked", reason: `Dependency install failed (\`${inst.command}\`):\n${inst.tail.slice(-1500)}` };
      }
      // Baseline: the checks must pass on the untouched default branch, or failures could not be attributed to the change.
      const baseline = await runChecks(ctx, p.cwd, project.commands);
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

  const implementation: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    const { path: wrapper, checks } = await wrapperFor(ctx.job.id, p.cwd, project.commands);
    let session: string | undefined;
    let appended = "";
    const maxPasses = d.maxPasses?.(project.id) ?? DEFAULT_PASSES;
    for (let pass = 1; pass <= maxPasses; pass++) {
      const r = await agent(ctx, {
        task: "implementation", role: "implementer", cwd: p.cwd, baseRef: p.info.base, timeoutMs: 55 * MIN, schema: ImplementResult, bashAllow: [wrapper], resumeSessionId: session,
        prompt: implementPrompt({ featureDir: p.featureDir, wrapper, checks, pass, appended }),
      });
      if (!r.ok) return r.stop;
      session = r.result.sessionId ?? session;
      await commitAll(p.cwd, `impl(${p.issue.identifier}): pass ${pass}`, git);
      const leak = await secretStop(p.cwd, p.info.base);
      if (leak) return leak;
      if ((await changedFiles(p.cwd, p.info.base, { code: true }, git)).length === 0) {
        return { kind: "retry", reason: "the implementer finished without changing any code" };
      }
      const c = await agent(ctx, { task: "specification", role: "spec-writer", cwd: p.cwd, baseRef: p.info.base, timeoutMs: 15 * MIN, schema: Converge, prompt: convergePrompt(p.featureDir) });
      if (!c.ok) return c.stop;
      await commitAll(p.cwd, `impl(${p.issue.identifier}): converge pass ${pass}`, git);
      record(ctx.job.id, "implementation.pass", `pass ${pass}: ${c.data!.converged ? "converged" : `${c.data!.appendedTasks} task(s) appended`}`, c.data!.summary);
      if (c.data!.converged) return { kind: "ok", output: { passes: pass, summary: r.data!.summary, skipped: r.data!.tasksSkipped, files: (await changedFiles(p.cwd, p.info.base, { code: true }, git)).length } };
      appended = `Appended tasks: ${c.data!.summary}`;
    }
    return { kind: "needs_attention", reason: `The implementation did not converge with the spec after ${maxPasses} passes; tasks remain. See the worktree and tasks.md. (Raise "Implementation passes" in Settings → Workflow, then retry the job: it resumes in the same worktree.)` };
  };

  const automatedTesting: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true, note: "no implementation exists in a dry run" } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    let results: CommandResult[];
    try { results = await runChecks(ctx, p.cwd, project.commands); } catch (e) { const s = sandboxStop(e); if (s) return s; throw e; }
    const bad = failed(results);
    if (bad.length === 0) return { kind: "ok", output: { results: brief(results) } };
    const findings = [];
    for (const r of bad) {
      let issue = r.tail.slice(-2500);
      if (r.tail.length > 3000) { // a cheap model condenses long logs; failure to do so must never fail the stage
        const s = await agent(ctx, { task: "classification", role: "classifier", cwd: p.cwd, timeoutMs: 5 * MIN, schema: FailureSummary, prompt: failureSummaryPrompt(r.kind, r.command, r.tail) });
        if (s.ok) issue = `${s.data!.summary}\nFailing: ${s.data!.failingTests.join(", ") || "n/a"}\n--- log tail ---\n${r.tail.slice(-1200)}`;
      }
      findings.push({ id: `check:${r.kind}`, severity: "blocker", file: r.command, line: null, issue: `${r.timedOut ? "TIMED OUT. " : ""}${issue}`, fix: "Make this check pass. Never delete, skip or weaken tests to do so." });
    }
    return { kind: "remediate", reason: `${bad.map((r) => r.kind).join(", ")} failed`, output: { findings, results: brief(results) } };
  };

  /** The independent code review (Haiku by default), plus a security review when the change touches sensitive code. */
  const localModelReview: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true, note: "no implementation exists in a dry run" } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const diff = await codeDiff(p.cwd, p.info.base, 60_000, git);
    if (diff.files.length === 0) return { kind: "fail", reason: "there is no code change to review" };
    const results = (d.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, ctx.job.id), eq(stageExecutions.stage, "AUTOMATED_TESTING"), eq(stageExecutions.outcome, "succeeded"))).orderBy(desc(stageExecutions.id)).limit(1).get());
    const checks = ((results?.outputJson ? JSON.parse(results.outputJson) : {}) as { results?: { kind: string; ok: boolean; command: string }[] }).results ?? [];
    const prompt = codeReviewPrompt({ ticket: p.ticket, spec: specExcerpt(readSpecBundle(p.cwd, p.featureDir)), stat: diff.stat, diff: diff.text, results: checks });
    const r = await independent(ctx, (task) => agent(ctx, { task, role: "qa-reviewer", prompt, cwd: p.cwd, schema: CodeReview, timeoutMs: 15 * MIN }));
    if (!r.ok) return r.stop;
    const findings: { id: string; severity: string }[] = [...r.data.findings];
    record(ctx.job.id, "code-review.independent", `${r.data.verdict}: ${r.data.findings.length} finding(s)`, r.reviewer);
    if (isSecuritySensitive(diff.files, diff.text)) {
      const s = await agent(ctx, { task: "final_review", role: "security-reviewer", prompt: securityReviewPrompt(diff.text, diff.files), cwd: p.cwd, schema: SecurityReview, timeoutMs: 15 * MIN });
      if (!s.ok) return s.stop;
      const crit = s.data!.findings.filter((f) => f.severity === "critical");
      record(ctx.job.id, "security-review", `${s.data!.findings.length} finding(s), ${crit.length} critical`);
      if (crit.length) return { kind: "needs_attention", reason: `Critical security finding(s), a human must review before this can proceed:\n${crit.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""}: ${f.issue}`).join("\n")}` };
      findings.push(...s.data!.findings.map((f) => ({ id: `sec:${f.id}`, severity: f.severity === "high" ? "major" : f.severity === "medium" ? "minor" : "minor", file: f.file, line: f.line, issue: `[security/${f.severity}] ${f.issue}`, fix: f.fix })));
    }
    const must = findings.filter((f) => isBlocking(f.severity));
    if (must.length) return { kind: "remediate", reason: `${must.length} blocking finding(s) in the independent code review`, output: { findings, reviewer: r.reviewer } };
    return { kind: "ok", output: { findings, reviewer: r.reviewer } };
  };

  const claudeReview: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true, note: "no implementation exists in a dry run" } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const diff = await codeDiff(p.cwd, p.info.base, 4000, git);
    const prev = d.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, ctx.job.id), eq(stageExecutions.stage, "LOCAL_MODEL_REVIEW"), eq(stageExecutions.outcome, "succeeded"))).orderBy(desc(stageExecutions.id)).limit(1).get();
    const earlier = ((prev?.outputJson ? JSON.parse(prev.outputJson) : {}) as { findings?: { id: string; severity: string; file: string; issue: string }[] }).findings ?? [];
    const r = await agent(ctx, {
      task: "final_review", role: "qa-reviewer", cwd: p.cwd, timeoutMs: 20 * MIN, schema: ClaudeReview,
      prompt: claudeReviewPrompt({ ticket: p.ticket, spec: specExcerpt(readSpecBundle(p.cwd, p.featureDir)), stat: diff.stat, earlier, results: [], base: p.info.base }),
    });
    if (!r.ok) return r.stop;
    for (const e of r.data!.earlier) record(ctx.job.id, "code-review.verdict", `${e.id}: ${e.valid ? "valid" : "invalid"}`, e.evidence);
    const must = r.data!.findings.filter((f) => isBlocking(f.severity));
    if (must.length) return { kind: "remediate", reason: `${must.length} blocking finding(s) in Claude's review`, output: { findings: r.data!.findings } };
    return { kind: "ok", output: { findings: r.data!.findings } };
  };

  const remediation: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const findings = latestFindings(ctx.job.id);
    if (findings.length === 0) return { kind: "ok", output: { note: "no blocking findings to remediate" } };
    const project = d.project(ctx.job.projectId);
    const { path: wrapper, checks } = await wrapperFor(ctx.job.id, p.cwd, project.commands);
    const inv = d.db.query.agentInvocations.findMany({ where: (t, { and: a, eq: e, like }) => a(e(t.jobId, ctx.job.id), like(t.agent, "%/implementer")), orderBy: (t, { desc: de }) => de(t.id), limit: 1 }).sync();
    const session = inv[0]?.usageJson ? (JSON.parse(inv[0].usageJson) as { sessionId?: string }).sessionId : undefined;
    const r = await agent(ctx, {
      task: "implementation", role: "implementer", cwd: p.cwd, baseRef: p.info.base, timeoutMs: 40 * MIN, schema: Remediation, bashAllow: [wrapper], resumeSessionId: session,
      prompt: implRemediationPrompt({ featureDir: p.featureDir, wrapper, checks, findings }),
    });
    if (!r.ok) return r.stop;
    for (const rej of r.data!.rejected) record(ctx.job.id, "remediation.rejected", rej.id, rej.reason);
    await commitAll(p.cwd, `fix(${p.issue.identifier}): address review findings`, git);
    const leak = await secretStop(p.cwd, p.info.base);
    if (leak) return leak;
    return { kind: "ok", output: { accepted: r.data!.accepted, rejected: r.data!.rejected, summary: r.data!.summary } };
  };

  const finalValidation: StageHandler = async (ctx) => {
    if (ctx.dryRun) return { kind: "ok", output: { dryRun: true, note: "no implementation exists in a dry run" } };
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    const findings: { id: string; severity: string; file: string; line: number | null; issue: string; fix: string }[] = [];
    const gate = (id: string, issue: string, file = "-") => findings.push({ id: `gate:${id}`, severity: "blocker", file, line: null, issue, fix: "Fix this and keep all checks passing." });

    let results: CommandResult[];
    try { results = await runChecks(ctx, p.cwd, project.commands); } catch (e) { const s = sandboxStop(e); if (s) return s; throw e; }
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
    const tasks = readSpecBundle(p.cwd, p.featureDir).files["tasks.md"] ?? "";
    const open = tasks.match(/^\s*- \[ \] T\d{3}\b/gm) ?? [];
    if (open.length) gate("tasks-open", `${open.length} task(s) in tasks.md are not ticked`);

    if (findings.length === 0) {
      const criteria = extractCriteria(readSpecBundle(p.cwd, p.featureDir).files["spec.md"] ?? "");
      const rejected = d.db.select().from(decisions).where(and(eq(decisions.jobId, ctx.job.id), eq(decisions.kind, "remediation.rejected"))).all().map((x) => `${x.decision}: ${x.rationale}`);
      const r = await agent(ctx, {
        task: "final_review", role: "final-reviewer", cwd: p.cwd, timeoutMs: 25 * MIN, schema: FinalReview,
        prompt: finalReviewPrompt({ ticket: p.ticket, criteria, stat: diff.stat, results, base: p.info.base, decisions: rejected }),
      });
      if (!r.ok) return r.stop;
      const unmet = r.data!.criteria.filter((c) => !c.met);
      for (const c of unmet) findings.push({ id: `criterion:${c.id}`, severity: "blocker", file: "-", line: null, issue: `criterion ${c.id} not met: ${c.evidence}`, fix: "Implement it and add a test that fails without it." });
      findings.push(...r.data!.findings.filter((f) => isBlocking(f.severity)));
      if (r.data!.verdict === "changes_required" && findings.length === 0) findings.push({ id: "final:changes", severity: "blocker", file: "-", line: null, issue: "the final reviewer requested changes without specifics", fix: "Re-examine the criteria." });
      if (findings.length === 0) {
        const report = buildReport({ key: p.issue.identifier, title: p.issue.title, url: p.issue.url, branch: p.info.branch, base: p.info.base, stat: diff.stat, results, criteria: r.data!.criteria, rejected, remediations: d.db.select().from(decisions).where(and(eq(decisions.jobId, ctx.job.id), eq(decisions.kind, "remediation"))).all().length, commits: await git(p.cwd, ["log", "--format=%h %s", `${p.info.base}..HEAD`]) });
        const file = join(d.dataDir, "reports", `${ctx.job.id}.md`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, report);
        d.db.insert(artifacts).values({ jobId: ctx.job.id, kind: "completion-report", path: file, sha256: createHash("sha256").update(report).digest("hex"), bytes: Buffer.byteLength(report) }).onConflictDoNothing().run();
        return { kind: "ok", output: { report: file, criteria: r.data!.criteria.length, results: brief(results) } };
      }
    }
    return { kind: "remediate", reason: `${findings.length} blocking issue(s) at final validation`, output: { findings, results: brief(results) } };
  };

  return {
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
