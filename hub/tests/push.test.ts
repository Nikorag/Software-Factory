import { beforeEach, describe, expect, it } from "vitest";
import { ingestEvents } from "../src/ingest.js";
import { allowedPushEndpoint, deliverPending, notificationFor, type PushResult, type PushSender, type PushSubscriptionRow } from "../src/push.js";
import { SoftAuthenticator } from "./authenticator.js";
import { FakeBus, freshDb, seed, testHub, TEST_VAPID } from "./helpers.js";

const FCM = "https://fcm.googleapis.com/fcm/send/abc";
const mozilla = "https://updates.push.services.mozilla.com/wpush/v2/xyz";
const KEYS = { p256dh: "B".repeat(40), auth: "a".repeat(16) };

class FakePush implements PushSender {
  sent: Array<{ sub: PushSubscriptionRow; payload: Record<string, string> }> = [];
  next: PushResult = { ok: true };
  async send(sub: PushSubscriptionRow, payload: string) { this.sent.push({ sub, payload: JSON.parse(payload) }); return this.next; }
}
const log = { warn() {} };

let db: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => { db = await freshDb(); });

const subscribe = async (userId: string, endpoint: string) =>
  (await db.query<{ id: string }>("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,'k','a') RETURNING id", [userId, endpoint])).rows[0]!.id;
const failEvent = (id: string, job = "J-1") => ({ events: [{ id, type: "stage.finished", jobId: job, occurredAt: new Date(), payload: { stage: "AUTOMATED_TESTING", outcome: "failed" } }] });
const ingest = (f: string, org: string, body: ReturnType<typeof failEvent>) => ingestEvents(db, new FakeBus(), f, org, body);
const deliveries = async () => (await db.query<{ status: string; user_id: string; attempts: number }>("SELECT status, user_id, attempts FROM notification_deliveries ORDER BY created_at")).rows;

