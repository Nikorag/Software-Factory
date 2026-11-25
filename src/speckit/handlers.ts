import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asc, eq, and, inArray } from "drizzle-orm";
import type { z } from "zod";
import { ConfigError } from "../config/load.js";
import { artifacts, stageExecutions } from "../db/schema.js";
import type { StageHandler } from "../core/engine.js";
import { git as realGit } from "../repo/git.js";
import { openQuestions, readSpecBundle, recordArtifacts, validateSpecArtifacts } from "./artifacts.js";
import { analysisPrompt, analyzePrompt, classificationPrompt, HUMAN_ONLY_TASKS, remediationPrompt, reviewPrompt, skillPrompt } from "./prompts.js";
import { Analysis, Analyze, Classification, blocking, Remediation, Review, type Finding } from "./schemas.js";
import { commitPaths, isInitialised } from "./tools.js";
import { createStageKit, failureToResult, formatAnswer, type StageKitDeps } from "../app/stage-kit.js";
import { humanQAs } from "../core/jobs.js";

export type SpecKitDeps = StageKitDeps;

const COMMIT_PATHS = (dir: string) => [dir, ".specify/memory"];
const STEPS = [
  { step: "specify", file: "spec.md" },
  { step: "clarify", file: "spec.md" },
  { step: "plan", file: "plan.md" },
  { step: "tasks", file: "tasks.md" },
] as const;

export { failureToResult };

const OPEN_QUESTIONS = "The specification has open questions only a human can answer:";
const HUMAN_QUESTIONS = "human-questions";
const ANSWER_ADVICE = "Answer on the job page (the job resumes with your answer), or answer in the ticket and then retry the job.";

