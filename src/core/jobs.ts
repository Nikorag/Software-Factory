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
  input: { projectId: string; externalId: string; externalKey: string; workflow?: string; autonomous?: boolean; dryRun?: boolean; manual?: boolean },
): { job: JobRow; created: boolean } {
  const existing = db.select().from(jobs)
    .where(and(eq(jobs.projectId, input.projectId), eq(jobs.externalId, input.externalId), inArray(jobs.status, [...ACTIVE]))).get();
  if (existing) return { job: existing, created: false };
  const id = randomUUID();
  db.insert(jobs).values({ id, ...input, autonomous: input.autonomous ?? false, dryRun: input.dryRun ?? false, manual: input.manual ?? false }).run();
  return { job: getJob(db, id)!, created: true };
}

/**
 * Atomically claim the oldest runnable job that `accept` allows (e.g. its project has a free slot). Returns undefined if none, or if
 * every candidate was taken by another process first.
 */
export function claimNext(db: FactoryDb, owner: string, now: Date, leaseMs: number, accept?: (job: JobRow) => boolean): JobRow | undefined {
  const candidates = db.select().from(jobs)
    .where(and(eq(jobs.status, "queued"), or(isNull(jobs.notBefore), lte(jobs.notBefore, now))))
    .orderBy(asc(jobs.createdAt)).limit(100).all();
  for (const candidate of candidates) {
    if (accept && !accept(candidate)) continue;
    const res = db.update(jobs)
      .set({ status: "running", leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued"))).run();
    if (res.changes === 1) return getJob(db, candidate.id);
  }
  return undefined;
}

/** How many jobs of a project are executing right now. */
export function runningCount(db: FactoryDb, projectId: string): number {
  return db.select().from(jobs).where(and(eq(jobs.projectId, projectId), eq(jobs.status, "running"))).all().length;
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
export function retryJob(db: FactoryDb, id: string, actor: string, resumeAt?: StageName): JobRow {
  return db.transaction((tx) => {
    const job = tx.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) throw new JobError(`no such job ${id}`);
    const held = ["BLOCKED", "FAILED", "NEEDS_ATTENTION", "PAUSED", "CANCELLED"].includes(job.stage);
    if (!held) throw new JobError(`job is not retryable (stage ${job.stage}, status ${job.status})`);
    const resume = resumeAt ?? ((job.heldFromStage ?? "DISCOVERED") as StageName);
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

/**
 * A human's answer to a held job. Recorded durably, then the job resumes. Answers to the specification's own
 * open questions resume at remediation (so the spec-writer actually applies them); re-validating the same
 * spec would just block on the same questions again.
 */
export function answerJob(db: FactoryDb, id: string, text: string, actor: string): JobRow {
  const answer = text.trim();
  if (!answer) throw new JobError("an answer cannot be empty");
  if (answer.length > 8000) throw new JobError("answer too long (max 8000 characters)");
  const job = getJob(db, id);
  if (!job) throw new JobError(`no such job ${id}`);
  const resumeAt = job.heldFromStage === "SPECIFICATION_VALIDATION" ? "SPECIFICATION_REMEDIATION" as StageName : undefined;
  const retried = retryJob(db, id, actor, resumeAt);
  db.insert(decisions).values({ jobId: id, kind: "human.answer", decision: `answered while held at ${job.heldFromStage ?? job.stage}`, rationale: answer, actor }).run();
  return retried;
}

export function humanAnswers(db: FactoryDb, jobId: string): string[] {
  return db.select().from(decisions).where(and(eq(decisions.jobId, jobId), eq(decisions.kind, "human.answer"))).orderBy(asc(decisions.id)).all().map((r) => r.rationale ?? "");
}
