import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { and, count, desc, eq, gt, ne } from "drizzle-orm";
import type { Logger } from "pino";
import type { StageName, LoadedConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs, stageExecutions, worktrees } from "../db/schema.js";
import { getControl } from "./control.js";
import { effectiveStageTimeoutSeconds } from "../config/stage-budgets.js";
import { fixCycleHistory, inCiPhase, lifetimeNote, type FixPhase } from "./fix-cycles.js";
import { jobVariables, latestOutput } from "../workflows/context.js";
import { renderPrompt } from "../workflows/template.js";
import { claimNext, getJob, recoverExpired, renewLease, runningCount, type JobRow } from "./jobs.js";
import { isMutating as isMutatingHandler, statusForStage } from "./workflow.js";
import { buildDefaultDefinition } from "../workflows/default.js";
import { COMPLETE, type FailureRule, type Stage, type StageType } from "../workflows/definition.js";
import { evaluateCondition, evaluateGate, type GateContext, type GateResult } from "../workflows/gates.js";
import { CompiledWorkflow } from "../workflows/graph.js";
import { SYSTEM_LIMITS } from "../workflows/limits.js";
import { CODE_CHANGERS, MANDATORY_GATES } from "../workflows/safety.js";
import { validateDefinition } from "../workflows/validate.js";

export interface StageContext {
  job: JobRow;
  /** The stage's definition in this job's workflow snapshot (a handler reads its own settings from here). */
  stage?: Stage | undefined;
  workflow?: { id: string | null; version: number | null } | undefined;
  /** The workflow's extra instructions for this stage, appended to its agents' prompts by the stage kit. */
  instructions?: string;
  /** The workflow's model choice for this stage: resolved by the model router at run time, never bypassing it. */
  model?: { provider?: "local" | "anthropic" | undefined; model?: string | undefined };
  attempt: number;
  executionId: number; // the stage_executions row for this attempt (links agent invocations to it)
  signal: AbortSignal; // aborted on timeout, cancel, emergency stop or lease loss
  dryRun: boolean;
  logger: Logger;
}
export type StageResult =
  | { kind: "ok"; output?: unknown }
  | { kind: "remediate"; reason: string; output?: unknown } // findings that need fixing
  | { kind: "wait"; reason: string; delayMs: number } // nothing is wrong: poll again later (CI pending, awaiting a human). Never consumes retries.
  | { kind: "retry"; reason: string } // transient failure
  | { kind: "blocked"; reason: string } // needs a dependency / ambiguity resolved
  | { kind: "needs_attention"; reason: string } // human required (e.g. security)
  | { kind: "fail"; reason: string }; // permanent
export type StageHandler = (ctx: StageContext) => Promise<StageResult>;
export type HandlerRegistry = Partial<Record<StageName, StageHandler>>;
/** Runners for the reusable stage types (agent, review, check). `factory` stages use the HandlerRegistry; `conditional` runs inside the engine. */
export type TypedHandlers = Partial<Record<Exclude<StageType, "factory" | "conditional">, StageHandler>>;
type FailureKind = "findings" | "error" | "timeout" | "gate";

/** Called synchronously (inside the stage-change transaction where one exists) so side-effect records are atomic with it. */
export interface EngineObserver {
  onStage(job: JobRow, stage: string, detail?: { reason?: string }): void;
}

export interface EngineOptions {
  observer?: EngineObserver;
  db: FactoryDb;
  logger: Logger;
  config: Pick<LoadedConfig, "factory" | "workflows"> & Partial<Pick<LoadedConfig, "projects">>;
  handlers: HandlerRegistry;
  typed?: TypedHandlers;
  owner?: string;
  now?: () => Date;
  leaseMs?: number;
  heartbeatMs?: number;
  backoffBaseMs?: number;
  /** After an abort (cancel, stop, timeout...), how long to wait for the stage's handler (and its agent process) to actually stop before the job is released. */
  abortSettleMs?: number;
}

type AbortReason = "timeout" | "cancel" | "estop" | "lease-lost" | "shutdown";
const HELD_STAGES = new Set<string>(["BLOCKED", "FAILED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION", "COMPLETED"]);

export class Engine {
  readonly owner: string;
  /** Aborters for stages running right now, so a stop or shutdown reaches the agent immediately, not at the next heartbeat. */
  private readonly active = new Map<string, (r: AbortReason) => void>();
  /** Jobs whose runJob is in flight here (between stages too, and while an aborted handler is settling). Never recovered as crashed. */
  private readonly running = new Set<string>();
  /** Aborted handlers that had not stopped within abortSettleMs. Their jobs are not claimed again until they have: one agent per worktree. */
  private readonly unsettled = new Map<string, Promise<unknown>>();
  private readonly o: Required<Omit<EngineOptions, "owner" | "observer" | "typed">> & { observer?: EngineObserver; typed: TypedHandlers };
  private readonly graphs = new Map<string, { key: string; graph: CompiledWorkflow | { error: string } }>();

