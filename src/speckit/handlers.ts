import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { desc, eq, and, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { Logger } from "pino";
import { ConfigError } from "../config/load.js";
import type { ProjectConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { artifacts, decisions, stageExecutions } from "../db/schema.js";
import type { StageHandler, StageResult } from "../core/engine.js";
import type { AgentRunner } from "../agents/runner.js";
import type { ModelRouter, TaskKind } from "../agents/router.js";
import type { AgentResult, AgentRole } from "../agents/types.js";
import { LinearApiError, type LinearClient } from "../linear/client.js";
import { git as realGit, type GitFn } from "../repo/git.js";
import { WorktreeError, type WorktreeInfo, type WorktreeManager } from "../repo/worktrees.js";
import { featureDirFor, openQuestions, readSpecBundle, recordArtifacts, validateSpecArtifacts } from "./artifacts.js";
import { analysisPrompt, analyzePrompt, classificationPrompt, remediationPrompt, reviewPrompt, skillPrompt, ticketBlock } from "./prompts.js";
import { Analysis, Analyze, Classification, blocking, Remediation, Review, toJsonSchema, type Finding } from "./schemas.js";
import { commitPaths, isInitialised } from "./tools.js";

export interface SpecKitDeps {
  db: FactoryDb;
  runner: AgentRunner;
  router: ModelRouter;
  worktrees: WorktreeManager;
  linear: () => LinearClient; // lazy: a missing LINEAR_API_KEY becomes a blocked job, not a crash at startup
  project: (id: string) => ProjectConfig;
  fallback: "claude" | "block";
  logger: Logger;
  git?: GitFn;
}

const COMMIT_PATHS = (dir: string) => [dir, ".specify/memory", ".specify/feature.json"];
const STEPS = [
  { step: "specify", file: "spec.md" },
  { step: "clarify", file: "spec.md" },
  { step: "plan", file: "plan.md" },
  { step: "tasks", file: "tasks.md" },
] as const;

/** Translate an agent failure into the engine's vocabulary. Boundary violations and auth problems need a human. */
export function failureToResult(r: AgentResult & { violations?: string[] }, what: string): StageResult {
  if (r.violations?.length) return { kind: "needs_attention", reason: `${what}: security boundary violation (${r.violations.join("; ")}). The worktree was left for inspection.` };
  if (r.failure === "auth") return { kind: "needs_attention", reason: `${what}: Claude Code is not logged in (run \`claude\` and /login).` };
  return { kind: "retry", reason: `${what} failed (${r.failure ?? "error"}): ${r.error ?? "unknown"}` };
}

export function createSpecKitHandlers(d: SpecKitDeps) {
  const git = d.git ?? realGit;

  type Prepared =
    | { ok: false; stop: StageResult }
    | { ok: true; info: WorktreeInfo; issue: Awaited<ReturnType<LinearClient["getIssue"]>>; ticket: string; featureDir: string; cwd: string };

  /** Shared per-job setup. Returns a StageResult to stop early, or the working context. */
  async function prepare(job: { id: string; projectId: string; externalId: string; externalKey: string }): Promise<Prepared> {
    let info: WorktreeInfo;
    try {
      info = await d.worktrees.create(job);
    } catch (e) {
      if (e instanceof WorktreeError) return { ok: false, stop: { kind: "blocked", reason: e.message } };
      throw e;
    }
    let issue;
    try {
      issue = await d.linear().getIssue(job.externalId);
    } catch (e) {
      if (e instanceof ConfigError || (e instanceof Error && /not set/.test(e.message))) return { ok: false, stop: { kind: "blocked", reason: e.message } };
      if (e instanceof LinearApiError && !e.retryable) return { ok: false, stop: { kind: "blocked", reason: `cannot read the Linear issue: ${e.message}` } };
      throw e;
    }
    const featureDir = featureDirFor(job.externalKey, issue.title);
    return { ok: true, info, issue, ticket: ticketBlock(issue), featureDir, cwd: info.path };
  }

  const record = (jobId: string, kind: string, decision: string, rationale?: string) =>
    d.db.insert(decisions).values({ jobId, kind, decision, rationale: rationale ?? null, actor: "factory" }).run();

  async function agent<T extends z.ZodType>(
    ctx: { job: { id: string }; executionId: number; signal: AbortSignal }, o: { task: TaskKind; role: AgentRole; prompt: string; cwd: string; schema?: T; baseRef?: string; timeoutMs: number; bashAllow?: string[] },
  ): Promise<{ ok: true; data: z.infer<T> | undefined; result: AgentResult } | { ok: false; stop: StageResult }> {
    const result = await d.runner.run({
      jobId: ctx.job.id, executionId: ctx.executionId, task: o.task, role: o.role, prompt: o.prompt, cwd: o.cwd,
      timeoutMs: o.timeoutMs, signal: ctx.signal, baseRef: o.baseRef, bashAllow: o.bashAllow,
      jsonSchema: o.schema ? toJsonSchema(o.schema) : undefined,
    });
    if (!result.ok) return { ok: false, stop: failureToResult(result, o.role) };
    if (!o.schema) return { ok: true, data: undefined, result };
    const parsed = o.schema.safeParse(result.structured);
    if (!parsed.success) return { ok: false, stop: { kind: "retry", reason: `${o.role} returned output that does not match the schema: ${parsed.error.issues[0]?.message ?? "invalid"}` } };
    return { ok: true, data: parsed.data, result };
  }

  const MIN = 60_000;

  const requirementsAnalysis: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    // Advisory pre-check by the local model. Unavailable or unconfigured is fine: Claude's analysis below is authoritative.
    let classification: z.infer<typeof Classification> | undefined;
    try {
      d.router.route("classification");
      const c = await agent(ctx, { task: "classification", role: "classifier", prompt: classificationPrompt(p.ticket), cwd: p.cwd, schema: Classification, timeoutMs: 5 * MIN });
      if (c.ok) classification = c.data;
      else record(ctx.job.id, "classification.skipped", "local classification unavailable", c.stop.kind === "retry" ? c.stop.reason : undefined);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      record(ctx.job.id, "classification.skipped", "local model not configured");
    }
    const a = await agent(ctx, { task: "specification", role: "requirements-analyst", prompt: analysisPrompt(p.ticket), cwd: p.cwd, schema: Analysis, timeoutMs: 10 * MIN });
    if (!a.ok) return a.stop;
    const analysis = a.data!;
    if (analysis.verdict === "needs_clarification") {
      const qs = analysis.questions.length ? analysis.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") : "(the analyst did not list specific questions)";
      return { kind: "blocked", reason: `The requirements need clarification before a specification can be written:\n${qs}\n\nAnswer in the ticket, then retry the job.` };
    }
    return { kind: "ok", output: { analysis, classification, branch: p.info.branch } };
  };

  const specificationGeneration: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    if (!isInitialised(p.cwd)) {
      return { kind: "blocked", reason: `Spec Kit is not set up in ${ctx.job.projectId}'s default branch. Run \`pnpm factory project:onboard ${ctx.job.projectId}\`, merge the onboarding change, then retry.` };
    }
    const project = d.project(ctx.job.projectId);
    // Factory-authored traceability file (the agent never writes the ticket itself).
    const ticketPath = join(p.cwd, p.featureDir, "ticket.md");
    mkdirSync(dirname(ticketPath), { recursive: true });
    writeFileSync(ticketPath, `# ${p.issue.identifier}: ${p.issue.title}\n\nSource: ${p.issue.url}\n\n${p.issue.description ?? "(no description)"}\n`);
    await commitPaths(p.cwd, [`${p.featureDir}/ticket.md`], `spec(${p.issue.identifier}): record ticket`, git);

    const done = new Set(d.db.select({ kind: artifacts.kind }).from(artifacts).where(eq(artifacts.jobId, ctx.job.id)).all().map((r) => r.kind));
    for (const { step, file } of STEPS) {
      if (done.has(`step:${step}`)) continue; // completed before a crash/retry
      const extra = {
        specify: `Feature request:\n${p.ticket}`,
        clarify: "Resolve ambiguities against the ticket below.\n" + p.ticket,
        plan: `Technical context: use the repository's existing stack, conventions and CLAUDE.md. Do not add dependencies unless the specification requires them.`,
        tasks: `Every behavioural change needs tests. Project commands - test: ${project.commands.test ?? "(detect from the repo)"}; lint: ${project.commands.lint ?? "(detect)"}; typecheck: ${project.commands.typecheck ?? "(detect)"}.`,
      }[step];
      const r = await agent(ctx, { task: "specification", role: "spec-writer", prompt: skillPrompt(step, p.featureDir, extra), cwd: p.cwd, baseRef: p.info.base, timeoutMs: 15 * MIN });
      if (!r.ok) return r.stop;
      const bundle = readSpecBundle(p.cwd, p.featureDir);
      if (!bundle.files[file] || bundle.files[file]!.trim().length < 100) {
        return { kind: "retry", reason: `speckit-${step} finished but ${p.featureDir}/${file} is missing or empty` };
      }
      await commitPaths(p.cwd, COMMIT_PATHS(p.featureDir), `spec(${p.issue.identifier}): ${step}`, git);
      recordArtifacts(d.db, ctx.job.id, bundle, { [`step:${step}`]: bundle.files[file]! });
      d.db.insert(artifacts).values({ jobId: ctx.job.id, kind: `step:${step}`, path: `${p.featureDir}/${file}`, sha256: `step-${step}`, bytes: bundle.files[file]!.length }).onConflictDoNothing().run();
    }
    return { kind: "ok", output: { featureDir: p.featureDir, files: Object.keys(readSpecBundle(p.cwd, p.featureDir).files) } };
  };

  /** Independent review: local model first; falls back to a fresh read-only Claude reviewer (or blocks) per config. */
  const specificationReview: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const bundle = readSpecBundle(p.cwd, p.featureDir);
    const prompt = reviewPrompt(p.ticket, bundle);
    let r = await tryLocalReview(ctx, p.cwd, prompt);
    let independent = true;
    if (!r.ok) {
      if (d.fallback === "block") return { kind: "blocked", reason: `The independent (local) reviewer is unavailable and the fallback is "block": ${r.stop.kind === "retry" ? r.stop.reason : "unavailable"}` };
      record(ctx.job.id, "review.degraded", "independent local review unavailable; used a fresh Claude reviewer", r.stop.kind === "retry" ? r.stop.reason : undefined);
      independent = false;
      r = await agent(ctx, { task: "final_review", role: "spec-reviewer", prompt, cwd: p.cwd, schema: Review, timeoutMs: 15 * MIN });
      if (!r.ok) return r.stop;
    }
    const review = (r as { data: z.infer<typeof Review> }).data;
    const must = review.findings.filter((f) => blocking(f.severity));
    record(ctx.job.id, "review.result", `${review.verdict}: ${review.findings.length} finding(s), ${must.length} blocking`, independent ? "local model" : "claude (fallback)");
    if (must.length > 0) return { kind: "remediate", reason: `${must.length} blocking finding(s) in the specification review`, output: { findings: review.findings, independent } };
    return { kind: "ok", output: { findings: review.findings, independent } };
  };

  async function tryLocalReview(ctx: Parameters<StageHandler>[0], cwd: string, prompt: string) {
    try {
      d.router.route("independent_review");
    } catch (e) {
      if (e instanceof ConfigError) return { ok: false as const, stop: { kind: "retry", reason: "local model not configured" } as StageResult };
      throw e;
    }
    return agent(ctx, { task: "independent_review", role: "spec-reviewer", prompt, cwd, schema: Review, timeoutMs: 15 * MIN });
  }

  const specificationValidation: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const bundle = readSpecBundle(p.cwd, p.featureDir);
    const questions = openQuestions(bundle);
    if (questions.length > 0) {
      return { kind: "blocked", reason: `The specification has open questions only a human can answer:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nAnswer in the ticket, then retry the job.` };
    }
    const failed = validateSpecArtifacts(bundle).filter((c) => !c.ok);
    const findings: Finding[] = failed.map((c) => ({ id: `check:${c.id}`, severity: "major", section: c.id, issue: c.detail, fix: "Fix this in the specification artefacts." }));
    if (failed.length === 0) {
      const a = await agent(ctx, { task: "specification", role: "spec-reviewer", prompt: analyzePrompt(p.featureDir), cwd: p.cwd, schema: Analyze, timeoutMs: 15 * MIN });
      if (!a.ok) return a.stop;
      for (const f of a.data!.findings) {
        findings.push({ id: `analyze:${f.id}`, severity: f.severity === "CRITICAL" || f.severity === "HIGH" ? "blocker" : "minor", section: f.location, issue: `[${f.category}] ${f.summary}`, fix: f.recommendation });
      }
    }
    const must = findings.filter((f) => blocking(f.severity));
    recordArtifacts(d.db, ctx.job.id, bundle);
    if (must.length > 0) return { kind: "remediate", reason: `${must.length} blocking finding(s) in specification validation`, output: { findings } };
    return { kind: "ok", output: { featureDir: p.featureDir, checks: "passed", notes: findings.filter((f) => !blocking(f.severity)).length } };
  };

  const specificationRemediation: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const latest = d.db.select().from(stageExecutions)
      .where(and(eq(stageExecutions.jobId, ctx.job.id), eq(stageExecutions.outcome, "succeeded"), inArray(stageExecutions.stage, ["SPECIFICATION_REVIEW", "SPECIFICATION_VALIDATION"])))
      .orderBy(desc(stageExecutions.id)).limit(1).get();
    const findings = ((latest?.outputJson ? JSON.parse(latest.outputJson) : {}) as { details?: { findings?: Finding[] } }).details?.findings?.filter((f) => blocking(f.severity)) ?? [];
    if (findings.length === 0) return { kind: "ok", output: { note: "no blocking findings to remediate" } };
    const r = await agent(ctx, { task: "specification", role: "spec-writer", prompt: remediationPrompt(p.featureDir, p.ticket, findings), cwd: p.cwd, schema: Remediation, baseRef: p.info.base, timeoutMs: 20 * MIN });
    if (!r.ok) return r.stop;
    for (const rej of r.data!.rejected) record(ctx.job.id, "remediation.rejected", `${rej.id}`, rej.reason);
    await commitPaths(p.cwd, COMMIT_PATHS(p.featureDir), `spec(${p.issue.identifier}): address review findings`, git);
    recordArtifacts(d.db, ctx.job.id, readSpecBundle(p.cwd, p.featureDir));
    return { kind: "ok", output: { accepted: r.data!.accepted, rejected: r.data!.rejected, summary: r.data!.summary } };
  };

  return {
    REQUIREMENTS_ANALYSIS: requirementsAnalysis,
    SPECIFICATION_GENERATION: specificationGeneration,
    SPECIFICATION_REVIEW: specificationReview,
    SPECIFICATION_REMEDIATION: specificationRemediation,
    SPECIFICATION_VALIDATION: specificationValidation,
  };
}
