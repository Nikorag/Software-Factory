import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { decisions, permissionRequests } from "../db/schema.js";
import { answerJob, getJob, JobError, type JobRow } from "./jobs.js";

/**
 * Asking a person instead of failing. Agents run headless with every permission decided up front, so an agent that needs something
 * outside its boundary (live: KPS-19's ticket said to port code from a folder outside the worktree) is simply refused, then reports
 * "changed nothing", and the job fails. Instead, each such refusal becomes a request on the job page with Approve / Deny; the step
 * stops for it, and once nothing is undecided it resumes, in the same agent session, with what was allowed (for that job only).
 *
 * What can be asked for today: reading a folder outside the worktree (Read, Grep, Glob; approving grants read-only access to the
 * folder, verified live: writes there stay refused). Some places can never be granted, whoever asks: see `neverGrantable`.
 */

export type PermissionRow = typeof permissionRequests.$inferSelect;
export interface Denial { tool: string; input: string }

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Credential stores and the factory's own data. Relative to the home folder. */
const SENSITIVE = [".ssh", ".aws", ".gnupg", ".claude", ".config/gh", ".config/gcloud", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".software-factory", "Library/Keychains", "Library/Application Support/com.apple.TCC"];

/** Why a path can never be granted, or null. Covers the path, anything it contains, and its real (symlink-resolved) location. */
export function neverGrantable(path: string, home = homedir()): string | null {
  const h = real(home);
  for (const p of new Set([resolve(path), real(path)])) {
    if (p === sep) return "the whole disk";
    if (under(h, p)) return p === h ? "your whole home folder" : "a folder that contains your home folder";
    for (const s of SENSITIVE.map((x) => join(h, x))) {
      if (under(p, s)) return `${s.replace(h, "~")} holds credentials or the factory's own data`;
      if (under(s, p)) return `it contains ${s.replace(h, "~")}, which holds credentials or the factory's own data`;
    }
  }
  return null;
}

/**
 * The read a refusal asked for, if it is one a person may approve: an absolute path outside the worktree. Approving a file grants its
 * folder (the agent nearly always needs the files beside it), unless that folder may not be granted, then just the file.
 */
export function readRequest(d: Denial, worktree: string, home = homedir()): { path: string; grantPath: string; refused?: string } | null {
  if (!["Read", "Grep", "Glob"].includes(d.tool)) return null;
  let input: Record<string, unknown>;
  try { input = JSON.parse(d.input) as Record<string, unknown>; } catch { return null; }
  const raw = (d.tool === "Read" ? input.file_path : input.path) as unknown;
  if (typeof raw !== "string" || !isAbsolute(raw)) return null;
  const path = resolve(raw);
  if ([worktree, real(worktree)].some((w) => under(path, w) || under(real(path), w))) return null; // inside: not this kind of request
  let isDir = d.tool !== "Read";
  try { isDir = statSync(path).isDirectory(); } catch { /* missing: go by the tool */ }
  const folder = isDir ? path : dirname(path);
  if (!neverGrantable(folder, home)) return { path, grantPath: `${folder}/**` };
  const why = neverGrantable(path, home);
  if (!isDir && !why) return { path, grantPath: path }; // the folder may not be shared, the file alone may
  return { path, grantPath: isDir ? `${folder}/**` : path, refused: why ?? neverGrantable(folder, home)! };
}

/**
 * Records the approvable refusals of one agent run as requests (each distinct request once per job; one already decided is not
 * asked again). Returns the requests that are new and waiting for a person.
 */
export function recordRequests(db: FactoryDb, jobId: string, stage: string, denials: Denial[], worktree: string, home = homedir()): PermissionRow[] {
  const fresh: PermissionRow[] = [];
  for (const d of denials) {
    const r = readRequest(d, worktree, home);
    if (!r) continue;
    const seen = db.select({ id: permissionRequests.id }).from(permissionRequests).where(and(eq(permissionRequests.jobId, jobId), eq(permissionRequests.kind, "read"), eq(permissionRequests.grantPath, r.grantPath))).get();
    if (seen) continue;
    const row = db.insert(permissionRequests).values({ jobId, stage, tool: d.tool, kind: "read", path: r.path, grantPath: r.grantPath, status: r.refused ? "refused" : "pending", reason: r.refused ? `Never granted: ${r.refused}.` : null }).returning().get();
    if (row.status === "pending") fresh.push(row);
  }
  return fresh;
}

