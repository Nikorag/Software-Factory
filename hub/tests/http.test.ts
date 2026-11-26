import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, issueFactoryCredential } from "../src/auth.js";
import { createLogger } from "../src/log.js";
import { freshDb, pgliteDb, seed, testHub } from "./helpers.js";

let db: Awaited<ReturnType<typeof freshDb>>; let s: Awaited<ReturnType<typeof seed>>; let h: ReturnType<typeof testHub>;
beforeEach(async () => { db = await freshDb(); s = await seed(db); h = testHub(db); });

const factoryToken = () => issueFactoryCredential(h.cfg, db, s.factory);
const cookie = async (uid: string) => `sfh_session=${(await createSession(h.cfg, db, uid)).cookie}`;
const fh = async () => ({ authorization: `Bearer ${await factoryToken()}` });
const json = { "content-type": "application/json" };

describe("health probes", () => {
  it("liveness stays green when PostgreSQL and Redis are down", async () => {
    h.bus.down = true; await db.close();
    expect((await h.app.inject("/healthz/live")).statusCode).toBe(200);
    expect((await h.app.inject("/healthz/ready")).statusCode).toBe(503); // not ready => removed from Service, not restarted
  });
  it("readiness reports dependency state", async () => {
    const ok = await h.app.inject("/healthz/ready");
    expect(ok.statusCode).toBe(200); expect(ok.json().checks).toEqual({ postgres: "ok", redis: "ok", migrations: "ok" });
    h.bus.down = true; await new Promise((r) => setTimeout(r, 1100)); // readiness result is cached for 1s
    const bad = await h.app.inject("/healthz/ready");
    expect(bad.statusCode).toBe(503); expect(bad.json().checks.redis).toMatch(/redis down/);
  });
  it("is not ready while migrations are pending", async () => {
    const h2 = testHub(pgliteDb());
    const r = await h2.app.inject("/healthz/ready");
    expect(r.statusCode).toBe(503); expect(r.json().checks.migrations).toMatch(/pending/);
  });
  it("startup probe is 503 until initialised; readiness 503 once shutting down", async () => {
    h.hub.state.initialised = false;
    expect((await h.app.inject("/healthz/startup")).statusCode).toBe(503);
    h.hub.state.initialised = true; h.hub.state.shuttingDown = true;
    expect((await h.app.inject("/healthz/ready")).statusCode).toBe(503);
    expect((await h.app.inject("/healthz/live")).statusCode).toBe(200);
  });
});

describe("factory API", () => {
  it("rejects missing, malformed, wrong and revoked tokens", async () => {
    expect((await h.app.inject({ method: "POST", url: "/v1/factory/heartbeat", payload: {} })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "POST", url: "/v1/factory/heartbeat", headers: { authorization: "Bearer nope" }, payload: {} })).statusCode).toBe(401);
    const t = await factoryToken(); const forged = t.slice(0, -3) + "AAA";
    expect((await h.app.inject({ method: "POST", url: "/v1/factory/heartbeat", headers: { authorization: `Bearer ${forged}` }, payload: {} })).statusCode).toBe(401);
    await db.query("UPDATE factory_credentials SET revoked_at = now()");
    expect((await h.app.inject({ method: "POST", url: "/v1/factory/heartbeat", headers: { authorization: `Bearer ${t}` }, payload: {} })).statusCode).toBe(401);
  });

  it("stores only a hash of the factory token", async () => {
    const t = await factoryToken(); const secret = t.split(".")[1]!;
    const row = (await db.query<{ secret_hash: string }>("SELECT secret_hash FROM factory_credentials")).rows[0]!;
    expect(row.secret_hash).not.toContain(secret);
  });

  it("end to end: user issues a command, the factory polls, acks, and reports", async () => {
    const headers = await fh(); const ck = await cookie(s.admin);
    const created = await h.app.inject({ method: "POST", url: `/v1/factories/${s.factory}/commands`, headers: { cookie: ck, ...json }, payload: { type: "pause", payload: { reason: "lunch" } } });
    expect(created.statusCode).toBe(202); const id = created.json().id;
    await h.commands.relayOutbox(); await h.queue.drain();

    const poll = await h.app.inject({ method: "GET", url: "/v1/factory/commands/next", headers });
    expect(poll.statusCode).toBe(200);
    const cmd = poll.json().commands[0]; expect(cmd).toMatchObject({ id, type: "pause", payload: { reason: "lunch" } });
    expect((await h.app.inject({ method: "GET", url: "/v1/factory/commands/next", headers })).statusCode).toBe(204);

    expect((await h.app.inject({ method: "POST", url: `/v1/factory/commands/${id}/ack`, headers, payload: { leaseToken: cmd.leaseToken } })).statusCode).toBe(200);
    const done = await h.app.inject({ method: "POST", url: `/v1/factory/commands/${id}/result`, headers, payload: { leaseToken: cmd.leaseToken, outcome: "succeeded", result: { paused: true } } });
    expect(done.statusCode).toBe(200);
    const got = await h.app.inject({ url: `/v1/commands/${id}`, headers: { cookie: ck } });
    expect(got.json()).toMatchObject({ status: "succeeded", result: { paused: true } });
  });

  it("tells the factory NOT to execute when the command was revoked", async () => {
    const headers = await fh(); const ck = await cookie(s.admin);
    const id = (await h.app.inject({ method: "POST", url: `/v1/factories/${s.factory}/commands`, headers: { cookie: ck, ...json }, payload: { type: "pause" } })).json().id;
    const cmd = (await h.app.inject({ method: "GET", url: "/v1/factory/commands/next", headers })).json().commands[0];
    await h.app.inject({ method: "POST", url: `/v1/commands/${id}/revoke`, headers: { cookie: ck, ...json }, payload: {} });
    const ack = await h.app.inject({ method: "POST", url: `/v1/factory/commands/${id}/ack`, headers, payload: { leaseToken: cmd.leaseToken } });
    expect(ack.statusCode).toBe(409); expect(ack.json()).toMatchObject({ execute: false, status: "revoked" });
  });

  it("long-poll returns promptly when a command is dispatched (cross-replica wake via pub/sub)", async () => {
    const headers = await fh();
    const waiting = h.app.inject({ method: "GET", url: "/v1/factory/commands/next?wait=10", headers });
    await new Promise((r) => setTimeout(r, 50));
    await h.commands.create(s.admin, s.factory, { type: "resume" });
    await h.commands.relayOutbox(); await h.queue.drain(); // publishes the wake
    const t0 = Date.now(); const res = await waiting;
    expect(res.statusCode).toBe(200); expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("ingests events idempotently and syncs metadata", async () => {
    const headers = await fh();
    await h.app.inject({ method: "POST", url: "/v1/factory/sync", headers, payload: { projects: [{ id: "p1", name: "P" }], jobs: [{ id: "j1", projectId: "p1", stage: "intake" }], workflows: [{ id: "w1", name: "Default" }] } });
    const body = { events: [{ id: "e1", type: "job.stage", jobId: "j1", occurredAt: new Date().toISOString(), payload: { to: "spec" } }] };
    expect((await h.app.inject({ method: "POST", url: "/v1/factory/events", headers, payload: body })).json()).toMatchObject({ accepted: 1, duplicates: 0 });
    expect((await h.app.inject({ method: "POST", url: "/v1/factory/events", headers, payload: body })).json()).toMatchObject({ accepted: 0, duplicates: 1 });
    expect((await db.query("SELECT 1 FROM jobs WHERE project_id IS NOT NULL")).rows).toHaveLength(1);
  });

  it("validates input", async () => {
    const headers = await fh();
    expect((await h.app.inject({ method: "POST", url: "/v1/factory/events", headers, payload: { events: [] } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "POST", url: "/v1/factory/commands/not-a-uuid/ack", headers, payload: {} })).statusCode).toBe(400);
  });
});

