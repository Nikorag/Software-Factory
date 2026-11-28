import { and, asc, eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs } from "../db/schema.js";
import type { GatePoint, PlanningMode, StageName } from "../config/schema.js";
import { MAX_FEEDBACK } from "./feedback.js";
import { getJob, JobError, type JobRow } from "./jobs.js";
import { nextStage } from "./workflow.js";

/**
 * Human gates: a project can make a job stop after a stage has succeeded and wait for a person, who either confirms (the job goes on to
 * the next stage) or asks for changes (the gated stage runs again with the note as guidance). Held like the other waits: the job sits in
 * AWAITING_CONFIRMATION with `heldFromStage` = the gated stage, and the choice is recorded as a decision (as approvals do).
 */

/** The marker that starts a held job's reason while it waits at a gate (so a decision knows to resume it). */
export const GATE_WAITING = "Waiting for your confirmation:";

const GATE_NAMES: Record<GatePoint, string> = { REQUIREMENTS_ANALYSIS: "generated prompt" };
export const gateName = (g: string): string => GATE_NAMES[g as GatePoint] ?? g;

export const gateReason = (g: GatePoint): string =>
  `${GATE_WAITING} the ${gateName(g)} gate. Review the output on the job page, then confirm to continue or ask for changes to run the step again.`;

/** Whether `stage` is a gate for this project in this planning mode. The prompt gate exists only in haiku_prompt mode. */
export const isGated = (gates: readonly string[] | undefined, stage: StageName, mode: PlanningMode): boolean =>
  Boolean(gates?.includes(stage)) && stage === "REQUIREMENTS_ANALYSIS" && mode === "haiku_prompt";

const atGate = (job: JobRow): job is JobRow & { heldFromStage: string } =>
  job.stage === "AWAITING_CONFIRMATION" && (job.lastError ?? "").startsWith(GATE_WAITING) && Boolean(job.heldFromStage);

const RETURNED_AT = "returned at ";

/** What people asked for when sending `stage` back, oldest first. The stage's agent is given these as guidance. */
export function gateNotes(db: FactoryDb, jobId: string, stage: string): string[] {
  return db.select().from(decisions).where(and(eq(decisions.jobId, jobId), eq(decisions.kind, "gate.returned"))).orderBy(asc(decisions.id)).all()
    .filter((r) => r.decision === `${RETURNED_AT}${stage}`).map((r) => r.rationale ?? "").filter(Boolean);
}

function resume(db: FactoryDb, job: JobRow, to: StageName, kind: "gate.confirmed" | "gate.returned", decision: string, rationale: string | null, actor: string): JobRow {
  return db.transaction((tx) => {
    // Counters are left alone: neither choice spends a fix cycle or the remediation cap.
    tx.update(jobs).set({ stage: to, status: "queued", heldFromStage: null, stageAttempts: 0, lastError: null, notBefore: null, updatedAt: new Date() }).where(and(eq(jobs.id, job.id), eq(jobs.stage, "AWAITING_CONFIRMATION"))).run();
    tx.insert(decisions).values({ jobId: job.id, kind, decision, rationale, actor }).run();
    return tx.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
  });
}

function waitingJob(db: FactoryDb, id: string): JobRow & { heldFromStage: string } {
  const job = getJob(db, id);
  if (!job) throw new JobError(`no such job ${id}`);
  if (!atGate(job)) throw new JobError("this job is not waiting at a gate");
  return job;
}

/** Continue at the stage after the gated one. */
export function confirmGate(db: FactoryDb, id: string, actor: string, mode: PlanningMode): JobRow {
  const job = waitingJob(db, id);
  const next = nextStage(job.heldFromStage as StageName, mode);
  if (!next) throw new JobError(`no stage follows ${job.heldFromStage}`);
  return resume(db, job, next, "gate.confirmed", `confirmed ${gateName(job.heldFromStage)} gate`, null, actor);
}

/** Run the gated stage again; the note is kept in the decisions and passed to the stage as guidance. */
export function returnGate(db: FactoryDb, id: string, note: string, actor: string): JobRow {
  const text = note.trim();
  if (!text) throw new JobError("say what should change: a note is required");
  if (text.length > MAX_FEEDBACK) throw new JobError(`note too long (max ${MAX_FEEDBACK} characters)`);
  const job = waitingJob(db, id);
  return resume(db, job, job.heldFromStage as StageName, "gate.returned", `${RETURNED_AT}${job.heldFromStage}`, text, actor);
}
