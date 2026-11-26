import { and, count, eq, gt, like, max } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { decisions } from "../db/schema.js";

/**
 * Fix cycles are budgeted per phase: the specification, the code (review fixes before the PR) and CI (fixes after the PR is
 * raised). `jobs.remediationAttempts` holds the CURRENT phase's count, and is reset when a job moves into the next phase.
 * The lifetime count comes from the `remediation` decisions, which are never reset (not even by a manual retry).
 */
export type FixPhase = "specification" | "code" | "CI";

/** Lifetime fix cycles and manual retries of a job, from its decisions. */
export function fixCycleHistory(db: Pick<FactoryDb, "select">, jobId: string): { total: number; retries: number } {
  const n = (kind: string) => db.select({ n: count() }).from(decisions).where(and(eq(decisions.jobId, jobId), eq(decisions.kind, kind))).get()?.n ?? 0;
  return { total: n("remediation"), retries: n("job.retry") };
}

/** Whether CI has already sent this job back for a fix since its last manual retry (i.e. it is in its CI phase). */
export function inCiPhase(db: FactoryDb, jobId: string): boolean {
  const lastRetry = db.select({ id: max(decisions.id) }).from(decisions).where(and(eq(decisions.jobId, jobId), eq(decisions.kind, "job.retry"))).get()?.id ?? 0;
  return Boolean(db.select({ id: decisions.id }).from(decisions)
    .where(and(eq(decisions.jobId, jobId), eq(decisions.kind, "remediation"), like(decisions.decision, "CI_VALIDATION ->%"), gt(decisions.id, lastRetry))).get());
}

/** Human-readable note on a job's lifetime fix cycles, or "" when nothing has been retried yet. */
export function lifetimeNote(h: { total: number; retries: number }): string {
  if (h.retries === 0) return "";
  return `${h.total} fix cycle(s) in total across ${h.retries} manual retr${h.retries === 1 ? "y" : "ies"}`;
}
