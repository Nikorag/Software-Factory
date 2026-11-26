import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, testHub } from "./helpers.js";
import { SoftAuthenticator } from "./authenticator.js";

let db: Awaited<ReturnType<typeof freshDb>>; let h: ReturnType<typeof testHub>; let auth: SoftAuthenticator;
const json = { "content-type": "application/json" };
const RP = "factory.example.test", ORIGIN = "https://factory.example.test";
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: "POST", url, headers: { ...json, ...headers }, payload: payload as object });
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;

beforeEach(async () => { db = await freshDb(); h = testHub(db); auth = new SoftAuthenticator(RP, ORIGIN); });

async function setup(a = auth, token = "setup-token-for-tests-1234567") {
  const o = await post("/auth/setup/options", { setupToken: token, email: "me@example.test", displayName: "Me" });
  if (o.statusCode !== 200) return { opts: o };
  const { challengeId, options } = o.json();
  return { opts: o, verify: await post("/auth/setup/verify", { challengeId, response: a.register(options) }) };
}
async function login(a = auth, over: Parameters<SoftAuthenticator["assert"]>[1] = {}) {
  const { challengeId, options } = (await post("/auth/login/options", {})).json();
  return post("/auth/login/verify", { challengeId, response: a.assert(options, over) });
}

describe("first-time setup", () => {
  it("reports needsSetup, then creates the first user, org, owner membership and a session", async () => {
    expect((await h.app.inject("/auth/status")).json()).toEqual({ needsSetup: true, authenticated: false });
    const { verify } = await setup();
    expect(verify!.statusCode).toBe(200);
    const ck = cookieOf(verify!);
    expect(String(verify!.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Strict; Path=\/;.*Secure/);
    expect((await h.app.inject({ url: "/auth/status", headers: { cookie: ck } })).json()).toEqual({ needsSetup: false, authenticated: true });
    const me = (await h.app.inject({ url: "/v1/me", headers: { cookie: ck } })).json();
    expect(me).toMatchObject({ email: "me@example.test", orgs: [{ role: "owner" }] });
    expect((await db.query("SELECT 1 FROM passkey_credentials")).rows).toHaveLength(1);
  });

  it("refuses a wrong setup token, and once a user exists setup is closed for everyone", async () => {
    expect((await setup(auth, "wrong-token-wrong-token-wrong")).opts.statusCode).toBe(403);
    expect((await db.query("SELECT 1 FROM users")).rows).toHaveLength(0);
    await setup();
    const again = await setup(new SoftAuthenticator(RP, ORIGIN));
    expect(again.opts.statusCode).toBe(403); expect(again.opts.json().error).toBe("setup_closed");
  });

  it("rejects a passkey without user verification, a wrong origin, and a replayed challenge", async () => {
    const o = (await post("/auth/setup/options", { setupToken: "setup-token-for-tests-1234567", email: "me@example.test", displayName: "Me" })).json();
    expect((await post("/auth/setup/verify", { challengeId: o.challengeId, response: auth.register(o.options, { uv: false }) })).statusCode).toBe(400);
    // the failed attempt consumed the challenge: the same challenge can never be retried
    expect((await post("/auth/setup/verify", { challengeId: o.challengeId, response: auth.register(o.options) })).statusCode).toBe(400);
    expect((await db.query("SELECT 1 FROM users")).rows).toHaveLength(0);
  });

  it("two concurrent setups create exactly one user", async () => {
    const mk = async () => { const a = new SoftAuthenticator(RP, ORIGIN); const o = (await post("/auth/setup/options", { setupToken: "setup-token-for-tests-1234567", email: "me@example.test", displayName: "Me" })).json(); return { a, o }; };
    const [x, y] = await Promise.all([mk(), mk()]);
    const res = await Promise.all([x, y].map(({ a, o }) => post("/auth/setup/verify", { challengeId: o.challengeId, response: a.register(o.options) })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    expect((await db.query("SELECT 1 FROM users")).rows).toHaveLength(1);
  });
});

describe("passkey login", () => {
  beforeEach(async () => { await setup(); });

  it("signs in with the enrolled passkey (usernameless) and updates the counter", async () => {
    const r = await login();
    expect(r.statusCode).toBe(200);
    expect((await h.app.inject({ url: "/v1/me", headers: { cookie: cookieOf(r) } })).statusCode).toBe(200);
    expect((await db.query<{ sign_count: number }>("SELECT sign_count FROM passkey_credentials")).rows[0]!.sign_count).toBe(1);
  });

  it("rejects: unknown passkey, wrong origin, missing user verification, replayed/cloned counter", async () => {
    expect((await login(new SoftAuthenticator(RP, ORIGIN))).statusCode).toBe(401);
    expect((await login(auth, { origin: "https://evil.example" })).statusCode).toBe(401);
    expect((await login(auth, { uv: false })).statusCode).toBe(401);
    expect((await login(auth)).statusCode).toBe(200);
    expect((await login(auth, { counter: 1 })).statusCode).toBe(401); // counter did not advance => cloned authenticator
  });

  it("a challenge cannot be reused", async () => {
    const { challengeId, options } = (await post("/auth/login/options", {})).json();
    const resp = auth.assert(options);
    expect((await post("/auth/login/verify", { challengeId, response: resp })).statusCode).toBe(200);
    expect((await post("/auth/login/verify", { challengeId, response: resp })).statusCode).toBe(400);
  });

  it("has no password path at all", async () => {
    for (const url of ["/auth/login", "/auth/password", "/auth/register"]) expect((await post(url, { email: "me@example.test", password: "x" })).statusCode).toBe(404);
  });

  it("logout revokes the session server-side", async () => {
    const ck = cookieOf(await login());
    await post("/auth/logout", {}, { cookie: ck });
    expect((await h.app.inject({ url: "/v1/me", headers: { cookie: ck } })).statusCode).toBe(401);
  });

  it("add a second passkey, list, and refuse to delete the last one", async () => {
    const ck = cookieOf(await login());
    const second = new SoftAuthenticator(RP, ORIGIN);
    const oRes = await post("/v1/passkeys/options", {}, { cookie: ck });
    expect(oRes.statusCode, oRes.body).toBe(200);
    const o = oRes.json();
    expect((await post("/v1/passkeys/verify", { challengeId: o.challengeId, response: second.register(o.options), label: "phone" }, { cookie: ck })).statusCode).toBe(200);
    const list = (await h.app.inject({ url: "/v1/passkeys", headers: { cookie: ck } })).json().passkeys;
    expect(list).toHaveLength(2);
    expect((await login(second)).statusCode).toBe(200);
    const del = (id: string) => h.app.inject({ method: "DELETE", url: `/v1/passkeys/${id}`, headers: { cookie: ck } });
    expect((await del(list[0].id)).statusCode).toBe(200);
    expect((await del(list[1].id)).statusCode).toBe(409);
  });

  it("cookie-authenticated mutations from another origin are refused", async () => {
    const ck = cookieOf(await login());
    expect((await post("/v1/passkeys/options", {}, { cookie: ck, origin: "https://evil.example" })).statusCode).toBe(403);
  });
});

describe("dashboard + static UI", () => {
  it("serves the UI with a strict CSP and no inline script", async () => {
    const r = await h.app.inject("/");
    expect(r.statusCode).toBe(200); expect(r.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.body).not.toMatch(/<script(?![^>]*src=)/);
    expect((await h.app.inject("/app.js")).headers["content-type"]).toContain("javascript");
  });

  it("lists factories and shows a factory's jobs/events, scoped to the member", async () => {
    await setup(); const ck = cookieOf(await login());
    const created = (await post("/v1/factories", { orgId: (await h.app.inject({ url: "/v1/me", headers: { cookie: ck } })).json().orgs[0].id, name: "mac" }, { cookie: ck })).json();
    const hb = { authorization: `Bearer ${created.token}` };
    await post("/v1/factory/sync", { projects: [{ id: "p", name: "Proj" }], jobs: [{ id: "j1", projectId: "p", title: "Fix bug", stage: "implement", status: "running" }] }, hb);
    await post("/v1/factory/events", { events: [{ id: "e1", type: "stage.entered", jobId: "j1", occurredAt: new Date().toISOString(), payload: { stage: "implement" } }] }, hb);
    await post("/v1/factory/heartbeat", { version: "1.0.0" }, hb);
    const list = (await h.app.inject({ url: "/v1/factories", headers: { cookie: ck } })).json().factories;
    expect(list[0]).toMatchObject({ name: "mac", status: "active", version: "1.0.0", jobCount: 1, activeJobs: 1 });
    const d = (await h.app.inject({ url: `/v1/factories/${created.factoryId}`, headers: { cookie: ck } })).json();
    expect(d.jobs[0]).toMatchObject({ title: "Fix bug", project: "Proj", stage: "implement" }); expect(d.events[0].type).toBe("stage.entered");
    // rotate: old key dies, new key works
    const rot = (await post(`/v1/factories/${created.factoryId}/rotate-key`, {}, { cookie: ck })).json();
    expect((await post("/v1/factory/heartbeat", {}, hb)).statusCode).toBe(401);
    expect((await post("/v1/factory/heartbeat", {}, { authorization: `Bearer ${rot.token}` })).statusCode).toBe(200);
  });

  it("requires sign-in for the API", async () => {
    for (const u of ["/v1/factories", "/v1/me", "/v1/passkeys"]) expect((await h.app.inject(u)).statusCode).toBe(401);
  });
});

describe("invites", () => {
  const get = (url: string, ck: string) => h.app.inject({ url, headers: { cookie: ck } });
  const mint = async (ck: string) => (await post("/v1/invites", {}, { cookie: ck })).json() as { id: string; token: string; url: string };
  const redeem = async (token: string, a = new SoftAuthenticator(RP, ORIGIN), email = "new@example.test") => {
    const o = await post("/auth/invite/options", { token, email, displayName: "New" });
    if (o.statusCode !== 200) return { opts: o, a };
    const { challengeId, options } = o.json();
    return { opts: o, a, verify: await post("/auth/invite/verify", { challengeId, response: a.register(options) }) };
  };
  let ck: string;
  beforeEach(async () => { await setup(); ck = cookieOf(await login()); });

  it("requires sign-in to mint an invite, and the link carries the token in the fragment", async () => {
    expect((await post("/v1/invites", {})).statusCode).toBe(401);
    const inv = await mint(ck);
    expect(inv.url).toContain(`/#invite=${inv.token}`);
    expect((await db.query("SELECT token_hash FROM invites")).rows[0]).not.toMatchObject({ token_hash: inv.token }); // only a hash is stored
  });

  it("lets the invitee register with their own org and passkey, and see none of the inviter's factories", async () => {
    const me = (await get("/v1/me", ck)).json();
    await post("/v1/factories", { orgId: me.orgs[0].id, name: "mine" }, { cookie: ck });
    const inv = await mint(ck);
    const { verify, a } = await redeem(inv.token);
    expect(verify!.statusCode, verify!.body).toBe(200);
    const nck = cookieOf(verify!);
    const nme = (await get("/v1/me", nck)).json();
    expect(nme).toMatchObject({ email: "new@example.test", orgs: [{ role: "owner" }] });
    expect(nme.orgs[0].id).not.toBe(me.orgs[0].id);
    expect((await get("/v1/factories", nck)).json().factories).toEqual([]);
    expect((await get("/v1/factories", ck)).json().factories).toHaveLength(1);
    expect((await login(a)).statusCode).toBe(200); // the new passkey signs in
    const list = (await get("/v1/invites", ck)).json().invites;
    expect(list[0]).toMatchObject({ usedByEmail: "new@example.test" });
  });

  it("is single use, can be revoked, and is refused when expired or unknown", async () => {
    const inv = await mint(ck);
    expect((await redeem(inv.token)).verify!.statusCode).toBe(200);
    expect((await redeem(inv.token, new SoftAuthenticator(RP, ORIGIN), "other@example.test")).opts.statusCode).toBe(403);
    const revoked = await mint(ck);
    expect((await h.app.inject({ method: "DELETE", url: `/v1/invites/${revoked.id}`, headers: { cookie: ck } })).statusCode).toBe(200);
    expect((await redeem(revoked.token)).opts.statusCode).toBe(403);
    const old = await mint(ck);
    await db.query("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id=$1", [old.id]);
    expect((await redeem(old.token)).opts.statusCode).toBe(403);
    expect((await redeem("x".repeat(43))).opts.statusCode).toBe(403);
  });

  it("two concurrent registrations on one invite create exactly one user", async () => {
    const inv = await mint(ck);
    const mk = async (email: string) => { const a = new SoftAuthenticator(RP, ORIGIN); const o = (await post("/auth/invite/options", { token: inv.token, email, displayName: "N" })).json(); return { a, o }; };
    const [x, y] = await Promise.all([mk("a@example.test"), mk("b@example.test")]);
    const res = await Promise.all([x, y].map(({ a, o }) => post("/auth/invite/verify", { challengeId: o.challengeId, response: a.register(o.options) })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    expect((await db.query("SELECT 1 FROM users")).rows).toHaveLength(2); // the first user + one invitee
  });

  it("refuses an email that is already registered, and a user cannot revoke someone else's invite", async () => {
    const inv = await mint(ck);
    expect((await redeem(inv.token, new SoftAuthenticator(RP, ORIGIN), "ME@example.test")).opts.statusCode).toBe(409);
    const joined = await redeem(inv.token); const nck = cookieOf(joined.verify!);
    const mine = await mint(ck);
    expect((await h.app.inject({ method: "DELETE", url: `/v1/invites/${mine.id}`, headers: { cookie: nck } })).statusCode).toBe(404);
  });
});