export function createSpecKitHandlers(d: SpecKitDeps) {
  const git = d.git ?? realGit;
  const { prepare, agent, record, independent } = createStageKit(d);

  const MIN = 60_000;

  const requirementsAnalysis: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    // Advisory pre-check by the local model. Unavailable or unconfigured is fine: Claude's analysis below is authoritative.
    let classification: z.infer<typeof Classification> | undefined;
    try {
      d.router.route("classification", ctx.job.projectId);
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
      return { kind: "blocked", reason: `The requirements need clarification before a specification can be written:\n${qs}\n\n${ANSWER_ADVICE}` };
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
        tasks: `Every behavioural change needs tests. Project commands - test: ${project.commands.test ?? "(detect from the repo)"}; lint: ${project.commands.lint ?? "(detect)"}; typecheck: ${project.commands.typecheck ?? "(detect)"}.\n\n${HUMAN_ONLY_TASKS}`,
      }[step];
      // A step can finish without producing its file (observed once live: a one-off permission denial on an in-scope Write).
      // Rerun that step once, in the same attempt, before failing the stage.
      let bundle = readSpecBundle(p.cwd, p.featureDir);
      for (let attempt = 1; ; attempt++) {
        const r = await agent(ctx, { task: "specification", role: "spec-writer", prompt: skillPrompt(step, p.featureDir, extra), cwd: p.cwd, baseRef: p.info.base, timeoutMs: 15 * MIN });
        if (!r.ok) return r.stop;
        bundle = readSpecBundle(p.cwd, p.featureDir);
        if (bundle.files[file] && bundle.files[file]!.trim().length >= 100) break;
        const denied = r.result.denials.map((x) => `${x.tool}: ${x.input.slice(0, 120)}`).join("; ");
        if (attempt >= 2) return { kind: "retry", reason: `speckit-${step} finished twice but ${p.featureDir}/${file} is missing or empty${denied ? ` (denied: ${denied})` : ""}` };
        record(ctx.job.id, "speckit.step.rerun", `${step}: ${file} missing after attempt ${attempt}`, denied || undefined);
      }
      await commitPaths(p.cwd, COMMIT_PATHS(p.featureDir), `spec(${p.issue.identifier}): ${step}`, git);
      recordArtifacts(d.db, ctx.job.id, bundle, { [`step:${step}`]: bundle.files[file]! });
      d.db.insert(artifacts).values({ jobId: ctx.job.id, kind: `step:${step}`, path: `${p.featureDir}/${file}`, sha256: `step-${step}`, bytes: bundle.files[file]!.length }).onConflictDoNothing().run();
    }
    return { kind: "ok", output: { featureDir: p.featureDir, files: Object.keys(readSpecBundle(p.cwd, p.featureDir).files) } };
  };

  /** Independent review (Haiku by default, a different model from the author; read-only). Fallback rules live in the stage kit. */
  const specificationReview: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const prompt = reviewPrompt(p.ticket, readSpecBundle(p.cwd, p.featureDir));
    const r = await independent(ctx, (task) => agent(ctx, { task, role: "spec-reviewer", prompt, cwd: p.cwd, schema: Review, timeoutMs: 15 * MIN }));
    if (!r.ok) return r.stop;
    const must = r.data.findings.filter((f) => blocking(f.severity));
    record(ctx.job.id, "review.result", `${r.data.verdict}: ${r.data.findings.length} finding(s), ${must.length} blocking`, r.reviewer);
    if (must.length > 0) return { kind: "remediate", reason: `${must.length} blocking finding(s) in the specification review`, output: { findings: r.data.findings, reviewer: r.reviewer } };
    return { kind: "ok", output: { findings: r.data.findings, reviewer: r.reviewer } };
  };

  const specExecutions = (jobId: string) => d.db.select().from(stageExecutions)
    .where(and(eq(stageExecutions.jobId, jobId), inArray(stageExecutions.stage, ["SPECIFICATION_REVIEW", "SPECIFICATION_VALIDATION", "SPECIFICATION_REMEDIATION"])))
    .orderBy(asc(stageExecutions.id)).all();

  /**
   * True when validation last held the job on the spec's open questions and a human has since resumed it (an answer or a
   * retry) without a remediation having been run on them yet. Once one has, unresolved questions block again: no loop.
   */
  const resumedAfterQuestions = (jobId: string): boolean => {
    const rows = specExecutions(jobId);
    const block = rows.findLast((r) => r.stage === "SPECIFICATION_VALIDATION" && r.outcome === "failed" && (r.error ?? "").startsWith(OPEN_QUESTIONS));
    return !!block && !rows.some((r) => r.id > block.id && r.stage === "SPECIFICATION_REMEDIATION" && r.outcome === "succeeded");
  };

  /** The spec's open questions as a blocking finding, carrying the human's answers to them (when given on the job). */
  const questionsFinding = (jobId: string, questions: string[]): Finding => {
    const answers = humanQAs(d.db, jobId).filter((a) => a.stage === "SPECIFICATION_VALIDATION");
    const given = answers.length
      ? `The human has answered them:\n\n${answers.map(formatAnswer).join("\n\n")}`
      : "No answer was given on the job: the human was asked to answer in the ticket, so look for the answers in its description and comments above.";
    return {
      id: HUMAN_QUESTIONS, severity: "blocker", section: "Open questions requiring a human",
      issue: `The specification lists open questions for a human:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n${given}`,
      fix: "Apply the answers throughout the specification, plan and tasks, then remove each answered question from the \"Open questions requiring a human\" section (write \"None.\" there if none remain). Keep a question only if neither the answers nor the ticket resolve it.",
    };
  };

  const specificationValidation: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const bundle = readSpecBundle(p.cwd, p.featureDir);
    const questions = openQuestions(bundle);
    if (questions.length > 0) {
      // Retried after being held on these questions (answered in the ticket): let the spec-writer apply the answers first.
      if (resumedAfterQuestions(ctx.job.id)) return { kind: "remediate", reason: "the human resumed the job: apply their answers to the open questions", output: { findings: [questionsFinding(ctx.job.id, questions)] } };
      return { kind: "blocked", reason: `${OPEN_QUESTIONS}\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n${ANSWER_ADVICE}` };
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
    // Findings come only from the most recent review/validation run, and only if no remediation has handled them yet:
    // a later (e.g. blocked) run, or a remediation since, means older findings are stale.
    const rows = specExecutions(ctx.job.id);
    const latest = rows.findLast((r) => r.stage !== "SPECIFICATION_REMEDIATION" && (r.outcome === "succeeded" || r.outcome === "failed"));
    const handled = latest && rows.some((r) => r.id > latest.id && r.stage === "SPECIFICATION_REMEDIATION" && r.outcome === "succeeded");
    const stored = latest?.outcome === "succeeded" && !handled
      ? ((latest.outputJson ? JSON.parse(latest.outputJson) : {}) as { details?: { findings?: Finding[] } }).details?.findings ?? []
      : [];
    const findings = stored.filter((f) => blocking(f.severity) && f.id !== HUMAN_QUESTIONS);
    const questions = openQuestions(readSpecBundle(p.cwd, p.featureDir));
    const answering = questions.length > 0 && resumedAfterQuestions(ctx.job.id);
    if (answering) findings.unshift(questionsFinding(ctx.job.id, questions));
    if (findings.length === 0) return { kind: "ok", output: { note: "no blocking findings to remediate" } };
    const r = await agent(ctx, { task: "specification", role: "spec-writer", prompt: remediationPrompt(p.featureDir, p.ticket, findings), cwd: p.cwd, schema: Remediation, baseRef: p.info.base, timeoutMs: 20 * MIN });
    if (!r.ok) return r.stop;
    for (const rej of r.data!.rejected) record(ctx.job.id, "remediation.rejected", `${rej.id}`, rej.reason);
    await commitPaths(p.cwd, COMMIT_PATHS(p.featureDir), `spec(${p.issue.identifier}): ${answering && findings.length === 1 ? "apply answers to open questions" : "address review findings"}`, git);
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
