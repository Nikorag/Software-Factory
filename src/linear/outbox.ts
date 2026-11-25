import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lte, or, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import type { LinearConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { decisions, linearOutbox } from "../db/schema.js";
import { LinearApiError, type LinearClient, type LinearIssueDetail, type LinearState } from "./client.js";

export type OutboxOp =
  | { kind: "set_state"; stateKey: keyof LinearConfig["statuses"] }
  | { kind: "add_label" | "remove_label"; labelKey: keyof LinearConfig["labels"] }
  | { kind: "comment"; body: string }
  | { kind: "link_pr"; url: string; title?: string };

export const FACTORY_MARKER = "<!-- software-factory -->";

/** Deterministic UUID (v4 layout) so a retried comment carries the same Linear comment id. */
export function uuidFromKey(key: string): string {
  const h = createHash("sha256").update(key).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Insert-or-ignore on the idempotency key. Safe to call inside a transaction; returns whether a row was added. */
export function enqueueOutbox(db: FactoryDb, jobId: string, issueId: string, op: OutboxOp, idempotencyKey: string): boolean {
  const { kind, ...payload } = op;
  return db.insert(linearOutbox).values({ jobId, issueId, kind, payloadJson: JSON.stringify(payload), idempotencyKey }).onConflictDoNothing().run().changes === 1;
}

export interface FlushResult { sent: number; failed: number; pending: number }
const MAX_ATTEMPTS = 6;

/**
 * Sends pending writes in creation order. Order is preserved per issue: if an operation fails transiently,
 * later operations for that issue wait. Permanent failures (e.g. a configured status that does not exist) are
 * marked failed and do not block the rest.
 */
export async function flushOutbox(
  deps: { db: FactoryDb; client: LinearClient; linear: LinearConfig; logger: Logger; now?: () => Date; backoffBaseMs?: number },
): Promise<FlushResult> {
  const { db, client, linear, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const rows = db.select().from(linearOutbox)
    .where(and(eq(linearOutbox.status, "pending"), or(isNull(linearOutbox.nextAttemptAt), lte(linearOutbox.nextAttemptAt, now()))))
    .orderBy(asc(linearOutbox.id)).all();

  // Coalesce: if a newer status change is pending for the same issue, older ones are superseded, not replayed.
  const latestState = new Map<string, number>();
  for (const r of rows) if (r.kind === "set_state") latestState.set(r.issueId, r.id);

  const blockedIssues = new Set<string>();
  const issueCache = new Map<string, LinearIssueDetail>();
  const stateCache = new Map<string, LinearState[]>();
  const labelCache = new Map<string, { id: string; name: string }[]>();
  const result: FlushResult = { sent: 0, failed: 0, pending: 0 };

  const issueOf = async (id: string) => {
    let i = issueCache.get(id);
    if (!i) { i = await client.getIssue(id); issueCache.set(id, i); }
    return i;
  };
  const find = <T extends { name: string; id: string }>(items: T[], name: string, what: string): T => {
    const m = items.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!m) throw new LinearApiError(`Linear ${what} "${name}" does not exist for this project (map it to an existing one in Settings → Tracker, or create it in your tracker)`, false, undefined, "CONFIG");
    return m;
  };

  const skip = (id: number, why: string) => { db.update(linearOutbox).set({ status: "done", doneAt: now(), lastError: `skipped: ${why}` }).where(eq(linearOutbox.id, id)).run(); };
  for (const row of rows) {
    if (blockedIssues.has(row.issueId)) { result.pending++; continue; }
    const op = { kind: row.kind, ...JSON.parse(row.payloadJson) } as OutboxOp;
    if (op.kind === "set_state" && latestState.get(row.issueId) !== row.id) {
      db.update(linearOutbox).set({ status: "done", doneAt: now(), lastError: "superseded by a newer status change" }).where(eq(linearOutbox.id, row.id)).run();
      continue;
    }
    try {
      switch (op.kind) {
        case "set_state": {
          if (!linear.statuses[op.stateKey]) { skip(row.id, `the "${op.stateKey}" status is not mapped`); continue; } // Jira: an unmapped status is simply not used
          const issue = await issueOf(row.issueId);
          let states = stateCache.get(issue.team.id);
          if (!states) { states = await client.workflowStates(issue.team.id); stateCache.set(issue.team.id, states); }
          const target = find(states, linear.statuses[op.stateKey], "workflow status");
          if (issue.state.id !== target.id) await client.setState(row.issueId, target.id);
          break;
        }
        case "add_label":
        case "remove_label": {
          if (!linear.labels[op.labelKey]) { skip(row.id, `the "${op.labelKey}" label is not mapped`); continue; }
          const issue = await issueOf(row.issueId);
          let labels = labelCache.get(issue.team.id);
          if (!labels) { labels = await client.labels(issue.team.id); labelCache.set(issue.team.id, labels); }
          const wanted = linear.labels[op.labelKey];
          // Jira labels exist as soon as they are used, so one that is not in the list yet is simply added by name.
          const target = client.freeformLabels && !labels.some((x) => x.name.toLowerCase() === wanted.toLowerCase()) ? { id: wanted, name: wanted } : find(labels, wanted, "label");
          const present = issue.labels.some((l) => l.id === target.id);
          if (op.kind === "add_label" && !present) await client.addLabel(row.issueId, target.id);
          if (op.kind === "remove_label" && present) await client.removeLabel(row.issueId, target.id);
          break;
        }
        case "comment": {
          const id = uuidFromKey(row.idempotencyKey);
          try {
            await client.createComment(row.issueId, `${op.body}\n\n${FACTORY_MARKER}`, id);
          } catch (e) {
            // A previous attempt may have succeeded before we recorded it. If the comment exists, we are done.
            const exists = await client.getIssue(row.issueId).then((i) => i.comments.some((c) => c.id === id), () => false);
            if (!exists) throw e;
          }
          break;
        }
        case "link_pr":
          await client.linkPullRequest(row.issueId, op.url, op.title);
          break;
      }
      issueCache.delete(row.issueId); // later ops for this issue must see fresh state
      db.update(linearOutbox).set({ status: "done", doneAt: now(), lastError: null, attempts: row.attempts + 1 }).where(eq(linearOutbox.id, row.id)).run();
      result.sent++;
    } catch (e) {
      const err = e instanceof LinearApiError ? e : new LinearApiError(String(e), true);
      const attempts = row.attempts + 1;
      const permanent = !err.retryable || attempts >= MAX_ATTEMPTS;
      db.update(linearOutbox).set({
        status: permanent ? "failed" : "pending", attempts, lastError: err.message,
        nextAttemptAt: permanent ? null : new Date(now().getTime() + (deps.backoffBaseMs ?? 5000) * 2 ** (attempts - 1)),
      }).where(eq(linearOutbox.id, row.id)).run();
      if (permanent) {
        result.failed++;
        db.insert(decisions).values({ jobId: row.jobId, kind: "linear.write_failed", decision: `${row.kind} #${row.id}`, rationale: err.message, actor: "factory" }).run();
        logger.error({ outboxId: row.id, kind: row.kind, err: err.message }, "linear write failed permanently");
      } else {
        result.pending++;
        blockedIssues.add(row.issueId); // keep order: wait for this op before sending later ones
      }
    }
  }
  return result;
}

export const pendingOutbox = (db: FactoryDb) => db.select().from(linearOutbox).where(inArray(linearOutbox.status, ["pending"])).all();
