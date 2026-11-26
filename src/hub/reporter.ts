import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs, projects, stageExecutions } from "../db/schema.js";
import { getControl } from "../core/control.js";
import { HubClient, HubError, type EventIn, type FetchLike, type SyncIn } from "./client.js";
import type { HubSettings } from "./settings.js";

/**
 * Reports progress to the hub. METADATA ONLY, from a fixed whitelist: ticket keys, stage names, statuses, attempt counts, timestamps,
 * workflow names/versions and PR URLs. Never repository contents, diffs, agent transcripts or logs, file paths, environment,
 * secrets or ticket text. Every field below is picked by name; nothing is forwarded wholesale.
 */

export interface HubState {
  stageCursor: number; decisionCursor: number; syncHash?: string; keyFingerprint?: string;
  lastSuccessAt: number | null; lastAttemptAt: number | null; lastError: string | null;
  keyRejected: boolean; failures: number; nextAttemptAt: number;
}
const EMPTY: HubState = { stageCursor: 0, decisionCursor: 0, lastSuccessAt: null, lastAttemptAt: null, lastError: null, keyRejected: false, failures: 0, nextAttemptAt: 0 };

export const stateFile = (dataDir: string) => join(dataDir, "hub-state.json");
export function readState(dataDir: string): HubState {
  try { return { ...EMPTY, ...(JSON.parse(readFileSync(stateFile(dataDir), "utf8")) as Partial<HubState>) }; } catch { return { ...EMPTY }; }
}
function writeState(dataDir: string, s: HubState): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${stateFile(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(s)); renameSync(tmp, stateFile(dataDir)); // atomic: a crash never leaves a half-written cursor
}

export const BATCH = 500;
const BASE_BACKOFF_MS = 30_000, MAX_BACKOFF_MS = 15 * 60_000, STUCK_AFTER_MS = 24 * 3600_000;
export const backoffMs = (failures: number) => Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
const short = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);

/**
 * Finished stage attempts after the cursor. A row is updated in place from "started" to its outcome, so a still-running attempt
 * with a lower id than a finished one must hold the cursor back: otherwise it would be skipped when it finishes.
 */
export function collectStageEvents(db: FactoryDb, cursor: number, now = Date.now()): { events: EventIn[]; next: number } {
  const stuckBefore = new Date(now - STUCK_AFTER_MS);
  const blocker = db.select({ id: sql<number | null>`min(${stageExecutions.id})` }).from(stageExecutions)
    .where(and(gt(stageExecutions.id, cursor), eq(stageExecutions.outcome, "started"), gt(stageExecutions.startedAt, stuckBefore))).get()?.id ?? null;
  const rows = db.select().from(stageExecutions)
    .where(and(gt(stageExecutions.id, cursor), ne(stageExecutions.outcome, "started"), blocker === null ? undefined : sql`${stageExecutions.id} < ${blocker}`))
    .orderBy(asc(stageExecutions.id)).limit(BATCH).all();
  const events = rows.map((r): EventIn => {
    return {
      id: `stage_execution:${r.id}`, type: "stage.finished", jobId: r.jobId, occurredAt: (r.finishedAt ?? r.startedAt).toISOString(),
      payload: {
        stage: r.stage, attempt: r.attempt, outcome: r.outcome, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt),
        ...(r.finishedAt ? { durationMs: r.finishedAt.getTime() - r.startedAt.getTime() } : {}),
      },
    };
  });
  return { events, next: rows.length ? rows[rows.length - 1]!.id : cursor };
}

/** Decisions are an append-only log. Only the kind, actor and a short decision string go out: never the free-text rationale. */
export function collectDecisionEvents(db: FactoryDb, cursor: number): { events: EventIn[]; next: number } {
  const rows = db.select().from(decisions).where(gt(decisions.id, cursor)).orderBy(asc(decisions.id)).limit(BATCH).all();
  const events = rows.map((r): EventIn => ({
    id: `decision:${r.id}`, type: "decision", ...(r.jobId ? { jobId: r.jobId } : {}), occurredAt: r.createdAt.toISOString(),
    payload: { kind: short(r.kind, 60), actor: short(r.actor, 40), decision: short(r.decision, 120) },
  }));
  return { events, next: rows.length ? rows[rows.length - 1]!.id : cursor };
}

/** Projects, recent jobs and the workflow names they ran: identifiers and states only. Project "name" is the project id, never a path. */
export function collectSync(db: FactoryDb): SyncIn {
  const ps = db.select({ id: projects.id }).from(projects).all().map((p) => ({ id: p.id, name: p.id }));
  const js = db.select().from(jobs).orderBy(desc(jobs.updatedAt)).limit(1000).all().map((j) => ({
    id: j.id, projectId: j.projectId, title: j.externalKey, stage: j.stage, status: j.status, workflowId: j.workflow,
    metadata: {
      workflow: j.workflow, stageAttempts: j.stageAttempts, remediationAttempts: j.remediationAttempts,
      autonomous: j.autonomous, dryRun: j.dryRun, ...(j.prUrl ? { prUrl: short(j.prUrl, 300) } : {}), archived: j.archivedAt !== null,
      createdAt: iso(j.createdAt), updatedAt: iso(j.updatedAt),
    },
  }));
  const ws = [...new Set(js.map((j) => j.workflowId))].slice(0, 200).map((w) => ({ id: w, name: w })); // one workflow per factory: names come from the jobs
  return { projects: ps.slice(0, 500), jobs: js, workflows: ws };
}

