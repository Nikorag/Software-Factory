import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, lt, or } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs, stageExecutions } from "../db/schema.js";
import type { StageName } from "../config/schema.js";

export type JobRow = typeof jobs.$inferSelect;
const ACTIVE = ["queued", "running", "waiting"] as const;

export class JobError extends Error {}

export function getJob(db: FactoryDb, id: string): JobRow | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function listJobs(db: FactoryDb, status?: JobRow["status"]): JobRow[] {
  const q = db.select().from(jobs);
  return (status ? q.where(eq(jobs.status, status)) : q).orderBy(asc(jobs.createdAt)).all();
}

/**
 * Idempotent: if the issue already has an active job, returns it instead of creating another.
 * (The partial unique index backs this up against races between processes.)
 */
export function enqueue(
  db: FactoryDb,
  input: { projectId: string; externalId: string; externalKey: string; workflow?: string; dryRun?: boolean },
): { job: JobRow; created: boolean } {
  const existing = db.select().from(jobs)
    .where(and(eq(jobs.projectId, input.projectId), eq(jobs.externalId, input.externalId), inArray(jobs.status, [...ACTIVE]))).get();
  if (existing) return { job: existing, created: false };
  const id = randomUUID();
  db.insert(jobs).values({ id, ...input, dryRun: input.dryRun ?? false }).run();
  return { job: getJob(db, id)!, created: true };
}

/** Atomically claim the oldest runnable job. Returns undefined if none, or if another process won the race. */
export function claimNext(db: FactoryDb, owner: string, now: Date, leaseMs: number): JobRow | undefined {
  const candidate = db.select().from(jobs)
    .where(and(eq(jobs.status, "queued"), or(isNull(jobs.notBefore), lte(jobs.notBefore, now))))
    .orderBy(asc(jobs.createdAt)).limit(1).get();
  if (!candidate) return undefined;
  const res = db.update(jobs)
    .set({ status: "running", leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued"))).run();
  return res.changes === 1 ? getJob(db, candidate.id) : undefined;
}

/** Renew a lease. Returns false if this owner no longer holds it. */
export function renewLease(db: FactoryDb, id: string, owner: string, now: Date, leaseMs: number): boolean {
  return db.update(jobs).set({ leaseExpiresAt: new Date(now.getTime() + leaseMs) })
    .where(and(eq(jobs.id, id), eq(jobs.leaseOwner, owner), eq(jobs.status, "running"))).run().changes === 1;
}

/**
 * Crash recovery: running jobs whose lease expired are re-queued at their current stage, and their
 * dangling "started" executions are closed as interrupted. Handlers must be idempotent on replay.
 */
export function recoverExpired(db: FactoryDb, now: Date): string[] {
  return db.transaction((tx) => {
    const stale = tx.select().from(jobs).where(and(eq(jobs.status, "running"), lt(jobs.leaseExpiresAt, now))).all();
    for (const j of stale) {
      tx.update(stageExecutions).set({ outcome: "failed", error: "interrupted (process crash or lease expiry)", finishedAt: now })
        .where(and(eq(stageExecutions.jobId, j.id), eq(stageExecutions.outcome, "started"))).run();
      tx.update(jobs).set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(eq(jobs.id, j.id)).run();
      tx.insert(decisions).values({ jobId: j.id, kind: "recovery", decision: `requeued at ${j.stage}`, rationale: "lease expired", actor: "factory" }).run();
    }
    return stale.map((j) => j.id);
  });
}

/** Request cancellation. Queued/waiting jobs cancel immediately; running jobs are signalled and stop at the next check. */
export function cancelJob(db: FactoryDb, id: string, actor: string): JobRow {
  return db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw new JobError(`no such job ${id}`);
    if (["done", "failed", "cancelled"].includes(job.status)) throw new JobError(`job already ${job.status}`);
    if (job.status === "running") tx.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, id)).run();
    else tx.update(jobs).set({ status: "cancelled", stage: "CANCELLED", heldFromStage: job.stage, updatedAt: new Date() }).where(eq(jobs.id, id)).run();
    tx.insert(decisions).values({ jobId: id, kind: "job.cancel", decision: "cancel requested", actor }).run();
    return tx.select().from(jobs).where(eq(jobs.id, id)).get()!;
  });
}

/** Manually retry a failed/held job from the stage it stopped at, with fresh attempt counters. */
export function retryJob(db: FactoryDb, id: string, actor: string): JobRow {
  return db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw new JobError(`no such job ${id}`);
    const held = ["BLOCKED", "FAILED", "NEEDS_ATTENTION", "PAUSED", "CANCELLED"].includes(job.stage);
    if (!held) throw new JobError(`job is not retryable (stage ${job.stage}, status ${job.status})`);
    const resume = (job.heldFromStage ?? "DISCOVERED") as StageName;
    try {
      tx.update(jobs).set({ stage: resume, status: "queued", heldFromStage: null, stageAttempts: 0, remediationAttempts: 0, cancelRequested: false, lastError: null, notBefore: null, updatedAt: new Date() })
        .where(eq(jobs.id, id)).run();
    } catch (e) {
      throw new JobError(`cannot retry: another active job exists for this issue (${(e as Error).message})`);
    }
    tx.insert(decisions).values({ jobId: id, kind: "job.retry", decision: `resume at ${resume}`, actor }).run();
    return tx.select().from(jobs).where(eq(jobs.id, id)).get()!;
  });
}