describe("push endpoint allowlist", () => {
  it("accepts the real push services and nothing else (no SSRF)", () => {
    expect(allowedPushEndpoint(FCM)).toBe(true);
    expect(allowedPushEndpoint(mozilla)).toBe(true);
    expect(allowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(allowedPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
    for (const bad of ["http://fcm.googleapis.com/x", "https://evil.example/x", "https://fcm.googleapis.com.evil.example/x", "https://169.254.169.254/latest", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "javascript:alert(1)", "nope"]) expect(allowedPushEndpoint(bad), bad).toBe(false);
  });
});

describe("what deserves a notification", () => {
  const ctx = { jobKey: "ENG-1", factoryName: "mac-mini", factoryId: "f1" };
  it("failures and things that need you; nothing else", () => {
    expect(notificationFor({ type: "stage.finished", payload: { outcome: "failed", stage: "AUTOMATED_TESTING" } }, ctx)).toMatchObject({ type: "job.failed", title: "ENG-1 failed", body: "automated testing on mac-mini", url: "/#factory=f1" });
    expect(notificationFor({ type: "stage.finished", payload: { outcome: "timed_out", stage: "IMPLEMENTATION" } }, ctx)?.title).toBe("ENG-1 timed out");
    expect(notificationFor({ type: "decision", payload: { kind: "needs_attention", decision: "Security review wants a human" } }, ctx)).toMatchObject({ type: "job.needs_attention", body: "Security review wants a human" });
    expect(notificationFor({ type: "stage.finished", payload: { outcome: "succeeded" } }, ctx)).toBeNull();
    expect(notificationFor({ type: "decision", payload: { kind: "ok" } }, ctx)).toBeNull();
    expect(notificationFor({ type: "heartbeat", payload: {} }, ctx)).toBeNull();
  });
});

describe("queueing from ingested events", () => {
  it("notifies each browser of the people who can see the factory, not outsiders, and never twice for a re-sent batch", async () => {
    const s = await seed(db);
    await db.query("INSERT INTO jobs (factory_id, external_id, title) VALUES ($1,'J-1','ENG-9')", [s.factory]);
    await subscribe(s.admin, FCM + "1"); await subscribe(s.admin, FCM + "2"); await subscribe(s.viewer, FCM + "3"); await subscribe(s.outsider, FCM + "4");
    expect(await ingest(s.factory, s.org, failEvent("e1"))).toBe(1);
    const d = await deliveries();
    expect(d).toHaveLength(3); // admin x2 browsers + viewer; the outsider is in no org that owns the factory
    expect(new Set(d.map((x) => x.user_id))).toEqual(new Set([s.admin, s.viewer]));
    expect((await db.query<{ payload: { title: string } }>("SELECT payload FROM notification_deliveries LIMIT 1")).rows[0]!.payload.title).toBe("ENG-9 failed");
    expect(await ingest(s.factory, s.org, failEvent("e1"))).toBe(0); // duplicate event: stored once, notified once
    expect(await deliveries()).toHaveLength(3);
  });

  it("respects a switched-off type, a disabled subscription and a disabled user", async () => {
    const s = await seed(db);
    await subscribe(s.admin, FCM + "1");
    const v = await subscribe(s.viewer, FCM + "2");
    await db.query("INSERT INTO notification_preferences (user_id, event_type, enabled) VALUES ($1,'job.failed',false)", [s.admin]);
    await db.query("UPDATE push_subscriptions SET disabled_at = now() WHERE id=$1", [v]);
    await ingest(s.factory, s.org, failEvent("e1"));
    expect(await deliveries()).toHaveLength(0);
    await db.query("UPDATE push_subscriptions SET disabled_at = NULL WHERE id=$1", [v]);
    await db.query("UPDATE users SET disabled_at = now() WHERE id=$1", [s.viewer]);
    await ingest(s.factory, s.org, failEvent("e2"));
    expect(await deliveries()).toHaveLength(0);
  });

  it("queues nothing for events that are not notifiable", async () => {
    const s = await seed(db); await subscribe(s.admin, FCM + "1");
    await ingest(s.factory, s.org, { events: [{ id: "e1", type: "stage.finished", jobId: "J-1", occurredAt: new Date(), payload: { stage: "X", outcome: "succeeded" } }] });
    expect(await deliveries()).toHaveLength(0);
  });
});

describe("delivery", () => {
  async function queued() { const s = await seed(db); await subscribe(s.admin, FCM + "1"); await ingest(s.factory, s.org, failEvent("e1")); return s; }

  it("sends the payload to the subscription and marks it sent", async () => {
    await queued(); const p = new FakePush();
    expect(await deliverPending(db, p, log)).toBe(1);
    expect(p.sent[0]!.sub.endpoint).toBe(FCM + "1");
    expect(p.sent[0]!.payload).toMatchObject({ type: "job.failed", url: expect.stringContaining("/#factory=") });
    expect((await deliveries())[0]!.status).toBe("sent");
    expect(await deliverPending(db, p, log)).toBe(0); // nothing is sent twice
  });

  it("an expired browser (410) is switched off, and gets no more notifications", async () => {
    const s = await queued(); const p = new FakePush(); p.next = { ok: false, gone: true, retry: false, status: 410, error: "subscription expired" };
    await deliverPending(db, p, log);
    expect((await deliveries())[0]!.status).toBe("gone");
    expect((await db.query<{ disabled_at: Date | null }>("SELECT disabled_at FROM push_subscriptions")).rows[0]!.disabled_at).not.toBeNull();
    await ingest(s.factory, s.org, failEvent("e2"));
    expect(await deliveries()).toHaveLength(1); // no new delivery for the dead subscription
  });

  it("a push-service outage retries with backoff and eventually gives up; a bad request fails at once", async () => {
    await queued(); const p = new FakePush(); p.next = { ok: false, gone: false, retry: true, status: 503, error: "unavailable" };
    await deliverPending(db, p, log);
    expect(await deliveries()).toEqual([expect.objectContaining({ status: "pending", attempts: 1 })]);
    expect(await deliverPending(db, p, log)).toBe(0); // backing off: not due yet
    for (let i = 0; i < 5; i++) { await db.query("UPDATE notification_deliveries SET next_attempt_at = now() - interval '1 second'"); await deliverPending(db, p, log); }
    expect((await deliveries())[0]).toMatchObject({ status: "failed", attempts: 5 });

  });

  it("does not retry a request the push service rejected outright (e.g. wrong VAPID key)", async () => {
    await queued(); const p = new FakePush(); p.next = { ok: false, gone: false, retry: false, status: 403, error: "forbidden" };
    await deliverPending(db, p, log);
    expect((await deliveries())[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("a notification that could not be sent for an hour is dropped, not delivered late", async () => {
    await queued(); await db.query("UPDATE notification_deliveries SET created_at = now() - interval '2 hours'");
    const p = new FakePush(); await deliverPending(db, p, log);
    expect(p.sent).toHaveLength(0); expect((await deliveries())[0]!.status).toBe("failed");
  });

  it("two senders at once never send the same notification twice", async () => {
    await queued(); const a = new FakePush(), b = new FakePush();
    await Promise.all([deliverPending(db, a, log), deliverPending(db, b, log)]);
    expect(a.sent.length + b.sent.length).toBe(1);
  });
});

describe("HTTP API", () => {
  const RP = "factory.example.test", ORIGIN = "https://factory.example.test";
  const json = { "content-type": "application/json" };
  async function signedIn(push: PushSender | null) {
    const h = testHub(db, { VAPID_PUBLIC_KEY: TEST_VAPID.publicKey, VAPID_PRIVATE_KEY: TEST_VAPID.privateKey, VAPID_SUBJECT: "mailto:a@example.test" }, push);
    const a = new SoftAuthenticator(RP, ORIGIN);
    const o = (await h.app.inject({ method: "POST", url: "/auth/setup/options", headers: json, payload: { setupToken: "setup-token-for-tests-1234567", email: "me@example.test", displayName: "Me" } })).json();
    const v = await h.app.inject({ method: "POST", url: "/auth/setup/verify", headers: json, payload: { challengeId: o.challengeId, response: a.register(o.options) } });
    const cookie = String(v.headers["set-cookie"]).split(";")[0]!;
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => h.app.inject({ method, url, headers: { ...json, cookie }, ...(payload ? { payload } : {}) });
    return { h, call };
  }

  it("says push is off, and refuses to subscribe, when the hub has no VAPID keys", async () => {
    const off = await signedIn(null);
    expect((await off.call("GET", "/v1/push/config")).json()).toEqual({ enabled: false, publicKey: null });
    expect((await off.call("POST", "/v1/push/subscribe", { endpoint: FCM, keys: KEYS })).statusCode).toBe(503);
    expect((await off.call("POST", "/v1/push/test", {})).statusCode).toBe(503);
    expect((await off.h.app.inject("/v1/push/config")).statusCode).toBe(401); // and needs a session
  });

  it("hands the browser the public key when it is configured", async () => {
    const on = await signedIn(new FakePush());
    expect((await on.call("GET", "/v1/push/config")).json()).toEqual({ enabled: true, publicKey: TEST_VAPID.publicKey });
  });

  it("stores a subscription, refuses unknown push hosts, and a test notification is delivered through the normal path", async () => {
    const p = new FakePush(); const { call } = await signedIn(p);
    expect((await call("POST", "/v1/push/subscribe", { endpoint: "https://evil.example/x", keys: KEYS })).statusCode).toBe(400);
    expect((await call("POST", "/v1/push/subscribe", { endpoint: FCM, keys: KEYS })).statusCode).toBe(200);
    expect((await call("POST", "/v1/push/subscribe", { endpoint: FCM, keys: KEYS })).statusCode).toBe(200); // same browser again: still one row
    expect((await db.query("SELECT 1 FROM push_subscriptions")).rows).toHaveLength(1);
    expect((await call("POST", "/v1/push/test", {})).json()).toEqual({ queued: 1 });
    await deliverPending(db, p, log);
    expect(p.sent[0]!.payload).toMatchObject({ type: "test", url: "/" });
    expect((await call("POST", "/v1/push/unsubscribe", { endpoint: FCM })).statusCode).toBe(200);
    expect((await db.query("SELECT 1 FROM push_subscriptions")).rows).toHaveLength(0);
  });

  it("lists preferences (all on by default) and saves changes, which then stop notifications", async () => {
    const { call } = await signedIn(new FakePush());
    expect((await call("GET", "/v1/notifications/preferences")).json().types.map((t: { id: string; enabled: boolean }) => [t.id, t.enabled])).toEqual([["job.failed", true], ["job.needs_attention", true]]);
    expect((await call("PUT", "/v1/notifications/preferences", { types: { "job.failed": false } })).statusCode).toBe(200);
    expect((await call("GET", "/v1/notifications/preferences")).json().types[0]).toMatchObject({ id: "job.failed", enabled: false });
    expect((await call("PUT", "/v1/notifications/preferences", { types: { bogus: true } })).statusCode).toBe(400);
  });

  it("serves the PWA files with the right types and a CSP that allows the manifest and worker", async () => {
    const { h } = await signedIn(null);
    expect((await h.app.inject("/manifest.webmanifest")).headers["content-type"]).toContain("application/manifest+json");
    const sw = await h.app.inject("/sw.js");
    expect(sw.headers["content-type"]).toContain("javascript"); expect(sw.headers["cache-control"]).toBe("no-cache");
    expect(sw.headers["content-security-policy"]).toMatch(/manifest-src 'self'; worker-src 'self'/);
    for (const f of ["/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"]) expect((await h.app.inject(f)).headers["content-type"], f).toBe("image/png");
    const m = (await h.app.inject("/manifest.webmanifest")).json();
    expect(m).toMatchObject({ display: "standalone", start_url: "/", scope: "/" });
    expect((await h.app.inject("/")).body).toContain('rel="manifest"');
  });
});
