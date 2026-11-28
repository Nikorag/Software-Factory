import { and, asc, eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs, type LessonKind } from "../db/schema.js";
import { fixCycles, sameFinding, type CycleFinding } from "../implement/history.js";
import { proposeLesson } from "./store.js";

/**
 * Distillation (ADR 0017): turns what the factory already recorded into `proposed` lessons when a job completes. The candidate text is
 * built deterministically, so this works with no model; an optional `polish` may reword it, and if that fails or is absent the
 * deterministic text is stored. Distillation never writes an active lesson, and refused (secret-looking) text is dropped.
 */

export interface Candidate { text: string; kind: LessonKind; source: string; sourceJobId: string }
export type Polish = (text: string, kind: LessonKind) => Promise<string | undefined>;

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const firstLine = (s = "") => s.split("\n").find((l) => l.trim())?.trim() ?? "";
/** Ids whose findings say nothing durable about the project: a criterion belongs to one ticket; checks are source 3. */
const PER_TICKET = /^(criterion|check):/;

/** Source 1: a finding accepted and fixed in two or more different jobs of the project, one of them this one. */
function recurringFindings(db: FactoryDb, projectId: string, jobId: string): Candidate[] {
  interface Cluster { rep: CycleFinding; jobs: Set<string>; mine?: number }
  const clusters: Cluster[] = [];
  for (const j of db.select({ id: jobs.id }).from(jobs).where(eq(jobs.projectId, projectId)).orderBy(asc(jobs.createdAt)).all()) {
    for (const c of fixCycles(db, j.id)) {
      for (const f of c.findings) {
        if (f.outcome !== "accepted" || PER_TICKET.test(f.id)) continue; // only accepted outcomes count
        let cl = clusters.find((x) => sameFinding(x.rep, f));
        if (!cl) { cl = { rep: f, jobs: new Set() }; clusters.push(cl); }
        cl.jobs.add(j.id);
        if (j.id === jobId && cl.mine === undefined && c.executionId !== undefined) cl.mine = c.executionId;
      }
    }
  }
  return clusters.filter((c) => c.jobs.size >= 2 && c.jobs.has(jobId) && c.mine !== undefined).map((c) => {
    const where = c.rep.file && c.rep.file !== "-" ? `${c.rep.file}: ` : "";
    const fix = c.rep.fix ? ` Fix: ${firstLine(c.rep.fix)}` : "";
    return { text: clip(`Address this up front: reviewers raised it and it was fixed in more than one job. ${where}${firstLine(c.rep.issue) || c.rep.id}.${fix}`, 500), kind: "pitfall" as const, source: `stage_execution:${c.mine}`, sourceJobId: jobId };
  });
}

/** Source 2: what a person answered when a job was held for them. */
function humanAnswers(db: FactoryDb, jobId: string): Candidate[] {
  const out: Candidate[] = [];
  for (const r of db.select().from(decisions).where(and(eq(decisions.jobId, jobId), eq(decisions.kind, "human.answer"))).orderBy(asc(decisions.id)).all()) {
    const answer = (r.rationale ?? "").trim();
    if (answer.length < 8) continue; // "yes" teaches nothing without its question
    const asked = firstLine(r.decision.split("\n").slice(1).join("\n"));
    out.push({ text: clip(asked ? `${answer} (asked: ${clip(asked, 120)})` : answer, 500), kind: answer.includes("`") ? "command" : "convention", source: `decision:${r.id}`, sourceJobId: jobId });
  }
  return out;
}

/** Source 3: a project check that failed at review and was fixed by a remediation pass. */
function fixedChecks(db: FactoryDb, jobId: string): Candidate[] {
  const out: Candidate[] = [];
  for (const c of fixCycles(db, jobId)) {
    for (const f of c.findings) {
      const command = f.file?.trim();
      if (!f.id.startsWith("check:") || f.outcome !== "accepted" || !command || command === "-" || c.executionId === undefined) continue;
      out.push({ text: clip(`Run \`${command}\` (the ${f.id.slice(6)} check) before finishing and fix what it reports: it failed on an earlier job and needed a fix.`, 500), kind: "command", source: `stage_execution:${c.executionId}`, sourceJobId: jobId });
    }
  }
  return out;
}

/** Every candidate lesson for a finished job, without storing anything. */
export function candidatesForJob(db: FactoryDb, jobId: string): Candidate[] {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return [];
  return [...recurringFindings(db, job.projectId, jobId), ...humanAnswers(db, jobId), ...fixedChecks(db, jobId)];
}

/** Stores the job's candidates as `proposed` lessons. Returns how many were stored (refused and duplicate ones are skipped). */
export async function distillJob(db: FactoryDb, jobId: string, o: { polish?: Polish } = {}): Promise<number> {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return 0;
  let stored = 0;
  for (const c of candidatesForJob(db, jobId)) {
    let text = c.text;
    if (o.polish) {
      try { text = (await o.polish(c.text, c.kind))?.trim() || c.text; } catch { text = c.text; } // wording only: failure keeps the deterministic text
    }
    // A polished text goes through the same redaction and secret scan; if it is refused, the deterministic text is tried instead.
    let r = proposeLesson(db, { projectId: job.projectId, text, kind: c.kind, source: c.source, sourceJobId: c.sourceJobId, actor: "factory", clip: true });
    if ("refused" in r && text !== c.text) r = proposeLesson(db, { projectId: job.projectId, text: c.text, kind: c.kind, source: c.source, sourceJobId: c.sourceJobId, actor: "factory", clip: true });
    if ("lesson" in r) stored++;
  }
  return stored;
}