export interface ReporterOptions {
  db: FactoryDb; dataDir: string; logger: Logger;
  getSettings: () => HubSettings; getKey: () => string | undefined;
  version?: string; tracker?: string; dryRun?: boolean;
  fetch?: FetchLike; now?: () => number; timeoutMs?: number;
}

export class HubReporter {
  private running = false;
  constructor(private o: ReporterOptions) {}
  private now() { return (this.o.now ?? Date.now)(); }

  /** One reporting pass. Never throws and never blocks the engine: failures are recorded and retried with exponential backoff. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.pass(); } catch (e) { this.o.logger.warn({ err: (e as Error).message }, "hub reporter failed"); } finally { this.running = false; }
  }

  private async pass(): Promise<void> {
    let settings: HubSettings;
    try { settings = this.o.getSettings(); } catch { return; } // unreadable config: change nothing
    if (!settings.enabled || !settings.url) return; // DISABLED BY DEFAULT: no key lookup, no network
    const { dataDir, db, logger } = this.o;
    const state = readState(dataDir);
    const key = this.o.getKey();
    if (!key) { if (state.lastError !== "no API key") writeState(dataDir, { ...state, lastError: "no API key" }); return; }
    const fp = fingerprint(key);
    if (state.keyFingerprint && state.keyFingerprint !== fp) { // a new key (new hub account / factory): start fresh, nothing carries over
      Object.assign(state, { ...EMPTY, keyFingerprint: fp });
    }
    state.keyFingerprint = fp;
    if (state.keyRejected) { writeState(dataDir, state); return; } // stays stopped until the key changes
    const now = this.now();
    if (now < state.nextAttemptAt) return;

    const client = new HubClient({ url: settings.url, key, fetch: this.o.fetch, timeoutMs: this.o.timeoutMs });
    state.lastAttemptAt = now;
    try {
      const c = getControl(db);
      const counts = db.select({ status: jobs.status, n: sql<number>`count(*)` }).from(jobs).groupBy(jobs.status).all();
      await client.heartbeat(this.o.version, {
        paused: c.paused, emergencyStop: c.emergencyStop, tracker: this.o.tracker, dryRun: this.o.dryRun, remoteAccess: settings.remoteAccess,
        jobs: Object.fromEntries(counts.map((r) => [r.status, Number(r.n)])),
      });
      const sync = collectSync(db), hash = createHash("sha256").update(JSON.stringify(sync)).digest("hex");
      if (hash !== state.syncHash) { await client.sync(sync); state.syncHash = hash; writeState(dataDir, state); }
      for (let i = 0; i < 20; i++) { // bounded work per pass
        const a = collectStageEvents(db, state.stageCursor, now), d = collectDecisionEvents(db, state.decisionCursor);
        const batch = [...a.events, ...d.events].sort((x, y) => x.occurredAt.localeCompare(y.occurredAt)).slice(0, BATCH);
        if (!batch.length) break;
        const sentIds = new Set(batch.map((e) => e.id));
        try { await client.events(batch); }
        catch (e) {
          // A batch the hub calls invalid would otherwise wedge reporting forever: record it, skip it, carry on.
          if (e instanceof HubError && e.status === 400) logger.warn({ events: batch.length }, "hub rejected an event batch as invalid; skipping it");
          else throw e;
        }
        state.stageCursor = a.events.every((x) => sentIds.has(x.id)) ? a.next : advance(a.events, sentIds, state.stageCursor, "stage_execution:");
        state.decisionCursor = d.events.every((x) => sentIds.has(x.id)) ? d.next : advance(d.events, sentIds, state.decisionCursor, "decision:");
        writeState(dataDir, state); // cursor is saved after every acknowledged batch, so a restart resumes exactly here
        if (a.events.length < BATCH && d.events.length < BATCH && a.events.length + d.events.length <= BATCH) break; // nothing left over
      }
      Object.assign(state, { lastSuccessAt: now, lastError: null, failures: 0, nextAttemptAt: 0 });
      writeState(dataDir, state);
    } catch (e) {
      const err = e instanceof HubError ? e : new HubError("unexpected error", null);
      if (err.rejected) {
        Object.assign(state, { keyRejected: true, lastError: `key rejected by the hub (${err.status}): run \`factory hub connect\` with a new key` });
        logger.warn("hub rejected the API key; reporting stopped");
      } else {
        state.failures += 1;
        Object.assign(state, { lastError: err.message, nextAttemptAt: now + backoffMs(state.failures) });
        logger.warn({ failures: state.failures, retryInMs: backoffMs(state.failures) }, `hub report failed: ${err.message}`);
      }
      writeState(dataDir, state);
    }
  }
}

/** Highest id such that every event up to it was sent (events are ordered by id). */
function advance(events: EventIn[], sent: Set<string>, cursor: number, prefix: string): number {
  let c = cursor;
  for (const e of events) { if (!sent.has(e.id)) break; c = Number(e.id.slice(prefix.length)); }
  return c;
}

export const hubStateExists = (dataDir: string) => existsSync(stateFile(dataDir));
