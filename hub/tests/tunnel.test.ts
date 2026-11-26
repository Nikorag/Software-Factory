import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession, issueFactoryCredential } from "../src/auth.js";
import { freshDb, seed, testHub } from "./helpers.js";

let db: Awaited<ReturnType<typeof freshDb>>; let s: Awaited<ReturnType<typeof seed>>; let h: ReturnType<typeof testHub>; let web: string;
const INDEX = '<!doctype html><html><head><meta name="factory-hub-base" content="" /></head><body><div id="root"></div><script type="module" src="/assets/app-abc123.js"></script></body></html>';

beforeEach(async () => {
  db = await freshDb(); s = await seed(db);
  web = mkdtempSync(join(tmpdir(), "web-")); mkdirSync(join(web, "assets")); writeFileSync(join(web, "index.html"), INDEX); writeFileSync(join(web, "assets", "app-abc123.js"), "console.log(1)"); writeFileSync(join(tmpdir(), "secret-outside.txt"), "nope");
  h = testHub(db, { WEB_DIST_DIR: web, TUNNEL_TIMEOUT_SECONDS: "2" });
});
const online = (remote = true) => db.query("UPDATE factories SET last_seen_at = now(), metadata = $2 WHERE id = $1", [s.factory, JSON.stringify({ remoteAccess: remote })]);
const cookie = async (uid: string) => `sfh_session=${(await createSession(h.cfg, db, uid)).cookie}`;
const factoryAuth = async () => ({ authorization: `Bearer ${await issueFactoryCredential(h.cfg, db, s.factory)}` });
const UI = { "x-factory-ui": "1" };

