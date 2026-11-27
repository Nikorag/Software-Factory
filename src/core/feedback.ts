import { and, asc, eq, inArray } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs, prFeedback } from "../db/schema.js";
import { getJob, JobError, retryJob, type JobRow } from "./jobs.js";

/**
 * Iterating on a raised pull request. A person asks for a change, on the job page or in a PR comment that starts with
 * `/software-factory` (or `/factory`). The request is queued here; the delivery stages (CI validation, merge validation and the
 * wait for a human merge) pick it up, send the job through REMEDIATION as a finding, and the usual loop re-tests, re-reviews and
 * pushes to the same PR. A human-driven change does not spend an automatic fix cycle: a person decides how many to ask for.
 */

export type FeedbackRow = typeof prFeedback.$inferSelect;
export type FeedbackSource = "dashboard" | "github";

/** The PR comment commands, at the very start of a comment (case-insensitive). */
export const COMMANDS = ["/software-factory", "/factory"] as const;
const COMMAND_RE = /^\s*\/(?:software-factory|factory)\b[ \t]*:?/i;

/** The instruction in a PR comment, or null when the comment is not addressed to the factory. "" = the command with nothing after it. */
export function parseCommand(body: string): string | null {
  const m = COMMAND_RE.exec(body);
  return m ? body.slice(m[0].length).trim() : null;
}

/**
 * Who may instruct the factory from a PR comment. The instruction drives a coding agent on this machine, so only people who can
 * already push to the repository count: GitHub's author_association OWNER, MEMBER or COLLABORATOR.
 */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
export const isTrusted = (association: string | undefined): boolean => TRUSTED.has((association ?? "").toUpperCase());

export const MAX_FEEDBACK = 8000;
/** Stages that look for queued feedback, so a held job resumes into one of them to pick a request up. */
export const FEEDBACK_STAGES = ["CI_VALIDATION", "MERGE_VALIDATION", "MERGING"] as const;

/** Queue a request. Returns null for a PR comment already queued (same external id). */
export function addFeedback(db: FactoryDb, jobId: string, f: { source: FeedbackSource; author: string; body: string; externalId?: string; path?: string | null; line?: number | null; url?: string | null; status?: "pending" | "ignored"; note?: string }): FeedbackRow | null {
  if (f.externalId && db.select({ id: prFeedback.id }).from(prFeedback).where(and(eq(prFeedback.jobId, jobId), eq(prFeedback.externalId, f.externalId))).get()) return null;
  return db.insert(prFeedback).values({ jobId, source: f.source, author: f.author, body: f.body.slice(0, MAX_FEEDBACK), externalId: f.externalId ?? null, path: f.path ?? null, line: f.line ?? null, url: f.url ?? null, status: f.status ?? "pending", note: f.note ?? null }).returning().get();
}

export const listFeedback = (db: FactoryDb, jobId: string): FeedbackRow[] =>
  db.select().from(prFeedback).where(eq(prFeedback.jobId, jobId)).orderBy(asc(prFeedback.id)).all();
const withStatus = (db: FactoryDb, jobId: string, status: FeedbackRow["status"]): FeedbackRow[] =>
  db.select().from(prFeedback).where(and(eq(prFeedback.jobId, jobId), eq(prFeedback.status, status))).orderBy(asc(prFeedback.id)).all();
export const pendingFeedback = (db: FactoryDb, jobId: string) => withStatus(db, jobId, "pending");
export const applyingFeedback = (db: FactoryDb, jobId: string) => withStatus(db, jobId, "applying");

export function setFeedbackStatus(db: FactoryDb, ids: number[], status: FeedbackRow["status"], note?: string | ((id: number) => string | undefined)): void {
  for (const id of ids) {
    const n = typeof note === "function" ? note(id) : note;
    db.update(prFeedback).set({ status, ...(n !== undefined ? { note: n } : {}), updatedAt: new Date() }).where(eq(prFeedback.id, id)).run();
  }
}

