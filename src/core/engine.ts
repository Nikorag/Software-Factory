import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { StageName, LoadedConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs, stageExecutions } from "../db/schema.js";
import { getControl } from "./control.js";
import { claimNext, getJob, recoverExpired, renewLease, runningCount, type JobRow } from "./jobs.js";
import { isMutating, nextStage, remediationTarget, statusForStage } from "./workflow.js";

export interface StageContext {
  job: JobRow;
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

/** Called synchronously (inside the stage-change transaction where one exists) so side-effect records are atomic with it. */
export interface EngineObserver {
  onStage(job: JobRow, stage: StageName, detail?: { reason?: string }): void;
}

export interface EngineOptions {
  observer?: EngineObserver;
  db: FactoryDb;
  logger: Logger;
  config: Pick<LoadedConfig, "factory" | "workflows"> & Partial<Pick<LoadedConfig, "projects">>;
  handlers: HandlerRegistry;
  owner?: string;
  now?: () => Date;
  leaseMs?: number;
  heartbeatMs?: number;
  backoffBaseMs?: number;
}

type AbortReason = "timeout" | "cancel" | "estop" | "lease-lost" | "shutdown";
const HELD_STAGES = new Set<StageName>(["BLOCKED", "FAILED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION", "COMPLETED"]);

export class Engine {
  readonly owner: string;
  /** Aborters for stages running right now, so a stop or shutdown reaches the agent immediately, not at the next heartbeat. */
  private readonly active = new Map<string, (r: AbortReason) => void>();
  private readonly o: Required<Omit<EngineOptions, "owner" | "observer">> & { observer?: EngineObserver };