describe("user API", () => {
  it("requires a valid session; rejects forged cookies, expired sessions and non-JSON mutations", async () => {
    const url = `/v1/factories/${s.factory}/commands`;
    expect((await h.app.inject({ method: "POST", url, headers: json, payload: { type: "pause" } })).statusCode).toBe(401);
    const ck = await cookie(s.admin);
    expect((await h.app.inject({ method: "POST", url, headers: { cookie: ck.slice(0, -2) + "xx", ...json }, payload: { type: "pause" } })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "POST", url, headers: { cookie: ck, "content-type": "text/plain" }, payload: "type=pause" })).statusCode).toBe(415);
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    expect((await h.app.inject({ url: "/v1/me", headers: { cookie: ck } })).statusCode).toBe(401);
  });
  it("sessions live in PostgreSQL, so a different replica accepts them", async () => {
    const ck = await cookie(s.admin); const other = testHub(db);
    expect((await other.app.inject({ url: "/v1/me", headers: { cookie: ck } })).json()).toMatchObject({ userId: s.admin });
  });
  it("forbids a viewer from commanding and a non-member from reading", async () => {
    expect((await h.app.inject({ method: "POST", url: `/v1/factories/${s.factory}/commands`, headers: { cookie: await cookie(s.viewer), ...json }, payload: { type: "pause" } })).statusCode).toBe(403);
    const id = (await h.commands.create(s.admin, s.factory, { type: "pause" })).command.id;
    expect((await h.app.inject({ url: `/v1/commands/${id}`, headers: { cookie: await cookie(s.outsider) } })).statusCode).toBe(404);
  });
  it("registers a factory and returns its token once", async () => {
    const r = await h.app.inject({ method: "POST", url: "/v1/factories", headers: { cookie: await cookie(s.admin), ...json }, payload: { orgId: s.org, name: "new-box" } });
    expect(r.statusCode).toBe(201);
    const hb = await h.app.inject({ method: "POST", url: "/v1/factory/heartbeat", headers: { authorization: `Bearer ${r.json().token}` }, payload: { version: "1.2.3" } });
    expect(hb.statusCode).toBe(200);
    expect((await db.query<{ status: string; version: string }>("SELECT status, version FROM factories WHERE name='new-box'")).rows[0]).toEqual({ status: "active", version: "1.2.3" });
    expect((await h.app.inject({ method: "POST", url: "/v1/factories", headers: { cookie: await cookie(s.viewer), ...json }, payload: { orgId: s.org, name: "x" } })).statusCode).toBe(403);
  });
});

describe("logging", () => {
  it("does not leak credentials, tokens, payloads or VAPID keys", () => {
    const sink = new PassThrough(); let out = ""; sink.on("data", (c) => (out += c));
    const log = createLogger("info", sink);
    log.info({ req: { headers: { authorization: "Bearer sfh_secret", cookie: "sfh_session=abc" } }, creds: { token: "TOKVAL1", privateKey: "vapid-private", p256dh: "k", auth: "a" }, cmd: { payload: { repo: "repo-private-name" } } }, "x");
    for (const secret of ["sfh_secret", "sfh_session=abc", "TOKVAL1", "vapid-private", "repo-private-name"]) expect(out).not.toContain(secret);
  });
});
