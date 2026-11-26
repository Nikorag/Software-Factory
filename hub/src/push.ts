import { sendNotification } from "web-push";
import type { Config } from "./config.js";
import type { Db, Queryable } from "./db.js";

// Web Push (VAPID). Three parts: choosing who to tell about an event (enqueueEventNotifications, run inside the
// ingest transaction so a notification exists if and only if its event was stored), sending (deliverPending, a
// background loop any replica can run), and the PushSender seam so tests never touch the network.

export const NOTIFICATION_TYPES = ["job.failed", "job.needs_attention"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const NOTIFICATION_LABELS: Record<NotificationType, string> = { "job.failed": "A job fails", "job.needs_attention": "A job needs you" };

export interface PushSubscriptionRow { endpoint: string; p256dh: string; auth: string }
export type PushResult = { ok: true } | { ok: false; gone: boolean; retry: boolean; status?: number; error: string };
export interface PushSender { send(sub: PushSubscriptionRow, payload: string): Promise<PushResult> }

/** What the service worker receives. Kept small and free of anything sensitive: it travels through the browser vendor's push service (encrypted). */
export interface NotificationPayload { type: NotificationType | "test"; title: string; body: string; url: string; tag: string }

// The hub POSTs to whatever endpoint a signed-in user registers, so an unrestricted endpoint would be a server-side request forgery
// primitive. Only the push services browsers actually use are accepted.
const PUSH_HOSTS: Array<string | RegExp> = [
  "fcm.googleapis.com", /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, "web.push.apple.com", /\.push\.apple\.com$/,
];
export function allowedPushEndpoint(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  return PUSH_HOSTS.some((h) => (typeof h === "string" ? u.hostname === h : h.test(u.hostname)));
}

export function createWebPushSender(cfg: Config): PushSender | null {
  if (!cfg.VAPID_PUBLIC_KEY || !cfg.VAPID_PRIVATE_KEY || !cfg.VAPID_SUBJECT) return null;
  const vapidDetails = { subject: cfg.VAPID_SUBJECT, publicKey: cfg.VAPID_PUBLIC_KEY, privateKey: cfg.VAPID_PRIVATE_KEY };
  return {
    async send(sub, payload) {
      try {
        await sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { vapidDetails, TTL: 3600, timeout: 10_000, urgency: "normal" });
        return { ok: true };
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        const msg = (e as Error).message.slice(0, 200);
        if (status === 404 || status === 410) return { ok: false, gone: true, retry: false, status, error: "subscription expired" };
        // 429 and 5xx (and network errors: no status) are the push service's trouble: try again. Other 4xx will not improve (bad keys, payload, VAPID).
        return { ok: false, gone: false, retry: status === undefined || status === 429 || status >= 500, status, error: msg };
      }
    },
  };
}

const humanStage = (s: unknown) => (typeof s === "string" ? s.toLowerCase().replace(/_/g, " ") : "a stage");
const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

/** Which notification, if any, an event deserves. Pure. */
export function notificationFor(ev: { type: string; payload: Record<string, unknown> }, ctx: { jobKey: string; factoryName: string; factoryId: string; jobId?: string }): NotificationPayload | null {
  const url = `/#factory=${ctx.factoryId}`;
  const tag = `job:${ctx.factoryId}:${ctx.jobId ?? ctx.jobKey}`;
  if (ev.type === "stage.finished" && (ev.payload.outcome === "failed" || ev.payload.outcome === "timed_out")) {
    return { type: "job.failed", title: `${ctx.jobKey} ${ev.payload.outcome === "timed_out" ? "timed out" : "failed"}`, body: `${humanStage(ev.payload.stage)} on ${ctx.factoryName}`, url, tag };
  }
  if (ev.type === "decision" && (ev.payload.kind === "needs_attention" || ev.payload.kind === "blocked")) {
    return { type: "job.needs_attention", title: `${ctx.jobKey} needs you`, body: str(ev.payload.decision, 120) || `Blocked on ${ctx.factoryName}`, url, tag };
  }
  return null;
}

/**
 * Called inside the ingest transaction with the events that were newly stored. Recipients are the people who can see the factory (a
 * member of its organisation, or granted view access) who have not switched this kind of notification off, one delivery per live browser.
 */