  constructor(opts: EngineOptions) {
    this.owner = opts.owner ?? `factory-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.o = { now: () => new Date(), leaseMs: 60_000, heartbeatMs: 15_000, backoffBaseMs: 5_000, ...opts };
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
    recoverExpired(db, this.o.now());
    const ctl = getControl(db);
    if (ctl.paused || ctl.emergencyStop) return 0;
    this.resumePaused();
    let started = 0;
    while (this.inflight.size < this.o.config.factory.maxConcurrentJobs) {
      const job = claimNext(db, this.owner, this.o.now(), this.o.leaseMs, (j) => runningCount(db, j.projectId) < this.projectCap(j.projectId));
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
      db.update(jobs).set({ stage: (j.heldFromStage ?? "DISCOVERED") as StageName, heldFromStage: null, status: "queued", updatedAt: this.o.now() }).where(eq(jobs.id, j.id)).run();
    }
  }

  /** Runs a claimed job stage by stage until it completes, holds, is rescheduled, or loses its lease. */
  async runJob(jobId: string): Promise<void> {
    const { db } = this.o;
    const claimed = getJob(db, jobId);
    if (claimed) this.notify(claimed, claimed.stage as StageName); // re-assert external status after retry/recovery (observer dedupes)
    for (;;) {
      const job = getJob(db, jobId);
      if (!job || job.status !== "running" || job.leaseOwner !== this.owner) return;
      if (job.cancelRequested) return this.hold(job, "CANCELLED", "cancelled by request");
      const ctl = getControl(db);
      if (ctl.paused || ctl.emergencyStop) return this.hold(job, "PAUSED", ctl.reason ?? "factory paused");
      if (HELD_STAGES.has(job.stage as StageName)) return; // defensive: nothing to execute
      const keepGoing = await this.runStage(job, job.stage as StageName);
      if (!keepGoing) return;
    }
  }

  private policy(job: JobRow, stage: StageName) {
    const w = this.o.config.workflows;
    return { ...w.defaults, ...(w.workflows[job.workflow]?.stages[stage] ?? {}) };
  }

  /** Executes one stage attempt. Returns true if the job is still ours and runnable immediately. */
  private async runStage(job: JobRow, stage: StageName): Promise<boolean> {
    const { db, logger } = this.o;
    const policy = this.policy(job, stage);
    const dryRun = job.dryRun || this.o.config.factory.dryRun;
    const attempt = (db.select({ n: count() }).from(stageExecutions).where(and(eq(stageExecutions.jobId, job.id), eq(stageExecutions.stage, stage))).get()?.n ?? 0) + 1;
    const key = `${job.id}:${stage}:${attempt}`;
    const execId = db.insert(stageExecutions).values({ jobId: job.id, stage, attempt, outcome: "started", idempotencyKey: key, startedAt: this.o.now() }).returning({ id: stageExecutions.id }).get().id;
    const log = logger.child({ jobId: job.id, stage, attempt });

    const finish = (outcome: "succeeded" | "failed" | "timed_out" | "cancelled" | "waiting", extra: { output?: unknown; error?: string } = {}) =>
      db.update(stageExecutions).set({ outcome, outputJson: extra.output === undefined ? null : JSON.stringify(extra.output), error: extra.error ?? null, finishedAt: this.o.now() }).where(eq(stageExecutions.id, execId)).run();

    // Dry run: record the intended operation, never invoke side-effecting stages.
    if (dryRun && isMutating(stage)) {
      return this.apply(job, stage, { kind: "ok", output: { dryRun: true, wouldExecute: stage } }, finish, "dry-run: skipped mutating stage");
    }
    const handler = this.o.handlers[stage];
    if (!handler) {
      finish("failed", { error: "no handler registered" });
      this.hold(job, "BLOCKED", `no handler registered for ${stage}`);
      return false;
    }

    const ac = new AbortController();
    let reason: AbortReason | undefined;
    const abort = (r: AbortReason) => { if (!reason) { reason = r; ac.abort(r); } };
    this.active.set(job.id, abort);
    const timer = setTimeout(() => abort("timeout"), policy.timeoutSeconds * 1000);
    const beat = setInterval(() => {
      if (!renewLease(db, job.id, this.owner, this.o.now(), this.o.leaseMs)) return abort("lease-lost");
      const fresh = getJob(db, job.id);
      if (fresh?.cancelRequested) abort("cancel");
      if (getControl(db).emergencyStop) abort("estop");
    }, this.o.heartbeatMs);

    let result: StageResult;
    try {
      const aborted = new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error(`aborted: ${reason}`)), { once: true }));
      aborted.catch(() => {}); // avoid unhandled rejection when the handler wins the race
      result = await Promise.race([handler({ job, attempt, executionId: execId, signal: ac.signal, dryRun, logger: log }), aborted]);
    } catch (e) {
      result = { kind: "retry", reason: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
      clearInterval(beat);
      this.active.delete(job.id);
    }

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
      finish("timed_out", { error: `exceeded ${policy.timeoutSeconds}s` });
      return this.afterFailure(job, stage, `timed out after ${policy.timeoutSeconds}s`, policy.maxRetries);
    }
    return this.apply(job, stage, result, finish, undefined, policy.maxRetries);
  }

  private apply(
    job: JobRow, stage: StageName, result: StageResult,
    finish: (o: "succeeded" | "failed" | "timed_out" | "cancelled" | "waiting", e?: { output?: unknown; error?: string }) => unknown,
    note?: string, maxRetries = 0,
  ): boolean {
    const { db } = this.o;
    switch (result.kind) {
      case "ok": {
        const next = nextStage(stage);
        if (!next) throw new Error(`no successor for ${stage}`);
        db.transaction(() => {
          finish("succeeded", { output: result.output });
          if (note) db.insert(decisions).values({ jobId: job.id, kind: "dry-run", decision: `${stage} skipped`, rationale: note, actor: "factory" }).run();
          if (next === "COMPLETED") this.complete(job);
          else this.setStage(job, next, { stageAttempts: 0 });
        });
        return next !== "COMPLETED";
      }
      case "remediate": {
        const target = remediationTarget(stage);
        if (!target) { finish("failed", { error: `${stage} cannot remediate` }); this.hold(job, "FAILED", `${stage} reported findings but has no remediation path`); return false; }
        const attempts = job.remediationAttempts + 1;
        finish("succeeded", { output: { remediate: result.reason, details: result.output } });
        const cap = this.remediationCap(job);
        if (attempts > cap) {
          this.hold(job, "NEEDS_ATTENTION", `remediation attempts exhausted (${cap}): ${result.reason}`);
          return false;
        }
        db.transaction(() => {
          db.insert(decisions).values({ jobId: job.id, kind: "remediation", decision: `${stage} -> ${target} (attempt ${attempts})`, rationale: result.reason, actor: "factory" }).run();
          this.setStage(job, target, { remediationAttempts: attempts, stageAttempts: 0 });
        });
        return true;
      }
      case "wait": {
        // Not a failure: release the lease and come back later. The stage does not advance and no attempt budget is spent.
        finish("waiting", { output: { reason: result.reason, delayMs: result.delayMs } });
        db.update(jobs).set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, notBefore: new Date(this.o.now().getTime() + result.delayMs), lastError: null, updatedAt: this.o.now() }).where(eq(jobs.id, job.id)).run();
        return false;
      }
      case "retry":
        finish("failed", { error: result.reason });
        return this.afterFailure(job, stage, result.reason, maxRetries);
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

  /** Retry with exponential backoff, or fail once retries are exhausted. Never loops forever. */
  private afterFailure(job: JobRow, stage: StageName, reason: string, maxRetries: number): boolean {
    const { db } = this.o;
    const failures = job.stageAttempts + 1;
    if (failures > maxRetries) { this.hold(job, "FAILED", `${stage} failed after ${failures} attempt(s): ${reason}`); return false; }
    const notBefore = new Date(this.o.now().getTime() + this.o.backoffBaseMs * 2 ** (failures - 1));
    db.update(jobs).set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, stageAttempts: failures, notBefore, lastError: reason, updatedAt: this.o.now() }).where(eq(jobs.id, job.id)).run();
    return false; // rescheduled; scheduler will reclaim after backoff
  }

  private notify(job: JobRow, stage: StageName, reason?: string): void {
    try {
      const fresh = getJob(this.o.db, job.id) ?? job;
      this.o.observer?.onStage(fresh, stage, { reason });
    } catch (e) {
      this.o.logger.error({ jobId: job.id, err: String(e) }, "observer failed"); // never let reporting break orchestration
    }
  }

  private setStage(job: JobRow, stage: StageName, extra: Partial<typeof jobs.$inferInsert> = {}): void {
    this.o.db.update(jobs).set({ stage, status: "running", updatedAt: this.o.now(), notBefore: null, lastError: null, ...extra }).where(eq(jobs.id, job.id)).run();
    this.notify(job, stage);
  }

  private complete(job: JobRow): void {
    this.o.db.update(jobs).set({ stage: "COMPLETED", status: statusForStage("COMPLETED"), leaseOwner: null, leaseExpiresAt: null, updatedAt: this.o.now() }).where(eq(jobs.id, job.id)).run();
    this.notify(job, "COMPLETED");
  }

  /** Move a job into a held/terminal stage, remembering where it was so it can be resumed. */
  private hold(job: JobRow, stage: StageName, reason: string): void {
    const { db } = this.o;
    const fresh = getJob(db, job.id) ?? job;
    const from = HELD_STAGES.has(fresh.stage as StageName) ? fresh.heldFromStage : fresh.stage;
    db.transaction(() => {
      db.update(jobs).set({ stage, status: statusForStage(stage), heldFromStage: from, lastError: reason, leaseOwner: null, leaseExpiresAt: null, cancelRequested: false, updatedAt: this.o.now() }).where(eq(jobs.id, job.id)).run();
      db.insert(decisions).values({ jobId: job.id, kind: `hold.${stage}`, decision: `${from} -> ${stage}`, rationale: reason, actor: "factory" }).run();
      this.notify(job, stage, reason);
    });
    this.o.logger.warn({ jobId: job.id, from, stage, reason }, "job held");
  }
}
