import type { z } from "zod";
import type { Logger } from "pino";
import { ConfigError } from "../config/load.js";
import type { ProjectConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { decisions } from "../db/schema.js";
import type { StageResult } from "../core/engine.js";
import type { AgentRunner } from "../agents/runner.js";
import type { ModelRouter, TaskKind } from "../agents/router.js";
import type { AgentResult, AgentRole } from "../agents/types.js";
import { LinearApiError, type LinearClient } from "../linear/client.js";
import type { GitFn } from "../repo/git.js";
import { WorktreeError, type WorktreeInfo, type WorktreeManager } from "../repo/worktrees.js";
import { featureDirFor } from "../speckit/artifacts.js";
import { ticketBlock } from "../speckit/prompts.js";
import { humanQAs, type HumanAnswer } from "../core/jobs.js";
import { toJsonSchema } from "../speckit/schemas.js";

/** One answer, with what was asked and which stage asked it (a fresh agent never saw the question). */
export const formatAnswer = (a: HumanAnswer, i: number): string => [
  `Answer ${i + 1}${a.stage ? ` (to questions asked at ${a.stage})` : ""}:`,
  a.questions ? `Questions:\n${a.questions}` : "Questions: (not recorded)",
  `Human's answer:\n${a.answer}`,
].join("\n");

/** The ticket followed by every human answer so far, as question -> answer pairs. */
export const withAnswers = (ticket: string, answers: HumanAnswer[]): string =>
  answers.length
    ? `${ticket}\n\nAnswers from the human to open questions (authoritative: they resolve those questions, apply them and do not ask them again):\n\n${answers.map(formatAnswer).join("\n\n")}`
    : ticket;

export interface StageKitDeps {
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

/** Translate an agent failure into the engine's vocabulary. Boundary violations and auth problems need a human. */
export function failureToResult(r: AgentResult & { violations?: string[] }, what: string): StageResult {
  if (r.violations?.length) return { kind: "needs_attention", reason: `${what}: security boundary violation (${r.violations.join("; ")}). The worktree was left for inspection.` };
  if (r.failure === "auth") return { kind: "needs_attention", reason: `${what}: Claude Code is not logged in (run \`claude\` and /login).` };
  return { kind: "retry", reason: `${what} failed (${r.failure ?? "error"}): ${r.error ?? "unknown"}` };
}

export type Prepared =
  | { ok: false; stop: StageResult }
  | { ok: true; info: WorktreeInfo; issue: Awaited<ReturnType<LinearClient["getIssue"]>>; ticket: string; featureDir: string; cwd: string };

export interface AgentCall<T extends z.ZodType> {
  task: TaskKind; role: AgentRole; prompt: string; cwd: string; schema?: T; baseRef?: string; timeoutMs: number;
  bashAllow?: string[]; resumeSessionId?: string;
}
export type AgentOutcome<T extends z.ZodType> =
  | { ok: true; data: z.infer<T> | undefined; result: AgentResult & { route?: { provider: string; model: string } } }
  | { ok: false; stop: StageResult };

/** Shared per-job setup and agent plumbing used by every stage handler set. */
export function createStageKit(d: StageKitDeps) {
  /** Idempotently creates the job worktree and reads the live ticket. A returned `stop` ends the stage. */
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
    return { ok: true, info, issue, ticket: withAnswers(ticketBlock(issue), humanQAs(d.db, job.id)), featureDir: featureDirFor(job.externalKey, issue.title), cwd: info.path };
  }

  const record = (jobId: string, kind: string, decision: string, rationale?: string) =>
    d.db.insert(decisions).values({ jobId, kind, decision, rationale: rationale ?? null, actor: "factory" }).run();

  /** Runs one agent step: boundary-checked, recorded, schema-validated. Failures come back as a ready-made StageResult. */
  async function agent<T extends z.ZodType>(ctx: { job: { id: string; projectId?: string }; executionId: number; signal: AbortSignal }, o: AgentCall<T>): Promise<AgentOutcome<T>> {
    const result = await d.runner.run({
      jobId: ctx.job.id, projectId: ctx.job.projectId, executionId: ctx.executionId, task: o.task, role: o.role, prompt: o.prompt, cwd: o.cwd,
      timeoutMs: o.timeoutMs, signal: ctx.signal, baseRef: o.baseRef, bashAllow: o.bashAllow, resumeSessionId: o.resumeSessionId,
      jsonSchema: o.schema ? toJsonSchema(o.schema) : undefined,
    });
    if (!result.ok) return { ok: false, stop: failureToResult(result, o.role) };
    if (!o.schema) return { ok: true, data: undefined, result };
    const parsed = o.schema.safeParse(result.structured);
    if (!parsed.success) return { ok: false, stop: { kind: "retry", reason: `${o.role} returned output that does not match the schema: ${parsed.error.issues[0]?.message ?? "invalid"}` } };
    return { ok: true, data: parsed.data, result };
  }

  /**
   * Runs the independent reviewer (the `independent_review` route: Haiku by default). Only a *local* route has a
   * fallback (a fresh Claude reviewer on `final_review`, or block, per config); a Claude route's failure is just a failure.
   */
  async function independent<T extends z.ZodType>(
    ctx: { job: { id: string; projectId?: string } }, run: (task: TaskKind) => Promise<AgentOutcome<T>>,
  ): Promise<{ ok: true; data: z.infer<T>; reviewer: string } | { ok: false; stop: StageResult }> {
    let provider: "local" | "anthropic" = "anthropic";
    let r: AgentOutcome<T>;
    try {
      provider = d.router.route("independent_review", ctx.job.projectId).provider;
      r = await run("independent_review");
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      provider = "local"; // an unconfigured local route
      r = { ok: false, stop: { kind: "retry", reason: "local model not configured" } };
    }
    let reviewer = r.ok ? (r.result.route?.model ?? "independent_review") : "";
    if (!r.ok) {
      if (provider !== "local") return { ok: false, stop: r.stop };
      const why = r.stop.kind === "retry" ? r.stop.reason : "unavailable";
      if (d.fallback === "block") return { ok: false, stop: { kind: "blocked", reason: `The independent (local) reviewer is unavailable and the fallback is "block": ${why}` } };
      record(ctx.job.id, "review.degraded", "independent local review unavailable; used a fresh Claude reviewer", why);
      r = await run("final_review");
      if (!r.ok) return { ok: false, stop: r.stop };
      reviewer = `${r.result.route?.model ?? "claude"} (fallback)`;
    }
    return { ok: true, data: r.data as z.infer<T>, reviewer };
  }

  return { prepare, agent, record, independent };
}