export async function enqueueEventNotifications(q: Queryable, factoryId: string, events: Array<{ type: string; payload: Record<string, unknown>; jobId?: string }>): Promise<number> {
  const wanted = events.map((e) => ({ e, n: null as NotificationPayload | null }));
  if (!wanted.some((w) => w.e.type === "stage.finished" || w.e.type === "decision")) return 0;
  const f = (await q.query<{ name: string; org_id: string }>("SELECT name, org_id FROM factories WHERE id=$1", [factoryId])).rows[0];
  if (!f) return 0;
  let queued = 0;
  for (const w of wanted) {
    const job = w.e.jobId ? (await q.query<{ id: string; title: string | null }>("SELECT id, title FROM jobs WHERE factory_id=$1 AND external_id=$2", [factoryId, w.e.jobId])).rows[0] : undefined;
    w.n = notificationFor(w.e, { jobKey: job?.title || w.e.jobId || "A job", factoryName: f.name, factoryId, jobId: job?.id });
    if (!w.n) continue;
    const r = await q.query(
      `INSERT INTO notification_deliveries (subscription_id, user_id, payload)
       SELECT s.id, s.user_id, $3::jsonb
         FROM push_subscriptions s JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL
        WHERE s.disabled_at IS NULL
          AND (EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = $2 AND m.user_id = s.user_id)
            OR EXISTS (SELECT 1 FROM factory_permissions p WHERE p.factory_id = $1 AND p.user_id = s.user_id AND p.permission = 'view'))
          AND NOT EXISTS (SELECT 1 FROM notification_preferences np WHERE np.user_id = s.user_id AND np.event_type = $4 AND np.enabled = false)`,
      [factoryId, f.org_id, JSON.stringify(w.n), w.n.type]);
    queued += r.rowCount;
  }
  return queued;
}

const MAX_ATTEMPTS = 5, BATCH = 20, STALE_AFTER = "1 hour";
const backoffSeconds = (attempts: number) => Math.min(30 * 2 ** (attempts - 1), 900);

interface Due { id: string; payload: unknown; attempts: number; sid: string; endpoint: string; p256dh: string; auth: string }

/** One pass of the sender. Safe to run on every replica at once (rows are claimed with SKIP LOCKED). Returns how many were attempted. */
export async function deliverPending(db: Db, sender: PushSender, log: { warn(o: object, m: string): void }): Promise<number> {
  // A notification that could not be sent for an hour is no longer news; one whose browser has gone has nowhere to go.
  await db.query(`UPDATE notification_deliveries SET status='failed', last_error='expired' WHERE status='pending' AND created_at < now() - interval '${STALE_AFTER}'`);
  await db.query("UPDATE notification_deliveries SET status='gone' WHERE status='pending' AND subscription_id IS NULL");
  return db.tx(async (q) => {
    const due = (await q.query<Due>(
      `SELECT d.id, d.payload, d.attempts, s.id AS sid, s.endpoint, s.p256dh, s.auth
         FROM notification_deliveries d JOIN push_subscriptions s ON s.id = d.subscription_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND s.disabled_at IS NULL
        ORDER BY d.created_at LIMIT ${BATCH} FOR UPDATE OF d SKIP LOCKED`)).rows;
    const results = await Promise.all(due.map((d) => sender.send({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }, JSON.stringify(d.payload)).catch((e): PushResult => ({ ok: false, gone: false, retry: true, error: (e as Error).message }))));
    for (const [i, d] of due.entries()) {
      const r = results[i]!;
      if (r.ok) {
        await q.query("UPDATE notification_deliveries SET status='sent', sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1", [d.id]);
        await q.query("UPDATE push_subscriptions SET last_success_at=now() WHERE id=$1", [d.sid]);
      } else if (r.gone) {
        await q.query("UPDATE notification_deliveries SET status='gone', attempts=attempts+1, last_error=$2 WHERE id=$1", [d.id, r.error]);
        await q.query("UPDATE push_subscriptions SET disabled_at=now() WHERE id=$1", [d.sid]);
      } else {
        const attempts = d.attempts + 1, giveUp = !r.retry || attempts >= MAX_ATTEMPTS;
        if (r.status === 401 || r.status === 403) log.warn({ status: r.status }, "push service rejected our VAPID credentials (did the keys change since this browser subscribed?)");
        await q.query(`UPDATE notification_deliveries SET status=$2, attempts=$3, last_error=$4, next_attempt_at = now() + $5 * interval '1 second' WHERE id=$1`,
          [d.id, giveUp ? "failed" : "pending", attempts, r.error, backoffSeconds(attempts)]);
      }
    }
    return due.length;
  });
}

/** Housekeeping: delivery rows are only a short-lived outbox. */
export const pruneDeliveries = (db: Db) => db.query("DELETE FROM notification_deliveries WHERE status <> 'pending' AND created_at < now() - interval '7 days'");
