import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { allowedPushEndpoint, NOTIFICATION_LABELS, NOTIFICATION_TYPES, type NotificationPayload } from "./push.js";
import type { Deps } from "./server.js";

const subscribeBody = z.object({
  endpoint: z.url().max(2048).refine(allowedPushEndpoint, "not a recognised push service"),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});
const unsubscribeBody = z.object({ endpoint: z.string().max(2048) });
const prefsBody = z.object({ types: z.partialRecord(z.enum(NOTIFICATION_TYPES), z.boolean()) });
const MAX_SUBSCRIPTIONS_PER_USER = 20;

export function registerPushRoutes(app: FastifyInstance, d: Deps, requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  const { cfg, db } = d;
  const off = (reply: FastifyReply) => reply.code(503).send({ error: "push_not_configured" });

  // The browser needs the public key to subscribe. `enabled: false` (no VAPID keys set) lets the UI say so instead of failing.
  app.get("/v1/push/config", { preHandler: requireUser }, async () => ({ enabled: !!d.push, publicKey: d.push ? cfg.VAPID_PUBLIC_KEY : null }));

  app.post("/v1/push/subscribe", { preHandler: requireUser }, async (req, reply) => {
    if (!d.push) return off(reply);
    const b = subscribeBody.parse(req.body);
    const userId = req.user!.userId;
    const n = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id=$1 AND disabled_at IS NULL AND endpoint <> $2", [userId, b.endpoint])).rows[0]!.n;
    if (n >= MAX_SUBSCRIPTIONS_PER_USER) return reply.code(409).send({ error: "too_many_subscriptions" });
    // One row per browser endpoint. If the same browser is now signed in as someone else, it belongs to them now.
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, user_agent=EXCLUDED.user_agent, disabled_at=NULL`,
      [userId, b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers["user-agent"] ?? "").slice(0, 300) || null]);
    return { ok: true };
  });

  app.post("/v1/push/unsubscribe", { preHandler: requireUser }, async (req) => {
    const b = unsubscribeBody.parse(req.body);
    await db.query("DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2", [b.endpoint, req.user!.userId]);
    return { ok: true };
  });

  // Sends a test to every browser this user has subscribed, through the normal delivery path.
  app.post("/v1/push/test", { preHandler: requireUser }, async (req, reply) => {
    if (!d.push) return off(reply);
    const userId = req.user!.userId;
    const recent = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notification_deliveries WHERE user_id=$1 AND event_id IS NULL AND created_at > now() - interval '1 minute'", [userId])).rows[0]!.n;
    if (recent >= 10) return reply.code(429).send({ error: "slow_down" });
    const payload: NotificationPayload = { type: "test", title: "Software Factory", body: "Notifications are working on this device.", url: "/", tag: "test" };
    const r = await db.query(
      "INSERT INTO notification_deliveries (subscription_id, user_id, payload) SELECT id, user_id, $2::jsonb FROM push_subscriptions WHERE user_id=$1 AND disabled_at IS NULL",
      [userId, JSON.stringify(payload)]);
    return { queued: r.rowCount };
  });

  app.get("/v1/notifications/preferences", { preHandler: requireUser }, async (req) => {
    const rows = (await db.query<{ event_type: string; enabled: boolean }>("SELECT event_type, enabled FROM notification_preferences WHERE user_id=$1", [req.user!.userId])).rows;
    const set = new Map(rows.map((r) => [r.event_type, r.enabled]));
    return { types: NOTIFICATION_TYPES.map((id) => ({ id, label: NOTIFICATION_LABELS[id], enabled: set.get(id) ?? true })) };
  });

  app.put("/v1/notifications/preferences", { preHandler: requireUser }, async (req) => {
    const b = prefsBody.parse(req.body);
    for (const [type, enabled] of Object.entries(b.types)) {
      await db.query("INSERT INTO notification_preferences (user_id, event_type, enabled) VALUES ($1,$2,$3) ON CONFLICT (user_id, event_type) DO UPDATE SET enabled=EXCLUDED.enabled", [req.user!.userId, type, enabled]);
    }
    return { ok: true };
  });
}