  constructor(opts: EngineOptions) {
    this.owner = opts.owner ?? `factory-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.o = { now: () => new Date(), leaseMs: 60_000, heartbeatMs: 15_000, backoffBaseMs: 5_000, abortSettleMs: 15_000, typed: {}, ...opts };
  }

  /** Ids of jobs this engine is executing right now. */
  activeJobIds(): string[] { return [...this.active.keys()]; }

  /** Abort running stages immediately. `estop` holds the jobs as PAUSED; `shutdown` re-queues them untouched for the next start. */
  abortActive(reason: "estop" | "shutdown"): number {
    const aborters = [...this.active.values()];
    for (const a of aborters) a(reason);
    return aborters.length;
  }

  /** Abort one running job (user cancel), reaching the agent immediately. Returns whether it was running here. */
  abortJob(jobId: string, reason: "cancel"): boolean {
    const a = this.active.get(jobId);
    a?.(reason);
    return Boolean(a);
  }

  /** The fix-cycle cap that applies to a job: its project's own setting, else the global one. */
  remediationCap(job: Pick<JobRow, "projectId">): number {
    return this.o.config.projects?.projects.find((p) => p.id === job.projectId)?.overrides?.maxRemediationAttempts ?? this.o.config.factory.maxRemediationAttempts;
  }
  /** Implementation passes for a job: its project's own setting, else the global one. */
  private implementationPasses(job: Pick<JobRow, "projectId">): number {
    return this.o.config.projects?.projects.find((p) => p.id === job.projectId)?.overrides?.maxImplementationPasses ?? this.o.config.factory.maxImplementationPasses;
  }
  /** How many jobs of one project may run at once. Default 1. Every job has its own worktree (isolated files, and worktree creation is serialised per repository), so this is not a technical limit: it is a conservative default, because tickets in one repository often touch the same files and would raise conflicting PRs, and each job installs and tests on its own. Raise it per project when the work is independent. */
  private projectCap(projectId: string): number {
    return this.o.config.projects?.projects.find((p) => p.id === projectId)?.overrides?.maxConcurrentJobs ?? 1;
  }

  private readonly inflight = new Set<Promise<void>>();

  /**
   * Starts as many claimable jobs as the limits allow (the global maxConcurrentJobs, and each project's own cap) and returns how many it
   * started, without waiting for them. Recovers crashed jobs and honours pause / emergency stop first. Called repeatedly by the scheduler.
   */
  start(): number {
    const { db } = this.o;
    const now = this.o.now();
    // Renew our own leases first: after the machine sleeps the clock jumps past them before any heartbeat has run. Then recover only
    // jobs nobody here is running (crashed processes, or our own from before a restart), never the ones this engine is executing.
    for (const id of this.running) renewLease(db, id, this.owner, now, this.o.leaseMs);
    recoverExpired(db, now, [...this.running, ...this.unsettled.keys()]);
    const ctl = getControl(db);
    if (ctl.paused || ctl.emergencyStop) return 0;
    this.resumePaused();
    let started = 0;
    while (this.inflight.size < this.o.config.factory.maxConcurrentJobs) {
      const job = claimNext(db, this.owner, this.o.now(), this.o.leaseMs, (j) => !this.running.has(j.id) && !this.unsettled.has(j.id) && runningCount(db, j.projectId) < this.projectCap(j.projectId));
      if (!job) break;
      const p: Promise<void> = this.runJob(job.id)
        .catch((e) => this.o.logger.error({ jobId: job.id, err: String(e) }, "job run failed"))
        .finally(() => { this.inflight.delete(p); });
      this.inflight.add(p);
      started++;
    }
    return started;
  }

  /** Resolves once every job this engine started has stopped (finished, held, or aborted). */
  async idle(): Promise<void> { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  /** Start what can run and wait for it all to finish: what `factory work` and the tests use. Returns how many jobs ran. */
  async tick(): Promise<number> {
    const started = this.start();
    await this.idle();
    return started;
  }

  private resumePaused(): void {
    const { db } = this.o;
    for (const j of db.select().from(jobs).where(eq(jobs.stage, "PAUSED")).all()) {
      db.update(jobs).set({ stage: j.heldFromStage ?? "DISCOVERED", heldFromStage: null, status: "queued", updatedAt: this.o.now() }).where(eq(jobs.id, j.id)).run();
    }
  }

  /** Runs a claimed job stage by stage until it completes, holds, is rescheduled, or loses its lease. */
  async runJob(jobId: string): Promise<void> {
    if (this.running.has(jobId)) return; // already executing here: never two runs of one job (one agent per worktree)
    this.running.add(jobId);
    try {
      await this.runClaimed(jobId);
    } finally {
      this.running.delete(jobId);
    }
  }

  private async runClaimed(jobId: string): Promise<void> {
    const { db } = this.o;
    const claimed = getJob(db, jobId);
    if (claimed) this.notify(claimed, claimed.stage); // re-assert external status after retry/recovery (observer dedupes)
    for (;;) {
      const job = getJob(db, jobId);
      if (!job || job.status !== "running" || job.leaseOwner !== this.owner) return;
      if (job.cancelRequested) return this.hold(job, "CANCELLED", "cancelled by request");
      const ctl = getControl(db);
      if (ctl.paused || ctl.emergencyStop) return this.hold(job, "PAUSED", ctl.reason ?? "factory paused");
      if (HELD_STAGES.has(job.stage)) return this.release(job); // nothing to execute: never leave it "running"
      const keepGoing = await this.runStage(job, job.stage);
      if (!keepGoing) return;
    }
  }

  /** A claimed job that sits in a held stage (e.g. queued there by an old cancel-then-retry): give it back its held status and free its slot. */
  private release(job: JobRow): void {
    const { db } = this.o;
    const stage = job.stage;
    db.transaction(() => {
      db.update(jobs).set({ status: statusForStage(stage), leaseOwner: null, leaseExpiresAt: null, updatedAt: this.o.now() }).where(eq(jobs.id, job.id)).run();
      db.insert(decisions).values({ jobId: job.id, kind: "job.release", decision: `released at ${stage}`, rationale: "the job was queued in a held stage, so there was nothing to run; retry it to resume", actor: "factory" }).run();
    });
    this.o.logger.warn({ jobId: job.id, stage }, "released a job queued in a held stage");
  }

  /**
   * The workflow a job runs: the snapshot taken when it was created. A job from before workflows existed has none, and runs the built-in
   * Default Workflow built from this config (the same graph and limits it always had).
   */
  private graph(job: JobRow): CompiledWorkflow | { error: string } {
    const key = job.workflowSnapshotJson ?? `legacy:${job.workflow}`;
    const hit = this.graphs.get(job.id);
    if (hit?.key === key) return hit.graph;
    let graph: CompiledWorkflow | { error: string };
    if (job.workflowSnapshotJson) {
      try {
        const v = validateDefinition(JSON.parse(job.workflowSnapshotJson));
        graph = v.ok ? new CompiledWorkflow(v.definition) : { error: `this job's workflow snapshot is not valid (${v.errors[0]?.path}: ${v.errors[0]?.message}), so it will not run` };
      } catch (e) { graph = { error: `this job's workflow snapshot cannot be read: ${(e as Error).message}` }; }
    } else graph = new CompiledWorkflow(buildDefaultDefinition(this.o.config.workflows, job.workflow));
    this.graphs.set(job.id, { key, graph });
    return graph;
  }

  private isMutating(stage: Stage): boolean {
    // Factory stages take it from the engine's own table: a workflow cannot mark a side-effecting stage harmless.
    return stage.type === "factory" ? isMutatingHandler(stage.handler as StageName) : Boolean(stage.mutating);
  }

  /** Stage timeout in seconds: the workflow's, capped by the system limit, and for factory stages never below what the handler may spend. */
  private timeoutSeconds(job: JobRow, stage: Stage): number {
    const configured = Math.min(stage.timeoutSeconds, SYSTEM_LIMITS.maxStageTimeoutSeconds);
    if (stage.type !== "factory") return configured;
    // Never shorter than what the stage's own handler may spend (agents, project commands, passes): a timeout there discards real work.
    return effectiveStageTimeoutSeconds(stage.handler as StageName, configured, { commandTimeoutSeconds: this.o.config.factory.commandTimeoutSeconds, implementationPasses: this.implementationPasses(job) });
  }

  private gateContext(job: JobRow, output: unknown): GateContext {
    const { db } = this.o;
    return {
      output,
      job: { remediationAttempts: job.remediationAttempts, stageAttempts: job.stageAttempts, dryRun: job.dryRun, autonomous: job.autonomous, manual: job.manual, kind: job.workflow },
      outputOf: (id) => latestOutput(db, job.id, id),
      exists: (rel) => {
        const wt = db.select().from(worktrees).where(eq(worktrees.jobId, job.id)).get();
        if (!wt || wt.state === "removed") return false;
        try {
          const root = realpathSync(wt.path), p = join(root, rel);
          if (!existsSync(p)) return false;
          const real = realpathSync(p); // a symlink must not point out of the worktree
          return real === root || real.startsWith(root + sep);
        } catch { return false; }
      },
    };
  }

  /** The latest successful (really executed, not skipped) attempt of a stage in this job: its execution id. */
  private lastPassed(jobId: string, stageId: string): number | undefined {
    const rows = this.o.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.stage, stageId), eq(stageExecutions.outcome, "succeeded"))).orderBy(desc(stageExecutions.id)).limit(20).all();
    return rows.find((r) => !r.outputJson || !/"skipped":true/.test(r.outputJson))?.id;
  }

  /**
   * The mandatory safety gates, enforced here independently of how the workflow is configured (validation also rejects such workflows when
   * they are saved, but a snapshot is data: this is the check that does not trust it). Returns why the stage may not run yet.
   */
  private safetyBlock(job: JobRow, g: CompiledWorkflow, stage: Stage): string | undefined {
    if (!job.workflowSnapshotJson) return undefined; // jobs that predate workflows run the fixed built-in graph
    if (job.workflowResolutionJson?.includes('"legacy":true')) return undefined; // ...and so do those given a snapshot of it when workflows arrived: it is code, not configuration
    for (const m of MANDATORY_GATES) {
      if (stage.id === m.handler) continue;
      const guarded = m.guards === "mutating" ? this.isMutating(stage) : stage.type === "factory" && m.guards.includes(stage.handler!);
      if (!guarded) continue;
      const gate = g.stage(m.handler);
      if (!gate?.enabled) return `${stage.id} cannot run: this workflow lacks the mandatory ${m.handler} stage (${m.why})`;
      const passed = this.lastPassed(job.id, m.handler);
      if (passed === undefined) return `${stage.id} cannot run before ${m.handler} has passed (${m.why})`;
      if (m.guards !== "mutating") {
        // a review that passed before the code last changed does not cover the code as it is now
        const changed = Math.max(0, ...g.stages.filter((s) => s.type === "factory" && CODE_CHANGERS.has(s.handler!)).map((s) => this.lastPassed(job.id, s.id) ?? 0));
        if (passed < changed) return `${stage.id} cannot run: the code changed after ${m.handler} last passed, so it must pass again (${m.why})`;
      }
    }
    return undefined;
  }

  /** Stage attempts started since the job was last retried by a person (waiting polls are not attempts). */
  private attemptsSinceRetry(jobId: string): number {
    const { db } = this.o;
    const lastRetry = db.select({ at: decisions.createdAt }).from(decisions).where(and(eq(decisions.jobId, jobId), eq(decisions.kind, "job.retry"))).orderBy(desc(decisions.id)).limit(1).get()?.at;
    const base = and(eq(stageExecutions.jobId, jobId), ne(stageExecutions.outcome, "waiting"));
    return db.select({ n: count() }).from(stageExecutions).where(lastRetry ? and(base, gt(stageExecutions.startedAt, lastRetry)) : base).get()?.n ?? 0;
  }

  /** Executes one stage attempt. Returns true if the job is still ours and runnable immediately. */
  private async runStage(job: JobRow, stageId: string): Promise<boolean> {
    const { db, logger } = this.o;
    const g = this.graph(job);
    if ("error" in g) { this.hold(job, "BLOCKED", g.error); return false; }
    const stage = g.stage(stageId);
    if (!stage) { this.hold(job, "BLOCKED", `stage ${stageId} is not part of this job's workflow, so there is nothing to run. Retry the job from a stage it has.`); return false; }

    // Limits the workflow cannot raise: a job that has used its time or its attempts stops for a person instead of looping.
    const limit = g.def.limits.timeoutSeconds;
    if (limit && this.o.now().getTime() - job.createdAt.getTime() > limit * 1000) { this.hold(job, "FAILED", `the workflow's time limit of ${limit}s was exceeded`); return false; }
    const cap = Math.min(g.def.limits.maxStageExecutions, SYSTEM_LIMITS.maxStageExecutions);
    if (this.attemptsSinceRetry(job.id) >= cap) { this.hold(job, "NEEDS_ATTENTION", `this job has already run ${cap} stage attempts (the limit that stops loops): see its history, then retry it to continue`); return false; }

    const timeoutSeconds = this.timeoutSeconds(job, stage);
    const dryRun = job.dryRun || this.o.config.factory.dryRun;
    const attempt = (db.select({ n: count() }).from(stageExecutions).where(and(eq(stageExecutions.jobId, job.id), eq(stageExecutions.stage, stage.id))).get()?.n ?? 0) + 1;
    const key = `${job.id}:${stage.id}:${attempt}`;
    const execId = db.insert(stageExecutions).values({ jobId: job.id, stage: stage.id, attempt, outcome: "started", idempotencyKey: key, startedAt: this.o.now() }).returning({ id: stageExecutions.id }).get().id;
    const log = logger.child({ jobId: job.id, stage: stage.id, attempt });

    type Extra = { output?: unknown; error?: string; gate?: GateResult; route?: unknown };
    // outcome null: only add detail (a route, a gate result) to an attempt that already has its outcome.
    const finish = (outcome: "succeeded" | "failed" | "timed_out" | "cancelled" | "waiting" | null, extra: Extra = {}) =>
      db.update(stageExecutions).set({
        ...(outcome ? { outcome, finishedAt: this.o.now() } : {}),
        ...(extra.output !== undefined ? { outputJson: JSON.stringify(extra.output) } : {}), ...(extra.error !== undefined ? { error: extra.error } : {}),
        ...(extra.gate ? { gateJson: JSON.stringify(extra.gate) } : {}), ...(extra.route !== undefined ? { routeJson: JSON.stringify(extra.route) } : {}),
      }).where(eq(stageExecutions.id, execId)).run();
    const ctxFor = (job: JobRow, signal: AbortSignal): StageContext => ({
      job, attempt, executionId: execId, signal, dryRun, logger: log, stage, workflow: { id: job.workflowId, version: job.workflowVersion },
      ...(stage.prompt?.instructions ? { instructions: renderPrompt(stage.prompt.instructions, jobVariables(db, job, stage, attempt, { projectName: this.o.config.projects?.projects.find((p) => p.id === job.projectId)?.name })).trim() } : {}),
      ...(stage.model && (stage.model.provider || stage.model.model) ? { model: stage.model } : {}),
    });

    // A stage that is switched off, or whose condition does not hold, is passed over (and recorded as skipped).
    if (!stage.enabled || (stage.runIf && !evaluateCondition(stage.runIf, this.gateContext(job, undefined)).held)) {
      const why = stage.enabled ? `condition not met: ${evaluateCondition(stage.runIf!, this.gateContext(job, undefined)).detail}` : "the stage is disabled";
      return this.advance(job, g, stage, g.next(stage.id), () => finish("succeeded", { output: { skipped: true, reason: why }, route: { action: "skip", reason: why } }));
    }
    const missing = stage.requires.filter((r) => this.lastPassed(job.id, r) === undefined);
    if (missing.length) { finish("failed", { error: `requires ${missing.join(", ")}` }); this.hold(job, "BLOCKED", `${stage.id} needs the output of ${missing.join(", ")}, which has not succeeded in this job`); return false; }

    // Dry run: record the intended operation, never invoke side-effecting stages.
    if (dryRun && this.isMutating(stage)) {
      return this.apply(job, g, stage, { kind: "ok", output: { dryRun: true, wouldExecute: stage.id } }, finish, "dry-run: skipped mutating stage");
    }
    if (stage.type === "conditional") {
      const c = stage.config as { condition: import("../workflows/definition.js").Condition };
      const r = evaluateCondition(c.condition, this.gateContext(job, undefined));
      const to = g.branch(stage.id, r.held);
      return this.advance(job, g, stage, to, () => finish("succeeded", { output: { held: r.held, to, detail: r.detail }, route: { action: "branch", to, reason: r.detail } }));
    }
    const block = this.safetyBlock(job, g, stage);
    if (block) { finish("failed", { error: block }); this.hold(job, "BLOCKED", block); return false; }
    const handler: StageHandler | undefined = stage.type === "factory" ? this.o.handlers[stage.handler as StageName] : this.o.typed[stage.type as keyof TypedHandlers];
    if (!handler) {
      finish("failed", { error: "no handler registered" });
      this.hold(job, "BLOCKED", `no handler registered for ${stage.id}`);
      return false;
    }

    const ac = new AbortController();
    let reason: AbortReason | undefined;
    const abort = (r: AbortReason) => { if (!reason) { reason = r; ac.abort(r); } };
    this.active.set(job.id, abort);
    const timer = setTimeout(() => abort("timeout"), timeoutSeconds * 1000);
    const beat = setInterval(() => {
      if (!renewLease(db, job.id, this.owner, this.o.now(), this.o.leaseMs)) return abort("lease-lost");
      const fresh = getJob(db, job.id);
      if (fresh?.cancelRequested) abort("cancel");
      if (getControl(db).emergencyStop) abort("estop");
    }, this.o.heartbeatMs);

    let result: StageResult;
    // async wrapper: a handler that throws synchronously becomes a rejection like any other
    const run = (async () => handler(ctxFor(job, ac.signal)))();
    try {
      const aborted = new Promise<never>((_, rej) => {
        if (ac.signal.aborted) rej(new Error(`aborted: ${reason}`)); // a handler that was stopped before it first yielded
        else ac.signal.addEventListener("abort", () => rej(new Error(`aborted: ${reason}`)), { once: true });
      });
      aborted.catch(() => {}); // avoid unhandled rejection when the handler wins the race
      result = await Promise.race([run, aborted]);
    } catch (e) {
      result = { kind: "retry", reason: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
      clearInterval(beat);
      this.active.delete(job.id);
    }
    // Aborted: the agent is being stopped (SIGTERM, grace, SIGKILL, then post-run checks). Let it finish stopping before the job is
    // released, or a quick retry could start a second agent in the same worktree.
    if (reason) await this.settle(job.id, run, log);

    if (reason === "shutdown") {
      // The service is stopping, not the job failing: put it back exactly where it was, spending no attempt, so a restart resumes it.
      finish("cancelled", { error: "service shutdown" });
      this.o.db.update(jobs).set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, updatedAt: this.o.now() }).where(eq(jobs.id, job.id)).run();
      return false;
    }
    if (reason === "lease-lost") { finish("failed", { error: "lease lost" }); return false; } // another process owns it now
    if (reason === "cancel") { finish("cancelled"); this.hold(job, "CANCELLED", "cancelled by request"); return false; }
    if (reason === "estop") { finish("cancelled", { error: "emergency stop" }); this.hold(job, "PAUSED", "emergency stop"); return false; }
    if (reason === "timeout") {
      finish("timed_out", { error: `exceeded ${timeoutSeconds}s` });
      return this.fail(job, g, stage, "timeout", `timed out after ${timeoutSeconds}s`, undefined, finish);
    }
    return this.apply(job, g, stage, result, finish);
  }

  /** Waits (bounded) for an aborted handler to stop. If it has not, its job is kept from being claimed again until it has. */
  private async settle(jobId: string, run: Promise<unknown>, log: Logger): Promise<void> {
    const done = run.then(() => undefined, () => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([done.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), this.o.abortSettleMs); })]);
    clearTimeout(timer);
    if (settled) return;
    log.warn({ waitedMs: this.o.abortSettleMs }, "aborted stage has not stopped yet; the job will not be run again until it has");
    this.unsettled.set(jobId, done);
    void done.then(() => { if (this.unsettled.get(jobId) === done) this.unsettled.delete(jobId); });
  }

  /** Which fix-cycle budget a route out of `stage` spends, and how many of it are already used. */
  private fixPhase(job: JobRow, g: CompiledWorkflow, stage: Stage): { phase: FixPhase; used: number } {
    if (stage.budget?.phase === "specification") return { phase: "specification", used: job.remediationAttempts };
    const ci = g.stages.filter((s) => s.budget?.phase === "ci").map((s) => s.id);
    if (ci.length && inCiPhase(this.o.db, job.id, ci)) return { phase: "CI", used: job.remediationAttempts };
    // CI's first fix request opens a fresh budget: the review fixes before the PR must not use up the fixes CI needs.
    if (stage.budget?.phase === "ci") return { phase: "CI", used: 0 };
    return { phase: "code", used: job.remediationAttempts };
  }

  /** Success: records it, moves to `to` (or completes the job), all in one transaction. */
  private advance(job: JobRow, g: CompiledWorkflow, stage: Stage, to: string, done: () => unknown, note?: string): boolean {
    const { db } = this.o;
    const target = to === COMPLETE ? undefined : g.stage(to);
    if (to !== COMPLETE && !target) { done(); this.hold(job, "BLOCKED", `the workflow routes ${stage.id} to "${to}", which is not one of its stages`); return false; }
    db.transaction(() => {
      done();
      if (note) db.insert(decisions).values({ jobId: job.id, kind: "dry-run", decision: `${stage.id} skipped`, rationale: note, actor: "factory" }).run();
      if (to === COMPLETE) this.complete(job);
      else if (target!.budget?.resetOnEntry) {
        // Leaving the specification phase: code fixes get their own budget, whatever the spec used.
        if (job.remediationAttempts > 0) db.insert(decisions).values({ jobId: job.id, kind: "remediation.budget", decision: "fresh fix-cycle budget for the code phase", rationale: `the specification used ${job.remediationAttempts}`, actor: "factory" }).run();
        this.setStage(job, to, { stageAttempts: 0, remediationAttempts: 0 });
      } else this.setStage(job, to, { stageAttempts: 0 });
    });
    return to !== COMPLETE;
  }

  private apply(
    job: JobRow, g: CompiledWorkflow, stage: Stage, result: StageResult,
    finish: (o: "succeeded" | "failed" | "timed_out" | "cancelled" | "waiting" | null, e?: { output?: unknown; error?: string; gate?: GateResult; route?: unknown }) => unknown,
    note?: string,
  ): boolean {
    const { db } = this.o;
    switch (result.kind) {
      case "ok": {
        // The stage says it succeeded; the gate checks the recorded evidence. A gate can only make a stage stricter.
        const gate = evaluateGate(stage.successGate, this.gateContext(job, result.output));
        if (!gate.passed) {
          const why = `success gate not met: ${describeGate(gate.trace)}`;
          finish("failed", { output: result.output, error: why, gate });
          return this.fail(job, g, stage, "gate", why, result.output, finish);
        }
        const to = g.next(stage.id);
        return this.advance(job, g, stage, to, () => finish("succeeded", { output: result.output, gate, route: { action: "next", to } }), note);
      }
      case "remediate":
        finish("succeeded", { output: { remediate: result.reason, details: result.output } });
        return this.fail(job, g, stage, "findings", result.reason, result.output, finish);
      case "wait": {
        // Not a failure: release the lease and come back later. The stage does not advance and no attempt budget is spent.
        finish("waiting", { output: { reason: result.reason, delayMs: result.delayMs } });
        db.update(jobs).set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, notBefore: new Date(this.o.now().getTime() + result.delayMs), lastError: null, updatedAt: this.o.now() }).where(eq(jobs.id, job.id)).run();
        return false;
      }
      case "retry":
        finish("failed", { error: result.reason });
        return this.fail(job, g, stage, "error", result.reason, undefined, finish);
      // These three are never routable: a person is needed (or the work is permanently wrong), whatever the workflow says.
      case "blocked":
        finish("failed", { error: result.reason });
        this.hold(job, "BLOCKED", result.reason);
        return false;
      case "needs_attention":
        finish("failed", { error: result.reason });
        this.hold(job, "NEEDS_ATTENTION", result.reason);
        return false;
      case "fail":
        finish("failed", { error: result.reason });
        this.hold(job, "FAILED", result.reason);
        return false;
    }
  }

  /**
   * A stage did not succeed: apply the stage's failure rules, in order. The first rule that matches the kind of failure and can still act
   * decides (a retry rule with no retries left falls through to the next rule). Nothing matching ends the job. Bounded throughout: retries by
   * the stage's retry limit, goto routes by the fix-cycle budget, and every one of them by the job's attempt limit.
   */
  private fail(
    job: JobRow, g: CompiledWorkflow, stage: Stage, kind: FailureKind, reason: string, output: unknown,
    finish: (o: "succeeded" | "failed" | "timed_out" | "cancelled" | "waiting" | null, e?: { output?: unknown; error?: string; route?: unknown }) => unknown,
  ): boolean {
    const { db } = this.o;
    // A critical finding is never retried, skipped or routed around: a person decides.
    const findings = (output as { findings?: { severity?: string }[] } | undefined)?.findings;
    if (kind === "findings" && Array.isArray(findings) && findings.some((f) => f?.severity === "critical")) {
      finish(null, { error: reason, route: { action: "manual", reason: "a critical finding is never routed around" } });
      this.hold(job, "NEEDS_ATTENTION", `a critical finding needs a person: ${reason}`);
      return false;
    }
    const matching = stage.onFailure.filter((r) => r.on === kind || r.on === "any");
    const rules: FailureRule[] = matching.length || kind === "findings" ? matching : [{ on: kind, action: "retry" }]; // an unconfigured failure is retried, then ends the job
    const failures = job.stageAttempts + 1;
    const maxRetries = Math.min(stage.retry.max, SYSTEM_LIMITS.maxRetries);
    for (const [i, r] of rules.entries()) {
      switch (r.action) {
        case "retry": {
          if (failures > maxRetries) continue; // out of retries: the next rule, if any, decides
          const base = stage.retry.delaySeconds !== undefined ? stage.retry.delaySeconds * 1000 : this.o.backoffBaseMs;
          const delay = Math.min(stage.retry.backoff ? base * 2 ** (failures - 1) : base, SYSTEM_LIMITS.maxRetryDelaySeconds * 1000);
          finish(null, { route: { action: "retry", rule: i, attempt: failures, of: maxRetries, delayMs: delay } });
          db.update(jobs).set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, stageAttempts: failures, notBefore: new Date(this.o.now().getTime() + delay), lastError: reason, updatedAt: this.o.now() }).where(eq(jobs.id, job.id)).run();
          return false; // rescheduled; scheduler will reclaim after backoff
        }
        case "goto": return this.reroute(job, g, stage, r, i, reason, output, finish);
        case "skip": {
          if (stage.required) continue; // validation rejects this, and a stored snapshot is not trusted: a required stage is never skipped
          finish(null, { error: reason, route: { action: "skip", rule: i, reason } });
          db.insert(decisions).values({ jobId: job.id, kind: "route.skip", decision: `${stage.id} skipped after ${kind} failure`, rationale: reason, actor: "factory" }).run();
          return this.advance(job, g, stage, g.next(stage.id), () => undefined);
        }
        case "block": finish(null, { error: reason, route: { action: "block", rule: i } }); this.hold(job, "BLOCKED", reason); return false;
        case "manual": finish(null, { error: reason, route: { action: "manual", rule: i } }); this.hold(job, "NEEDS_ATTENTION", reason); return false;
        case "fail": finish(null, { error: reason, route: { action: "fail", rule: i } }); this.hold(job, "FAILED", reason); return false;
      }
    }
    if (kind === "findings") { finish("failed", { error: `${stage.id} cannot remediate` }); this.hold(job, "FAILED", `${stage.id} reported findings but has no remediation path`); return false; }
    this.hold(job, "FAILED", `${stage.id} failed after ${failures} attempt(s): ${reason}`);
    return false;
  }

  /** A failure route that sends the job to another stage (usually back to fix something). Spends the fix-cycle budget; out of budget, a person decides. */
  private reroute(
    job: JobRow, g: CompiledWorkflow, stage: Stage, rule: FailureRule, ruleIndex: number, reason: string, output: unknown,
    finish: (o: "succeeded" | "failed" | "timed_out" | "cancelled" | "waiting" | null, e?: { output?: unknown; error?: string; route?: unknown }) => unknown,
  ): boolean {
    const { db } = this.o;
    const target = g.resolve(rule.target!);
    if (target === COMPLETE || !g.stage(target)) { this.hold(job, "BLOCKED", `${stage.id} routes failures to "${rule.target}", which is not one of this workflow's stages`); return false; }
    const { phase, used } = this.fixPhase(job, g, stage);
    const attempts = used + 1;
    const cap = Math.min(this.remediationCap(job), rule.maxCycles ?? SYSTEM_LIMITS.maxFixCycles, SYSTEM_LIMITS.maxFixCycles);
    const history = fixCycleHistory(db, job.id);
    if (attempts > cap) {
      const note = lifetimeNote(history);
      finish(null, { route: { action: "manual", rule: ruleIndex, reason: "fix-cycle budget exhausted" } });
      this.hold(job, "NEEDS_ATTENTION", `remediation attempts exhausted (${cap}) in the ${phase} phase: ${reason}${note ? `\n(${note}: retrying again may not converge)` : ""}`);
      return false;
    }
    db.transaction(() => {
      if (used !== job.remediationAttempts) db.insert(decisions).values({ jobId: job.id, kind: "remediation.budget", decision: "fresh fix-cycle budget for the CI phase", rationale: `the code phase used ${job.remediationAttempts}`, actor: "factory" }).run();
      db.insert(decisions).values({ jobId: job.id, kind: "remediation", decision: `${stage.id} -> ${target} (attempt ${attempts} of ${cap}, ${phase} phase)`, rationale: reason, actor: "factory" }).run();
      finish(null, { route: { action: "goto", to: target, rule: ruleIndex, cycle: attempts, of: cap, phase } });
      this.setStage(job, target, { remediationAttempts: attempts, stageAttempts: 0 });
    });
    return true;
  }

  private notify(job: JobRow, stage: string, reason?: string): void {
    try {
      const fresh = getJob(this.o.db, job.id) ?? job;
      this.o.observer?.onStage(fresh, stage, { reason });
    } catch (e) {
      this.o.logger.error({ jobId: job.id, err: String(e) }, "observer failed"); // never let reporting break orchestration
    }
  }

  private setStage(job: JobRow, stage: string, extra: Partial<typeof jobs.$inferInsert> = {}): void {
    this.o.db.update(jobs).set({ stage, status: "running", updatedAt: this.o.now(), notBefore: null, lastError: null, ...extra }).where(eq(jobs.id, job.id)).run();
    this.notify(job, stage);
  }

  private complete(job: JobRow): void {
    this.o.db.update(jobs).set({ stage: "COMPLETED", status: statusForStage("COMPLETED"), leaseOwner: null, leaseExpiresAt: null, updatedAt: this.o.now() }).where(eq(jobs.id, job.id)).run();
    this.notify(job, "COMPLETED");
  }

  /** Move a job into a held/terminal stage, remembering where it was so it can be resumed. */
  private hold(job: JobRow, stage: string, reason: string): void {
    const { db } = this.o;
    const fresh = getJob(db, job.id) ?? job;
    const from = HELD_STAGES.has(fresh.stage) ? fresh.heldFromStage : fresh.stage;
    db.transaction(() => {
      db.update(jobs).set({ stage, status: statusForStage(stage), heldFromStage: from, lastError: reason, leaseOwner: null, leaseExpiresAt: null, cancelRequested: false, updatedAt: this.o.now() }).where(eq(jobs.id, job.id)).run();
      db.insert(decisions).values({ jobId: job.id, kind: `hold.${stage}`, decision: `${from} -> ${stage}`, rationale: reason, actor: "factory" }).run();
      this.notify(job, stage, reason);
    });
    this.o.logger.warn({ jobId: job.id, from, stage, reason }, "job held");
  }
}

/** The conditions that failed, as one line for the job's history. */
function describeGate(t: import("../workflows/gates.js").GateTrace): string {
  if (t.children) { const bad = t.children.filter((c) => !c.passed); return bad.length ? bad.map(describeGate).join(t.type === "any" ? " and " : "; ") : t.detail; }
  return `${t.type}: ${t.detail}`;
}