export const listRequests = (db: FactoryDb, jobId: string): PermissionRow[] =>
  db.select().from(permissionRequests).where(eq(permissionRequests.jobId, jobId)).orderBy(asc(permissionRequests.id)).all();

/** Read grants a person approved for this job (Claude Code rule paths), for every later agent run of the job. */
export const readGrants = (db: FactoryDb, jobId: string): string[] =>
  listRequests(db, jobId).filter((r) => r.status === "approved" && r.kind === "read").map((r) => r.grantPath);

/** The marker that starts a held job's reason while it waits for approvals (so a decision knows to resume it). */
export const WAITING = "Waiting for your approval:";
export const waitingReason = (rows: PermissionRow[]) =>
  `${WAITING} the agent was refused something it needs.\n${rows.map((r) => `- ${r.tool} ${r.path}`).join("\n")}\nApprove or deny each request on the job page; the step resumes once all are decided.`;

const shown = (g: string) => g.replace(/\/\*\*$/, "/");

/**
 * Approve or deny one request. When that was the last undecided one and the job is waiting for them, the job resumes where it
 * stopped, and the agent is told what changed (recorded like an answer, so every later step of the job knows it too).
 */
export function decideRequest(db: FactoryDb, jobId: string, requestId: number, decision: "approve" | "deny", actor: string): { job: JobRow; request: PermissionRow; resumed: boolean } {
  const req = db.select().from(permissionRequests).where(and(eq(permissionRequests.id, requestId), eq(permissionRequests.jobId, jobId))).get();
  if (!req) throw new JobError("no such request for this job");
  if (req.status === "refused") throw new JobError(`this can never be granted: ${req.reason ?? ""}`);
  if (req.status !== "pending") throw new JobError(`already ${req.status}`);
  if (decision === "approve" && req.kind === "read") {
    const why = neverGrantable(req.grantPath.replace(/\/\*\*$/, ""));
    if (why) throw new JobError(`this can never be granted: ${why}`); // re-checked now: a symlink may have changed since it was asked
  }
  db.update(permissionRequests).set({ status: decision === "approve" ? "approved" : "denied", decidedBy: actor, decidedAt: new Date() }).where(eq(permissionRequests.id, req.id)).run();
  db.insert(decisions).values({ jobId, kind: `permission.${decision === "approve" ? "approved" : "denied"}`, decision: `${req.tool} ${req.path}`, rationale: decision === "approve" ? `read-only access to ${shown(req.grantPath)} for this job` : "the agent carries on without it", actor }).run();
  const job = getJob(db, jobId);
  if (!job) throw new JobError(`no such job ${jobId}`);
  const rows = listRequests(db, jobId);
  const waiting = job.stage === "NEEDS_ATTENTION" && (job.lastError ?? "").startsWith(WAITING);
  if (!waiting || rows.some((r) => r.status === "pending")) return { job, request: { ...req, status: decision === "approve" ? "approved" : "denied" }, resumed: false };
  const heldAt = job.updatedAt?.getTime() ?? 0; // earlier rounds' decisions are already in the agent's history
  const asked = rows.filter((r) => (r.status === "approved" || r.status === "denied") && (r.decidedAt?.getTime() ?? 0) >= heldAt);
  const note = [
    ...asked.filter((r) => r.status === "approved").map((r) => `You may now read ${shown(r.grantPath)} (read-only: you still cannot write there). Use it.`),
    ...asked.filter((r) => r.status === "denied").map((r) => `A person denied reading ${r.path}. Do not try again: carry on without it, or say exactly what you need instead.`),
  ].join("\n");
  const resumed = answerJob(db, jobId, note, actor);
  return { job: resumed, request: { ...req, status: decision === "approve" ? "approved" : "denied" }, resumed: true };
}