/** Plays the local factory: waits for the next tunnel request and answers it. */
async function factoryAnswers(answer: (r: { method: string; path: string; headers: Record<string, string>; bodyBase64?: string }) => object, status = 200) {
  const headers = await factoryAuth();
  for (let i = 0; i < 100; i++) {
    const r = await h.app.inject({ url: "/v1/factory/tunnel/next?wait=0", headers });
    if (r.statusCode === 200) {
      const req = r.json().requests[0]; const body = answer(req);
      return h.app.inject({ method: "POST", url: `/v1/factory/tunnel/${req.id}/response`, headers, payload: { status, headers: { "content-type": "application/json", "set-cookie": "evil=1", location: "https://evil.example" }, bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64") } });
    }
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("no tunnel request arrived");
}

describe("API tunnel (browser -> hub -> factory)", () => {
  it("relays a GET and returns the factory's response", async () => {
    await online(); const ck = await cookie(s.admin);
    const [res, ans] = await Promise.all([h.app.inject({ url: `/f/${s.factory}/api/overview?x=1`, headers: { cookie: ck } }), factoryAnswers((r) => ({ saw: r.path, method: r.method }))]);
    expect(ans.statusCode).toBe(200);
    expect(res.statusCode).toBe(200); expect(res.json()).toEqual({ saw: "/api/overview?x=1", method: "GET" });
    expect(res.headers["set-cookie"]).toBeUndefined(); expect(res.headers.location).toBeUndefined(); // factory can't set cookies/redirects on our origin
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("relays a JSON POST with its body, passes only whitelisted request headers, and audits method+route (not body)", async () => {
    await online(); const ck = await cookie(s.admin);
    let seen: { headers: Record<string, string>; bodyBase64?: string } | undefined;
    const [res] = await Promise.all([
      h.app.inject({ method: "POST", url: `/f/${s.factory}/api/jobs/j1/answer`, headers: { cookie: ck, ...UI, "content-type": "application/json", authorization: "Bearer should-not-forward", "x-evil": "1" }, payload: { answer: "private-answer" } }),
      factoryAnswers((r) => { seen = r; return { ok: true }; }),
    ]);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(seen!.headers).sort()).toEqual(["content-type"]);
    expect(JSON.parse(Buffer.from(seen!.bodyBase64!, "base64").toString())).toEqual({ answer: "private-answer" });
    const a = (await db.query<{ action: string; detail: Record<string, string> }>("SELECT action, detail FROM audit_events WHERE action='tunnel.request'")).rows;
    expect(a).toHaveLength(1); expect(a[0]!.detail).toEqual({ method: "POST", path: "/api/jobs/j1/answer" });
    expect(JSON.stringify(a)).not.toContain("private-answer");
  });

  it("does not audit reads", async () => {
    await online(); const ck = await cookie(s.admin);
    await Promise.all([h.app.inject({ url: `/f/${s.factory}/api/overview`, headers: { cookie: ck } }), factoryAnswers(() => ({}))]);
    expect((await db.query("SELECT 1 FROM audit_events WHERE action='tunnel.request'")).rows).toHaveLength(0);
  });

  it("requires a session, and the UI header + same origin for changes", async () => {
    await online();
    expect((await h.app.inject({ url: `/f/${s.factory}/api/overview` })).statusCode).toBe(401);
    const ck = await cookie(s.admin);
    const post = (headers: Record<string, string>) => h.app.inject({ method: "POST", url: `/f/${s.factory}/api/control/pause`, headers: { cookie: ck, "content-type": "application/json", ...headers }, payload: {} });
    expect((await post({})).statusCode).toBe(403);                                   // no X-Factory-UI
    expect((await post({ ...UI, origin: "https://evil.example" })).statusCode).toBe(403); // wrong origin
    expect(h.tunnel.queues.get(s.factory) ?? []).toHaveLength(0);                    // nothing reached the factory
  });

  it("enforces per-factory permissions: viewers can read but not change; outsiders see nothing", async () => {
    await online();
    const v = await cookie(s.viewer);
    expect((await h.app.inject({ method: "POST", url: `/f/${s.factory}/api/control/pause`, headers: { cookie: v, ...UI, "content-type": "application/json" }, payload: {} })).statusCode).toBe(403);
    expect((await h.app.inject({ url: `/f/${s.factory}/api/overview`, headers: { cookie: await cookie(s.outsider) } })).statusCode).toBe(404);
    expect((await h.app.inject({ url: `/f/${s.factory}/api/overview`, headers: { cookie: v } })).statusCode).not.toBe(404);
  });

  it("fails fast with a clear message when remote access is off or the factory is offline", async () => {
    const ck = await cookie(s.admin); const get = () => h.app.inject({ url: `/f/${s.factory}/api/overview`, headers: { cookie: ck } });
    await online(false);
    expect((await get()).json()).toMatchObject({ error: "remote_access_disabled" });
    await online(true); await db.query("UPDATE factories SET last_seen_at = now() - interval '10 minutes'");
    expect((await get()).statusCode).toBe(504); expect((await get()).json().error).toBe("factory_offline");
    await online(true); await db.query("UPDATE factories SET status='disabled'");
    expect((await get()).json().error).toBe("factory_disabled");
    expect(h.tunnel.queues.get(s.factory) ?? []).toHaveLength(0);
  });

  it("times out (504) rather than queueing for later, and a late response is rejected", async () => {
    await online(); const ck = await cookie(s.admin);
    const res = await h.app.inject({ url: `/f/${s.factory}/api/overview`, headers: { cookie: ck } });
    expect(res.statusCode).toBe(504); expect(res.json().error).toBe("factory_timeout");
    const headers = await factoryAuth();
    const leftover = h.tunnel.queues.get(s.factory)![0]!; // the factory (offline) never took it
    const late = await h.app.inject({ method: "POST", url: `/v1/factory/tunnel/${leftover.id}/response`, headers, payload: { status: 200, bodyBase64: "e30=" } });
    expect(late.statusCode).toBe(404);
  });

  it("delivers each request to exactly one poller and accepts one response", async () => {
    await online(); const ck = await cookie(s.admin); const headers = await factoryAuth();
    const pending = h.app.inject({ url: `/f/${s.factory}/api/overview`, headers: { cookie: ck } });
    await new Promise((ok) => setTimeout(ok, 50));
    const poll = () => h.app.inject({ url: "/v1/factory/tunnel/next?wait=0", headers });
    const [a, b] = await Promise.all([poll(), poll()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 204]);
    const req = (a.statusCode === 200 ? a : b).json().requests[0];
    const respond = () => h.app.inject({ method: "POST", url: `/v1/factory/tunnel/${req.id}/response`, headers, payload: { status: 200, bodyBase64: "e30=" } });
    expect((await respond()).statusCode).toBe(200); expect((await respond()).statusCode).toBe(404);
    expect((await pending).statusCode).toBe(200);
  });

  it("applies backpressure when a factory has too many waiting requests", async () => {
    await online(); h.tunnel.full = true;
    expect((await h.app.inject({ url: `/f/${s.factory}/api/overview`, headers: { cookie: await cookie(s.admin) } })).statusCode).toBe(503);
  });

  it("a factory poll marks it online and only a factory token can poll", async () => {
    await db.query("UPDATE factories SET last_seen_at = NULL");
    expect((await h.app.inject({ url: "/v1/factory/tunnel/next" })).statusCode).toBe(401);
    expect((await h.app.inject({ url: "/v1/factory/tunnel/next?wait=0", headers: await factoryAuth() })).statusCode).toBe(204);
    expect((await db.query<{ last_seen_at: Date | null }>("SELECT last_seen_at FROM factories")).rows[0]!.last_seen_at).not.toBeNull();
  });

  it("heartbeat metadata carries remoteAccess, which gates the tunnel", async () => {
    const hb = await factoryAuth();
    await h.app.inject({ method: "POST", url: "/v1/factory/heartbeat", headers: hb, payload: { version: "1", metadata: { remoteAccess: true } } });
    const ck = await cookie(s.admin);
    const [res] = await Promise.all([h.app.inject({ url: `/f/${s.factory}/api/overview`, headers: { cookie: ck } }), factoryAnswers(() => ({ hi: 1 }))]);
    expect(res.json()).toEqual({ hi: 1 });
  });
});

describe("shared dashboard build served by the hub", () => {
  it("serves the factory's own index.html for one factory with the base filled in", async () => {
    const r = await h.app.inject({ url: `/f/${s.factory}/`, headers: { cookie: await cookie(s.admin) } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`<meta name="factory-hub-base" content="/f/${s.factory}" />`);
    expect(r.body).toContain("/assets/app-abc123.js");
    expect(r.headers["content-security-policy"]).toContain("script-src 'self'");
    expect((await h.app.inject({ url: `/f/${s.factory}`, headers: { cookie: await cookie(s.admin) } })).statusCode).toBe(200);
  });
  it("redirects anonymous users to sign in and hides other people's factories", async () => {
    expect((await h.app.inject({ url: `/f/${s.factory}/` })).headers.location).toBe("/");
    expect((await h.app.inject({ url: `/f/${s.factory}/`, headers: { cookie: await cookie(s.outsider) } })).statusCode).toBe(404);
    expect((await h.app.inject({ url: `/f/not-a-uuid/`, headers: { cookie: await cookie(s.admin) } })).statusCode).toBe(404);
  });
  it("serves hashed assets safely", async () => {
    const ok = await h.app.inject("/assets/app-abc123.js");
    expect(ok.statusCode).toBe(200); expect(ok.headers["content-type"]).toContain("javascript");
    for (const bad of ["/assets/..%2Fsecret-outside.txt", "/assets/.env", "/assets/missing.js"]) expect((await h.app.inject(bad)).statusCode).toBe(404);
  });
  it("tells you when the build is missing instead of failing obscurely", async () => {
    const h2 = testHub(db, { WEB_DIST_DIR: join(tmpdir(), "nope-nope") });
    expect((await h2.app.inject({ url: `/f/${s.factory}/`, headers: { cookie: await cookie(s.admin) } })).statusCode).toBe(503);
  });
});