/** Anything still queued or in progress will not be applied (the PR was merged or closed first). */
export function dropOpenFeedback(db: FactoryDb, jobId: string, why: string): number {
  const open = db.select({ id: prFeedback.id }).from(prFeedback).where(and(eq(prFeedback.jobId, jobId), inArray(prFeedback.status, ["pending", "applying"]))).all().map((r) => r.id);
  setFeedbackStatus(db, open, "ignored", why);
  return open.length;
}

export const feedbackFindingId = (id: number) => `feedback:${id}`;
export const feedbackIdOf = (findingId: string): number | undefined => { const m = /^feedback:(\d+)$/.exec(findingId); return m ? Number(m[1]) : undefined; };

/** A queued request as a remediation finding. Blocking, so REMEDIATION acts on it; the implementer may still decline, with a reason. */
export function asFinding(f: FeedbackRow) {
  const who = f.source === "github" ? `@${f.author} on the pull request` : "on the factory's job page";
  return {
    id: feedbackFindingId(f.id), severity: "blocker", file: f.path ?? "-", line: f.line ?? null,
    issue: `Change requested by a human reviewer (${who}):\n${f.body}`,
    fix: "Make the change the reviewer asks for, keeping every check passing and the ticket's requirements met. If the request is unclear, unsafe, or would break the ticket, reject it and say why in one or two sentences: your reason is posted back to the reviewer.",
  };
}

/** One quoted line per request, for PR comments. */
export const quote = (f: Pick<FeedbackRow, "body" | "author" | "source">): string => {
  const first = f.body.split("\n").find((l) => l.trim()) ?? "";
  return `> ${first.length > 140 ? `${first.slice(0, 140)}…` : first}${f.body.includes("\n") ? " …" : ""}\n> — ${f.source === "github" ? `@${f.author}` : "via the factory's job page"}`;
};

const OPEN_PR = /\/pull\/\d+|\/pull-requests\/\d+/;
const CLOSED = new Set(["done", "cancelled"]);

/**
 * "Request changes" from the job page. The job must have a pull request and not be finished. A job waiting between polls is
 * woken now; a held job (needs attention, failed, blocked) is resumed, at a delivery stage, so it picks the request up.
 */
export function requestChanges(db: FactoryDb, id: string, text: string, actor: string): { job: JobRow; feedback: FeedbackRow } {
  const body = text.trim();
  if (!body) throw new JobError("describe the change you want");
  if (body.length > MAX_FEEDBACK) throw new JobError(`too long (max ${MAX_FEEDBACK} characters)`);
  const job = getJob(db, id);
  if (!job) throw new JobError(`no such job ${id}`);
  if (!job.prUrl || !OPEN_PR.test(job.prUrl)) throw new JobError("this job has no pull request yet: changes can be requested once the PR is raised");
  if (CLOSED.has(job.status)) throw new JobError(`the job is ${job.status === "done" ? "finished (its PR was merged)" : "cancelled"}: start a new ticket for further changes`);
  const feedback = addFeedback(db, id, { source: "dashboard", author: actor, body })!;
  db.insert(decisions).values({ jobId: id, kind: "feedback.requested", decision: `change requested on the job page (#${feedback.id})`, rationale: body.slice(0, 1500), actor }).run();
  const held = ["BLOCKED", "FAILED", "NEEDS_ATTENTION", "PAUSED"].includes(job.stage);
  if (held && job.stage !== "PAUSED") {
    const from = job.heldFromStage ?? "";
    const resumeAt = (FEEDBACK_STAGES as readonly string[]).includes(from) ? undefined : "CI_VALIDATION";
    return { job: retryJob(db, id, actor, resumeAt as "CI_VALIDATION" | undefined), feedback };
  }
  // Waiting between polls (e.g. for a human merge, every few minutes): look now.
  if (job.status === "queued" && job.notBefore) db.update(jobs).set({ notBefore: null, updatedAt: new Date() }).where(eq(jobs.id, id)).run();
  return { job: getJob(db, id)!, feedback };
}
