import { beforeEach, describe, expect, it } from "vitest";
import { CommandError } from "../src/commands.js";
import { freshDb, seed, testHub } from "./helpers.js";

let db: Awaited<ReturnType<typeof freshDb>>; let s: Awaited<ReturnType<typeof seed>>; let h: ReturnType<typeof testHub>;
beforeEach(async () => { db = await freshDb(); s = await seed(db); h = testHub(db); });
const status = async (id: string) => (await db.query<{ status: string }>("SELECT status FROM remote_commands WHERE id=$1", [id])).rows[0]!.status;
const make = async (o: Record<string, unknown> = {}) => (await h.commands.create(s.admin, s.factory, { type: "pause", ...o })).command;

describe("authorisation (step 1)", () => {
  it("rejects viewers and non-members, and persists nothing", async () => {
    await expect(h.commands.create(s.viewer, s.factory, { type: "pause" })).rejects.toBeInstanceOf(CommandError);
    await expect(h.commands.create(s.outsider, s.factory, { type: "pause" })).rejects.toThrow(/not allowed/);
    expect((await db.query("SELECT 1 FROM remote_commands")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM outbox")).rows).toHaveLength(0);
  });
  it("a factory-level 'command' grant authorises a non-admin", async () => {
    await db.query("INSERT INTO factory_permissions (factory_id, user_id, permission) VALUES ($1,$2,'command')", [s.factory, s.viewer]);
    await expect(h.commands.create(s.viewer, s.factory, { type: "pause" })).resolves.toBeTruthy();
  });
});

describe("durability (steps 2-3)", () => {
  it("writes the command and its outbox row atomically; nothing is on Redis until the relay runs", async () => {
    const c = await make();
    expect(c.status).toBe("pending");
    expect((await db.query("SELECT 1 FROM outbox WHERE aggregate_id=$1 AND dispatched_at IS NULL", [c.id])).rows).toHaveLength(1);
    expect(h.queue.jobs).toEqual([]);
    expect(await h.commands.relayOutbox()).toBe(1);
    expect(h.queue.jobs).toEqual([c.id]);
    expect((await db.query("SELECT 1 FROM outbox WHERE dispatched_at IS NULL")).rows).toHaveLength(0);
  });

  it("a rolled-back transaction leaves neither a command nor an outbox row", async () => {
    await expect(db.tx(async (q) => {
      await q.query("INSERT INTO remote_commands (org_id, factory_id, type, expires_at) VALUES ($1,$2,'x', now() + interval '1 hour')", [s.org, s.factory]);
      await q.query("INSERT INTO outbox (topic, aggregate_id) VALUES ('command.dispatch', gen_random_uuid())");
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await db.query("SELECT 1 FROM remote_commands")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM outbox")).rows).toHaveLength(0);
  });

  it("keeps the outbox row and retries when Redis is down at relay time", async () => {
    const c = await make(); h.queue.down = true;
    expect(await h.commands.relayOutbox()).toBe(0);
    expect((await db.query("SELECT attempts FROM outbox")).rows[0]).toMatchObject({ attempts: 1 });
    h.queue.down = false; await db.query("UPDATE outbox SET available_at = now()");
    expect(await h.commands.relayOutbox()).toBe(1);
    expect(h.queue.jobs).toEqual([c.id]);
  });

  it("dedupes on clientKey", async () => {
    const a = await h.commands.create(s.admin, s.factory, { type: "pause", clientKey: "k1" });
    const b = await h.commands.create(s.admin, s.factory, { type: "pause", clientKey: "k1" });
    expect(b.created).toBe(false); expect(b.command.id).toBe(a.command.id);
    expect((await db.query("SELECT 1 FROM outbox")).rows).toHaveLength(1);
  });
});

describe("delivery, ack and result (steps 4-7)", () => {
  it("runs the full happy path", async () => {
    const c = await make({ payload: { a: 1 } });
    await h.commands.relayOutbox(); await h.queue.drain();
    expect(await status(c.id)).toBe("queued");
    expect(h.bus.published.some(([ch, m]) => ch === `wake:${s.factory}` && m === c.id)).toBe(true);
    const [d] = await h.commands.claim(s.factory);
    expect(d).toMatchObject({ id: c.id, payload: { a: 1 }, attempts: 1 });
    expect(await status(c.id)).toBe("delivered");
    expect(await h.commands.ack(s.factory, c.id, d!.lease_token!)).toEqual({ ok: true });
    expect(await h.commands.complete(s.factory, c.id, d!.lease_token!, "succeeded", { done: true })).toEqual({ ok: true, duplicate: false });
    expect(await status(c.id)).toBe("succeeded");
    expect((await db.query("SELECT action FROM audit_events ORDER BY id")).rows.map((r) => (r as { action: string }).action)).toEqual(["command.create", "command.succeeded"]);
  });

  it("delivers a pending command straight from PostgreSQL even if Redis never saw it", async () => {
    const c = await make(); // no relay, no worker
    expect((await h.commands.claim(s.factory)).map((x) => x.id)).toEqual([c.id]);
  });

  it("never gives the same command to two pollers", async () => {
    await make();
    const [a, b] = await Promise.all([h.commands.claim(s.factory), h.commands.claim(s.factory)]);
    expect(a!.length + b!.length).toBe(1);
  });

  it("is scoped to the factory", async () => {
    await make();
    const other = (await db.query<{ id: string }>("INSERT INTO factories (org_id, name) VALUES ($1,'other') RETURNING id", [s.org])).rows[0]!.id;
    expect(await h.commands.claim(other)).toHaveLength(0);
  });

  it("ack and result are idempotent; a stale token is refused", async () => {
    const c = await make(); const [d] = await h.commands.claim(s.factory); const t = d!.lease_token!;
    expect((await h.commands.ack(s.factory, c.id, t)).ok).toBe(true);
    expect((await h.commands.ack(s.factory, c.id, t)).ok).toBe(true); // re-ack extends
    expect((await h.commands.ack(s.factory, c.id, "00000000-0000-4000-8000-000000000000")).ok).toBe(false);
    expect(await h.commands.complete(s.factory, c.id, t, "failed", null, "oops")).toEqual({ ok: true, duplicate: false });
    expect(await h.commands.complete(s.factory, c.id, t, "failed", null, "oops")).toEqual({ ok: true, duplicate: true });
    expect((await h.commands.complete(s.factory, c.id, t, "succeeded", {})).ok).toBe(false); // can't flip the outcome
    expect(await status(c.id)).toBe("failed");
  });

  it("requires ack before a result is accepted", async () => {
    const c = await make(); const [d] = await h.commands.claim(s.factory);
    expect((await h.commands.complete(s.factory, c.id, d!.lease_token!, "succeeded", {})).ok).toBe(false);
  });

  it("another factory cannot ack or complete it", async () => {
    const c = await make(); const [d] = await h.commands.claim(s.factory);
    const other = (await db.query<{ id: string }>("INSERT INTO factories (org_id, name) VALUES ($1,'other') RETURNING id", [s.org])).rows[0]!.id;
    expect((await h.commands.ack(other, c.id, d!.lease_token!)).ok).toBe(false);
  });
});

describe("expired, revoked and unauthorised commands never execute", () => {
  it("revoked before delivery is never delivered", async () => {
    const c = await make(); await h.commands.revoke(s.admin, c.id);
    expect(await h.commands.claim(s.factory)).toHaveLength(0);
    await h.commands.onDispatch(c.id); expect(await status(c.id)).toBe("revoked"); // late queue job is a no-op
  });
  it("revoked after delivery but before ack: ack is refused", async () => {
    const c = await make(); const [d] = await h.commands.claim(s.factory);
    await h.commands.revoke(s.admin, c.id);
    expect(await h.commands.ack(s.factory, c.id, d!.lease_token!)).toEqual({ ok: false, status: "revoked" });
  });
  it("cannot revoke once acknowledged", async () => {
    const c = await make(); const [d] = await h.commands.claim(s.factory); await h.commands.ack(s.factory, c.id, d!.lease_token!);
    await expect(h.commands.revoke(s.admin, c.id)).rejects.toMatchObject({ code: "conflict" });
  });
  it("only an authorised user can revoke", async () => {
    const c = await make(); await expect(h.commands.revoke(s.viewer, c.id)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("expired commands are not delivered and cannot be acked", async () => {
    const c = await make(); const [d] = await h.commands.claim(s.factory);
    await db.query("UPDATE remote_commands SET expires_at = now() - interval '1 second' WHERE id=$1", [c.id]);
    expect((await h.commands.ack(s.factory, c.id, d!.lease_token!)).ok).toBe(false);
    expect((await h.commands.reconcile()).expired).toBe(1);
    expect(await status(c.id)).toBe("expired");
    expect(await h.commands.claim(s.factory)).toHaveLength(0);
  });
});

describe("redelivery and execute-at-most-once", () => {
  const lapse = (id: string) => db.query("UPDATE remote_commands SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [id]);

  it("redelivers a command that was delivered but never acknowledged (it cannot have run)", async () => {
    const c = await make(); const [d1] = await h.commands.claim(s.factory); await lapse(c.id);
    const [d2] = await h.commands.claim(s.factory);
    expect(d2).toMatchObject({ id: c.id, attempts: 2 }); expect(d2!.lease_token).not.toBe(d1!.lease_token);
    expect((await h.commands.ack(s.factory, c.id, d1!.lease_token!)).ok).toBe(false); // the old holder lost it
  });

  it("does NOT re-run an acknowledged non-repeatable command whose lease lapsed: parks it as unknown", async () => {
    const c = await make(); const [d] = await h.commands.claim(s.factory); await h.commands.ack(s.factory, c.id, d!.lease_token!); await lapse(c.id);
    expect(await h.commands.claim(s.factory)).toHaveLength(0);
    expect((await h.commands.reconcile()).unknown).toBe(1);
    expect(await status(c.id)).toBe("unknown");
    expect(await h.commands.claim(s.factory)).toHaveLength(0);
    // ...but the original holder can still report what really happened
    expect(await h.commands.complete(s.factory, c.id, d!.lease_token!, "succeeded", { ok: 1 })).toEqual({ ok: true, duplicate: false });
  });

  it("re-runs an acknowledged repeatable command", async () => {
    const c = await make({ repeatable: true }); const [d] = await h.commands.claim(s.factory); await h.commands.ack(s.factory, c.id, d!.lease_token!); await lapse(c.id);
    expect((await h.commands.claim(s.factory)).map((x) => x.id)).toEqual([c.id]);
  });

  it("gives up after max delivery attempts", async () => {
    h = testHub(db, { COMMAND_MAX_DELIVERY_ATTEMPTS: "2" });
    const c = await make();
    for (let i = 0; i < 2; i++) { await h.commands.claim(s.factory); await lapse(c.id); }
    expect(await h.commands.claim(s.factory)).toHaveLength(0);
    expect((await h.commands.reconcile()).failed).toBe(1);
    expect(await status(c.id)).toBe("failed");
  });
});

describe("Redis loss and restarts", () => {
  it("re-enqueues pending work from PostgreSQL after Redis loses its queue", async () => {
    const c = await make(); await h.commands.relayOutbox();
    h.queue.flush(); // Redis restarted with no persistence: the job is gone, the outbox row is already 'dispatched'
    expect(h.queue.jobs).toEqual([]);
    await db.query("UPDATE remote_commands SET updated_at = now() - interval '1 minute'");
    expect((await h.commands.reconcile()).reenqueued).toBe(1);
    expect(h.queue.jobs).toEqual([c.id]);
    await h.queue.drain(); expect(await status(c.id)).toBe("queued");
  });

  it("duplicate queue delivery is harmless", async () => {
    const c = await make(); await h.commands.onDispatch(c.id); await h.commands.onDispatch(c.id);
    const d = await h.commands.claim(s.factory); expect(d).toHaveLength(1);
    await h.commands.onDispatch(c.id); // after delivery: must not reset it
    expect(await status(c.id)).toBe("delivered");
  });

  it("a new hub instance over the same database sees pending commands (state is not in memory)", async () => {
    const c = await make(); const h2 = testHub(db);
    expect((await h2.commands.claim(s.factory)).map((x) => x.id)).toEqual([c.id]);
  });
});
