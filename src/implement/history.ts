import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { decisions, stageExecutions } from "../db/schema.js";
import type { GitFn } from "../repo/git.js";
import { NON_CODE } from "./diff.js";

/**
 * Memory across fix cycles, derived only from what is already recorded (stage outputs and decisions): which findings each
 * review raised, what the implementer did with them, and what was deferred to a human. It lets reviewers stop re-raising
 * settled findings, and lets the factory notice when a cycle would only repeat the previous one (see ADR 0012).
 */

export interface Finding { id: string; severity: string; file?: string; line?: number | null; issue?: string; fix?: string; tasks?: string[] }
export type Outcome = "accepted" | "rejected" | "deferred" | "unaddressed";
export interface CycleFinding extends Finding { outcome: Outcome; reason?: string }
/** One fix cycle: a stage raised blocking findings at `head`, and REMEDIATION answered them, leaving `headAfter`. */
export interface Cycle { n: number; stage: string; head?: string; headAfter?: string; findings: CycleFinding[] }

/** Stages whose `remediate` output feeds the implementer's REMEDIATION stage. */
export const REVIEW_STAGES = ["AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW", "FINAL_VALIDATION", "CI_VALIDATION"];
const BLOCKING = new Set(["blocker", "major", "critical", "high"]);
const blocking = (f: Finding) => BLOCKING.has(f.severity);

/**
 * Findings that must be fixed and can never be deferred or settled by argument: a failing project check, weakened or deleted
 * tests, protected paths, a dirty tree, conflict markers. These loop to the remediation cap and then stop for a human.
 */
const HARD = /^(check:|gate:(check-|clean-tree|protected-path|no-change|conflict-markers|test-weakening|test-deleted))/;
export const isDeferrable = (id: string) => !HARD.test(id);

/** Ids that mean the same thing every time they are raised (deterministic gates, checks, criteria, CI jobs). */
const STABLE = /^(gate|check|criterion|ci):/;

/** A rejection whose reason says only a person can do it is a deferral in disguise (seen live: JAM-414's manual walkthrough). */
export const HUMAN_ONLY_REASON = /\b(manual(ly)?|by hand|human|a person|visual(ly)?|walk-?through|real (device|browser|window|server|hardware|phone)|physical|cannot be automated|can't be automated|not automatable|requires? (network|credentials|an? account))\b/i;

const parse = (s: string | null): Record<string, unknown> => { try { return s ? (JSON.parse(s) as Record<string, unknown>) : {}; } catch { return {}; } };

/** Every closed fix cycle for a job, oldest first. */
export function fixCycles(db: FactoryDb, jobId: string): Cycle[] {
  const rows = db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.outcome, "succeeded"))).orderBy(asc(stageExecutions.id)).all();
  const cycles: Cycle[] = [];
  let open: Omit<Cycle, "n"> | undefined;
  for (const r of rows) {
    const out = parse(r.outputJson);
    if (REVIEW_STAGES.includes(r.stage) && typeof out.remediate === "string") {
      const details = (out.details ?? {}) as { findings?: Finding[]; head?: string };
      open = { stage: r.stage, head: details.head, findings: (details.findings ?? []).filter(blocking).map((f) => ({ ...f, outcome: "unaddressed" as Outcome })) };
    } else if (r.stage === "REMEDIATION" && open) {
      const o = out as { accepted?: string[]; rejected?: { id: string; reason: string }[]; deferred?: { id: string; reason: string }[]; head?: string };
      for (const f of open.findings) {
        const rej = o.rejected?.find((x) => x.id === f.id);
        const def = o.deferred?.find((x) => x.id === f.id);
        if (def) { f.outcome = "deferred"; f.reason = def.reason; }
        else if (rej) { f.outcome = HUMAN_ONLY_REASON.test(rej.reason) && isDeferrable(f.id) ? "deferred" : "rejected"; f.reason = rej.reason; }
        else if (o.accepted?.includes(f.id)) f.outcome = "accepted";
      }
      cycles.push({ n: cycles.length + 1, ...open, headAfter: o.head });
      open = undefined;
    }
  }
  return cycles;
}

/** Findings a stage itself deferred (a dispute that would only loop), recorded in its output so later stages recognise them. */
function stageDeferred(db: FactoryDb, jobId: string): Finding[] {
  const rows = db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.outcome, "succeeded"))).orderBy(asc(stageExecutions.id)).all();
  const out: Finding[] = [];
  for (const r of rows) {
    const o = parse(r.outputJson) as { deferred?: unknown; details?: { deferred?: unknown } };
    const list = Array.isArray(o.deferred) ? o.deferred : Array.isArray(o.details?.deferred) ? o.details.deferred : [];
    for (const f of list as Finding[]) if (f && typeof f.id === "string") out.push(f);
  }
  return out;
}

const words = (s = "") => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
const norm = (f = "") => f.replace(/^\.\//, "").trim();
/** Same finding? Stable ids match by id; a reviewer's ids (R1, C2) are reused for different things, so those match by file and wording. */
export function sameFinding(a: Finding, b: Finding): boolean {
  if (STABLE.test(a.id) || STABLE.test(b.id)) return a.id === b.id;
  if (norm(a.file) !== norm(b.file)) return false;
  if (!norm(a.file) || norm(a.file) === "-") return a.id === b.id && (a.issue ?? "") === (b.issue ?? "");
  const x = words(a.issue), y = words(b.issue);
  if (x.size === 0 || y.size === 0) return false;
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / (x.size + y.size - inter) >= 0.4;
}

export interface Deferral { id: string; what: string; reason: string }

/** Records a deferral to a human (a decision, posted on the PR). A finding about open tasks defers each task. Idempotent. */
export function recordDeferral(db: FactoryDb, jobId: string, f: Finding, reason: string): void {
  const items: Deferral[] = f.tasks?.length
    ? f.tasks.map((t) => ({ id: t, what: `task ${t} in tasks.md`, reason }))
    : [{ id: f.id, what: `${f.file && f.file !== "-" ? `${f.file}: ` : ""}${(f.issue ?? f.id).split("\n")[0]!.slice(0, 300)}`, reason }];
  const have = db.select().from(decisions).where(and(eq(decisions.jobId, jobId), eq(decisions.kind, "human.deferred"))).all();
  for (const it of items) {
    const rationale = `${it.what} | ${it.reason.slice(0, 600)}`;
    if (have.some((h) => h.decision === it.id && h.rationale === rationale)) continue;
    db.insert(decisions).values({ jobId, kind: "human.deferred", decision: it.id, rationale, actor: "factory" }).run();
  }
}

/** Everything deferred to a human for this job, de-duplicated, oldest first. */
export function deferrals(db: FactoryDb, jobId: string): Deferral[] {
  const seen = new Set<string>();
  const out: Deferral[] = [];
  for (const r of db.select().from(decisions).where(and(eq(decisions.jobId, jobId), eq(decisions.kind, "human.deferred"))).orderBy(asc(decisions.id)).all()) {
    const [what, ...rest] = (r.rationale ?? "").split(" | ");
    const key = `${r.decision}\0${r.rationale}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.decision, what: what ?? r.decision, reason: rest.join(" | ") });
  }
  return out;
}

/** An unticked task in tasks.md, and whether the spec marks it as something only a human can do. */
export interface OpenTask { id: string; text: string; human: boolean }
export const HUMAN_TAG = /\[HUMAN\b[^\]]*\]/i;
export function openTasks(tasksMd: string): OpenTask[] {
  return [...tasksMd.matchAll(/^\s*- \[ \] (T\d{3})\b(.*)$/gm)].map((m) => ({ id: m[1]!, text: m[2]!.trim(), human: HUMAN_TAG.test(m[2]!) }));
}

export interface Triage<F extends Finding> { keep: F[]; deferred: (F & { reason: string })[]; settled: F[] }

/**
 * Applies the no-loop rule to a stage's findings before it asks for remediation:
 * - a blocking finding already deferred to a human is dropped (it is on the PR);
 * - a blocking finding the implementer already rejected is a dispute: if it was rejected twice, or nothing it points at has
 *   changed since the rejection, another cycle would only repeat itself, so it is deferred to the PR for a human to settle.
 * Hard findings (failing checks, weakened tests, protected paths...) are never deferred.
 */
export async function triage<F extends Finding>(o: { db: FactoryDb; jobId: string; cwd: string; git: GitFn; findings: F[] }): Promise<Triage<F>> {
  if (!o.findings.some(blocking)) return { keep: o.findings, deferred: [], settled: [] };
  const cycles = fixCycles(o.db, o.jobId);
  const prior = cycles.flatMap((c) => c.findings.map((f) => ({ ...f, headAfter: c.headAfter })));
  const already = [...stageDeferred(o.db, o.jobId), ...prior.filter((p) => p.outcome === "deferred")];
  const deferredIds = new Set(deferrals(o.db, o.jobId).map((x) => x.id));
  const res: Triage<F> = { keep: [], deferred: [], settled: [] };
  for (const f of o.findings) {
    if (!blocking(f) || !isDeferrable(f.id)) { res.keep.push(f); continue; }
    // A finding about open tasks is settled only when every task it lists is deferred: a newly opened task still counts.
    if (f.tasks?.length ? f.tasks.every((t) => deferredIds.has(t)) : already.some((p) => sameFinding(p, f))) { res.settled.push(f); continue; }
    const rejections = prior.filter((p) => p.outcome === "rejected" && sameFinding(p, f));
    const last = rejections.at(-1);
    if (last && (rejections.length >= 2 || !(await changedSince(o.cwd, o.git, last.headAfter, f.file)))) {
      const reason = `Disputed after ${rejections.length} fix cycle(s) with nothing changed to settle it. Reviewer: ${(f.issue ?? "").split("\n")[0]!.slice(0, 300)} Implementer: ${last.reason ?? "(no reason given)"}. A human should decide.`;
      recordDeferral(o.db, o.jobId, f, reason);
      res.deferred.push({ ...f, reason });
      continue;
    }
    res.keep.push(f);
  }
  return res;
}

/**
 * Has the file (or, for a finding without a real file, any code) been touched by a commit since `from`? A change that was made
 * and then undone still counts: someone worked on it. Unknown = changed.
 */
export async function changedSince(cwd: string, git: GitFn, from: string | undefined, file?: string): Promise<boolean> {
  if (!from) return true;
  const path = file && file !== "-" && existsSync(join(cwd, file)) ? [file] : [".", ...NON_CODE];
  try {
    if ((await git(cwd, ["log", "--format=%H", `${from}..HEAD`, "--", ...path])).trim()) return true;
    return (await git(cwd, ["diff", "--name-only", from, "HEAD", "--", ...path])).trim().length > 0;
  } catch { return true; }
}

/** The previous run of a stage at the same code (spec edits do not count), so an unchanged branch is not reviewed twice. */
export async function sameCodeRun(o: { db: FactoryDb; jobId: string; stage: string; cwd: string; git: GitFn }): Promise<Record<string, unknown> | undefined> {
  const row = o.db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, o.jobId), eq(stageExecutions.stage, o.stage), eq(stageExecutions.outcome, "succeeded"))).orderBy(asc(stageExecutions.id)).all().at(-1);
  const out = parse(row?.outputJson ?? null);
  const body = (typeof out.remediate === "string" ? out.details : out) as Record<string, unknown> | undefined;
  const head = body?.head;
  if (typeof head !== "string" || (await changedSince(o.cwd, o.git, head))) return undefined;
  return { ...body, remediated: typeof out.remediate === "string" };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const OUTCOME: Record<Outcome, string> = { accepted: "fixed by the implementer", rejected: "REJECTED by the implementer", deferred: "DEFERRED to a human (on the PR)", unaddressed: "not addressed" };

/** A compact, bounded history for a reviewer's prompt. Empty before the first fix cycle. */
export function historyText(cycles: Cycle[], deferred: Deferral[], changedStat?: string): string {
  if (cycles.length === 0 && deferred.length === 0) return "";
  const lines = [
    `Earlier review rounds on this branch (${cycles.length} fix cycle(s) so far). Do NOT raise again a finding that was rejected or deferred below unless you have NEW evidence that the stated reason is wrong (cite it). Findings marked fixed should only be raised again if the fix demonstrably does not work.`,
  ];
  for (const c of cycles.slice(-4)) {
    lines.push(`Cycle ${c.n}, raised by ${c.stage}:`);
    for (const f of c.findings.slice(0, 12)) lines.push(`- [${f.severity}] ${f.id} ${f.file && f.file !== "-" ? `${f.file}: ` : ""}${clip((f.issue ?? "").split("\n")[0]!, 200)} -> ${OUTCOME[f.outcome]}${f.reason ? `: ${clip(f.reason, 300)}` : ""}`);
  }
  if (deferred.length) lines.push("Deferred to a human (listed on the pull request; not blocking, do not raise again):", ...deferred.slice(0, 20).map((x) => `- ${x.id}: ${clip(x.what, 160)}`));
  if (cycles.length > 0) {
    lines.push(changedStat?.trim()
      ? `Code changed since the last review:\n${clip(changedStat.trim(), 3000)}\nThis is a re-review: report a blocking (blocker/major) finding only for code that changed since the last review, or for a requirement that is still demonstrably not met. Anything else is at most minor.`
      : "No code changed since the last review. Report a blocking finding only for a requirement that is demonstrably not met.");
  }
  return lines.join("\n");
}

/** Failures of earlier attempts at this stage since it last succeeded, newest last, so a retry knows what went wrong. */
export function previousFailures(db: FactoryDb, jobId: string, stage: string, max = 3): string[] {
  const rows = db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.stage, stage))).orderBy(asc(stageExecutions.id)).all();
  const lastOk = rows.map((r) => r.outcome).lastIndexOf("succeeded");
  return rows.slice(lastOk + 1).filter((r) => (r.outcome === "failed" || r.outcome === "timed_out") && r.error && !/^lease lost$/.test(r.error))
    .map((r) => `attempt ${r.attempt} ${r.outcome === "timed_out" ? "timed out" : "failed"}: ${clip(r.error!, 800)}`).slice(-max);
}
