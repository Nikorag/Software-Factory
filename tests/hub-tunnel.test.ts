import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { openDb } from "../src/db/client.js";
import { jobs, projects } from "../src/db/schema.js";
import type { FetchLike, TunnelRequest } from "../src/hub/client.js";
import { connectHub, disconnectHub, hubStatus, setRemoteAccess } from "../src/hub/commands.js";
import { readHubSettings, type HubSettings } from "../src/hub/settings.js";
import { HubTunnel, MAX_RESPONSE_BYTES } from "../src/hub/tunnel.js";
import { buildServer } from "../src/server/app.js";
import { fixtureConfig, fixtureConfigDir } from "./helpers/config.js";

const KEY = "sfh_0b1d2c3e-1111-4222-8333-444455556666.SuperSecretValueSuperSecretValue123";
const log = pino({ level: "silent" });
const flush = () => new Promise((r) => setTimeout(r, 15));
const waitFor = async (fn: () => boolean, ms = 1500) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("timed out waiting"); await flush(); } };

interface Posted { id: string; status: number; headers: Record<string, string>; body: string }

/** A fake hub: hands out queued batches on the long poll (then blocks until aborted), records responses and every call. */
function fakeHub(o: { nextStatus?: () => number | undefined; respondStatus?: number } = {}) {
  const batches: TunnelRequest[][] = [];
  const calls: Array<{ method: string; path: string; auth: string | undefined }> = [];
  const responses: Posted[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url); calls.push({ method: init.method, path: u.pathname, auth: init.headers.authorization });
    if (u.pathname === "/v1/factory/tunnel/next") {
      const bad = o.nextStatus?.();
      if (bad) return { ok: false, status: bad, text: async () => "{}" };
      const b = batches.shift();
      if (b) return { ok: true, status: 200, text: async () => JSON.stringify({ requests: b }) };
      await new Promise<void>((resolve) => { if (init.signal?.aborted) resolve(); init.signal?.addEventListener("abort", () => resolve(), { once: true }); setTimeout(resolve, 60); });
      if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return { ok: true, status: 204, text: async () => "" };
    }
    const m = /^\/v1\/factory\/tunnel\/([^/]+)\/response$/.exec(u.pathname);
    if (m) {
      const b = JSON.parse(init.body!) as { status: number; headers: Record<string, string>; bodyBase64: string };
      responses.push({ id: m[1]!, status: b.status, headers: b.headers, body: Buffer.from(b.bodyBase64, "base64").toString() });
      const st = o.respondStatus ?? 200; return { ok: st < 300, status: st, text: async () => "{}" };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const polls = () => calls.filter((c) => c.path === "/v1/factory/tunnel/next").length;
  return { fetch, batches, calls, responses, polls };
}

const iso = (ms: number) => new Date(ms).toISOString();
const req = (over: Partial<TunnelRequest> = {}): TunnelRequest => ({ id: crypto.randomUUID(), method: "GET", path: "/api/jobs", expiresAt: iso(Date.now() + 20_000), ...over });
const settings = (over: Partial<HubSettings> = {}): HubSettings => ({ enabled: true, url: "https://hub.example.test", reportIntervalSeconds: 30, remoteAccess: true, ...over });

interface InjectCall { method: string; url: string; headers: Record<string, string>; remoteAddress?: string; payload?: unknown }
function stubApp(reply: { status?: number; body?: string | Buffer; type?: string } = {}) {
  const calls: InjectCall[] = [];
  const app = { inject: async (o: InjectCall) => { calls.push(o); const body = Buffer.from(reply.body ?? "{}"); return { statusCode: reply.status ?? 200, rawPayload: body, headers: { "content-type": reply.type ?? "application/json" } }; } };
  return { app: app as never, calls };
}
function tunnel(app: never, hub: ReturnType<typeof fakeHub>, o: { settings?: () => HubSettings; key?: () => string | undefined; audit?: (a: { method: string; route: string; status: number }) => void; now?: () => number } = {}) {
  let settingsCalls = 0, keyCalls = 0;
  const t = new HubTunnel({
    app, port: 4780, logger: log, fetch: hub.fetch, pollWaitSeconds: 1, now: o.now, audit: o.audit,
    getSettings: () => { settingsCalls++; return (o.settings ?? (() => settings()))(); },
    getKey: () => { keyCalls++; return o.key ? o.key() : KEY; },
    sleep: async () => undefined,
  });
  return { t, counts: () => ({ settingsCalls, keyCalls }) };
}

describe("remote access is off by default", () => {
  it("the shipped config has it off, and connecting for reporting does not turn it on", async () => {
    expect(loadConfig(fixtureConfigDir()).factory.hub.remoteAccess).toBe(false);
    const d = { configDir: fixtureConfigDir(), dataDir: mkdtempSync(join(tmpdir(), "factory-hub-")) };
    const r = await connectHub({ url: "https://hub.example.test", key: KEY }, { ...d, fetch: fakeHub().fetch, env: {}, save: () => undefined });
    expect(r.remoteAccess).toBe(false);
    expect(readHubSettings(d.configDir)).toMatchObject({ enabled: true, remoteAccess: false });
  });

  it("is switched on only by the explicit flag, and a plain reconnect switches it back off", async () => {
    const d = { configDir: fixtureConfigDir(), dataDir: mkdtempSync(join(tmpdir(), "factory-hub-")) };
    const deps = { ...d, fetch: fakeHub().fetch, env: {}, save: () => undefined };
    await connectHub({ url: "https://hub.example.test", key: KEY, remoteAccess: true }, deps);
    expect(readHubSettings(d.configDir).remoteAccess).toBe(true);
    await connectHub({ url: "https://other.example.test", key: KEY }, deps); // a different hub must not inherit the grant
    expect(readHubSettings(d.configDir).remoteAccess).toBe(false);
  });

  it("remote-access on|off, refuses to turn on before connecting, and status shows it; disconnect turns it off", async () => {
    const d = { configDir: fixtureConfigDir(), dataDir: mkdtempSync(join(tmpdir(), "factory-hub-")) };
    expect(() => setRemoteAccess(true, d)).toThrow(/connect to a hub first/);
    await connectHub({ url: "https://hub.example.test", key: KEY }, { ...d, fetch: fakeHub().fetch, env: {}, save: () => undefined });
    setRemoteAccess(true, d);
    expect(hubStatus({ ...d, getKey: () => KEY }).remoteAccess).toBe(true);
    setRemoteAccess(false, d);
    expect(hubStatus({ ...d, getKey: () => KEY }).remoteAccess).toBe(false);
    setRemoteAccess(true, d); disconnectHub({ ...d, deleteKey: () => undefined });
    expect(readHubSettings(d.configDir)).toMatchObject({ enabled: false, remoteAccess: false });
    expect(readFileSync(join(d.configDir, "factory.yaml"), "utf8")).not.toContain("SuperSecret");
  });

  it("with remoteAccess off (even with reporting on) there are no network calls and no key lookups", async () => {
    const hub = fakeHub(), { app } = stubApp(), { t, counts } = tunnel(app, hub, { settings: () => settings({ remoteAccess: false }) });
    t.sync(); t.sync(); await flush();
    expect(t.running).toBe(false); expect(hub.calls).toHaveLength(0); expect(counts().keyCalls).toBe(0);
  });

  it("with reporting off, remoteAccess alone does nothing either", async () => {
    const hub = fakeHub(), { app } = stubApp(), { t } = tunnel(app, hub, { settings: () => settings({ enabled: false }) });
    t.sync(); await flush(); expect(hub.calls).toHaveLength(0);
  });

  it("no key: nothing runs", async () => {
    const hub = fakeHub(), { app } = stubApp(), { t } = tunnel(app, hub, { key: () => undefined });
    t.sync(); await flush(); expect(t.running).toBe(false); expect(hub.calls).toHaveLength(0);
  });
});

describe("running the tunnel", () => {
  it("polls with the bearer key, runs a request, and posts the response back", async () => {
    const hub = fakeHub(), s = stubApp({ body: '{"jobs":[]}' }), { t } = tunnel(s.app, hub);
    const r = req({ path: "/api/jobs?status=running" }); hub.batches.push([r]);
    t.sync(); await waitFor(() => hub.responses.length === 1); t.stop();
    expect(hub.calls[0]).toMatchObject({ method: "GET", path: "/v1/factory/tunnel/next", auth: `Bearer ${KEY}` });
    expect(s.calls).toHaveLength(1); expect(s.calls[0]).toMatchObject({ method: "GET", url: "/api/jobs?status=running", remoteAddress: "127.0.0.1" });
    expect(hub.responses[0]).toMatchObject({ id: r.id, status: 200, body: '{"jobs":[]}', headers: { "content-type": "application/json" } });
  });

  it("runs the batch concurrently and keeps polling (two loops)", async () => {
    const hub = fakeHub(), s = stubApp(), { t } = tunnel(s.app, hub);
    hub.batches.push([req(), req(), req()]); hub.batches.push([req()]);
    t.sync(); await waitFor(() => hub.responses.length === 4); t.stop();
    expect(new Set(hub.responses.map((r) => r.id)).size).toBe(4);
  });

  it("never forwards hub-supplied headers other than content-type and accept; trust headers are set locally", async () => {
    const hub = fakeHub(), s = stubApp(), { t } = tunnel(s.app, hub);
    await t.execute(req({ method: "POST", path: "/api/control/pause", headers: { "content-type": "application/json", accept: "text/plain", authorization: "Bearer evil", cookie: "x=1", host: "evil.example", origin: "https://evil.example", "x-factory-ui": "0", "sec-fetch-site": "cross-site", "x-forwarded-for": "6.6.6.6" } as never, bodyBase64: Buffer.from("{}").toString("base64") }));
    expect(s.calls[0]!.headers).toEqual({ host: "127.0.0.1:4780", origin: "http://127.0.0.1:4780", "x-factory-ui": "1", "sec-fetch-site": "same-origin", "content-type": "application/json", accept: "text/plain" });
    expect(s.calls[0]!.remoteAddress).toBe("127.0.0.1");
  });

  it("drops header values containing line breaks or that are absurdly long", async () => {
    const hub = fakeHub(), s = stubApp(), { t } = tunnel(s.app, hub);
    await t.execute(req({ headers: { "content-type": "text/plain\r\nX-Evil: 1", accept: "a".repeat(500) } }));
    expect(Object.keys(s.calls[0]!.headers).sort()).toEqual(["host", "origin", "sec-fetch-site", "x-factory-ui"]);
  });

  it("passes the request body through", async () => {
    const hub = fakeHub(), s = stubApp(), { t } = tunnel(s.app, hub);
    await t.execute(req({ method: "PUT", path: "/api/workflows/assignments", headers: { "content-type": "application/json" }, bodyBase64: Buffer.from('{"a":1}').toString("base64") }));
    expect(Buffer.from(s.calls[0]!.payload as Buffer).toString()).toBe('{"a":1}');
  });

  it("blocked routes answer 403 and never reach the handler", async () => {
    const hub = fakeHub(), s = stubApp(), { t } = tunnel(s.app, hub);
    for (const [method, path] of [["POST", "/api/control/shutdown"], ["POST", "/api/setup/linear-key"], ["PUT", "/api/jira/app"], ["DELETE", "/api/profiles/work"], ["GET", "/api/unknown"], ["PUT", "/api/settings/projects/web"]] as const) {
      const r = await t.execute(req({ method, path }));
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(JSON.parse(Buffer.from(r.bodyBase64, "base64").toString())).toEqual({ error: "not available remotely" });
    }
    expect(s.calls).toHaveLength(0);
  });

  it("bad paths and methods are refused without executing", async () => {
    const hub = fakeHub(), s = stubApp(), { t } = tunnel(s.app, hub);
    expect((await t.execute(req({ path: "/api/../health" }))).status).toBe(400);
    expect((await t.execute(req({ path: "http://evil.example/api/jobs" }))).status).toBe(400);
    expect((await t.execute(req({ path: "/health" }))).status).toBe(400);
    expect((await t.execute(req({ method: "PATCH" }))).status).toBe(403);
    expect((await t.execute(req({ method: "CONNECT" }))).status).toBe(403);
    expect(s.calls).toHaveLength(0);
  });

  it("skips requests whose time is up: no execution, no response", async () => {
    const hub = fakeHub(), s = stubApp(), { t } = tunnel(s.app, hub);
    hub.batches.push([req({ expiresAt: iso(Date.now() - 1000) }), req({ expiresAt: "garbage" })]); hub.batches.push([req()]);
    t.sync(); await waitFor(() => hub.responses.length === 1); await flush(); t.stop();
    expect(s.calls).toHaveLength(1); expect(hub.responses).toHaveLength(1);
  });

  it("a response over 5 MB becomes a 502, and one at the limit goes through", async () => {
    const hub = fakeHub();
    const big = stubApp({ body: Buffer.alloc(MAX_RESPONSE_BYTES + 1, 65) }), a = tunnel(big.app, hub).t;
    const r = await a.execute(req()); expect(r.status).toBe(502);
    expect(JSON.parse(Buffer.from(r.bodyBase64, "base64").toString())).toEqual({ error: "response too large" });
    const edge = stubApp({ body: Buffer.alloc(MAX_RESPONSE_BYTES, 65) });
    expect((await tunnel(edge.app, hub).t.execute(req())).status).toBe(200);
  });

  it("a handler that throws is a 502, not a crash", async () => {
    const hub = fakeHub(), { t } = tunnel({ inject: async () => { throw new Error("boom with secret path /Users/me"); } } as never, hub);
    const r = await t.execute(req()); expect(r.status).toBe(502);
    expect(Buffer.from(r.bodyBase64, "base64").toString()).not.toContain("/Users/me");
  });

  it("a 404 from the hub on the response (it already expired) is ignored", async () => {
    const hub = fakeHub({ respondStatus: 404 }), s = stubApp(), { t } = tunnel(s.app, hub);
    hub.batches.push([req()]); t.sync(); await waitFor(() => hub.responses.length === 1); await flush();
    expect(t.running).toBe(true); t.stop();
  });

  it("audits mutating requests only, by route pattern and status (no body, no ids)", async () => {
    const hub = fakeHub(), s = stubApp({ status: 200 }), seen: unknown[] = [], { t } = tunnel(s.app, hub, { audit: (a) => seen.push(a) });
    await t.execute(req({ path: "/api/jobs/secret-job-id" }));
    await t.execute(req({ method: "POST", path: "/api/jobs/secret-job-id/cancel", bodyBase64: Buffer.from('{"answer":"TOP_SECRET"}').toString("base64") }));
    await t.execute(req({ method: "POST", path: "/api/control/shutdown" })); // blocked: not audited as a change
    expect(seen).toEqual([{ method: "POST", route: "/api/jobs/:id/cancel", status: 200 }]);
    expect(JSON.stringify(seen)).not.toMatch(/secret|TOP_SECRET/i);
  });

  it("an audit callback that throws does not break the response", async () => {
    const hub = fakeHub(), s = stubApp(), { t } = tunnel(s.app, hub, { audit: () => { throw new Error("db locked"); } });
    expect((await t.execute(req({ method: "POST", path: "/api/control/pause" }))).status).toBe(200);
  });
});

describe("toggling and failure handling", () => {
  it("turning remote access off aborts the polls promptly and stops polling", async () => {
    const hub = fakeHub(), s = stubApp(); let on = true;
    const { t } = tunnel(s.app, hub, { settings: () => settings({ remoteAccess: on }) });
    t.sync(); await waitFor(() => hub.polls() >= 2); expect(t.running).toBe(true);
    on = false; t.sync(); expect(t.running).toBe(false);
    await flush(); const n = hub.polls(); await new Promise((r) => setTimeout(r, 150));
    expect(hub.polls()).toBe(n);
  });

  it("turning it back on resumes", async () => {
    const hub = fakeHub(), s = stubApp(); let on = false;
    const { t } = tunnel(s.app, hub, { settings: () => settings({ remoteAccess: on }) });
    t.sync(); await flush(); expect(hub.calls).toHaveLength(0);
    on = true; t.sync(); await waitFor(() => hub.polls() > 0); t.stop();
  });

  it("disconnecting (reporting off) stops it too", async () => {
    const hub = fakeHub(), s = stubApp(); let enabled = true;
    const { t } = tunnel(s.app, hub, { settings: () => settings({ enabled }) });
    t.sync(); await waitFor(() => hub.polls() > 0); enabled = false; t.sync(); expect(t.running).toBe(false);
  });

  it("a 401 stops it until the key changes", async () => {
    let status: number | undefined = 401; const hub = fakeHub({ nextStatus: () => status }), s = stubApp(); let key = KEY;
    const { t } = tunnel(s.app, hub, { key: () => key });
    t.sync(); await waitFor(() => !t.running);
    const n = hub.polls(); t.sync(); t.sync(); await flush();
    expect(t.running).toBe(false); expect(hub.polls()).toBe(n); // same key: stays stopped
    status = undefined; key = KEY.replace("SuperSecret", "BrandNewKey_");
    t.sync(); await waitFor(() => hub.polls() > n); expect(t.running).toBe(true); t.stop();
  });

  it("403 behaves like 401", async () => {
    const hub = fakeHub({ nextStatus: () => 403 }), s = stubApp(), { t } = tunnel(s.app, hub);
    t.sync(); await waitFor(() => !t.running);
  });

  it("other errors back off and keep trying", async () => {
    let n = 0; const hub = fakeHub({ nextStatus: () => (++n <= 3 ? 500 : undefined) }), s = stubApp(), { t } = tunnel(s.app, hub);
    t.sync(); await waitFor(() => hub.polls() >= 6); expect(t.running).toBe(true); t.stop();
  });

  it("a changed key restarts the loops with the new key", async () => {
    const hub = fakeHub(), s = stubApp(); let key = KEY;
    const { t } = tunnel(s.app, hub, { key: () => key });
    t.sync(); await waitFor(() => hub.polls() > 0);
    key = KEY.replace("SuperSecret", "AnotherOneeee"); hub.calls.length = 0; t.sync();
    await waitFor(() => hub.calls.some((c) => c.auth === `Bearer ${key}`)); t.stop();
  });
});

describe("against the real dashboard server", () => {
  function realApp() {
    const { db } = openDb(":memory:");
    db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    db.insert(jobs).values({ id: "j1", projectId: "p", externalId: "e1", externalKey: "ENG-1", status: "running", stage: "SPECIFY" }).run();
    // A deliberately different token and port: the tunnel must get in through the dashboard trust path, not the control token.
    return { app: buildServer({ db, logger: pino({ level: "silent" }), config: fixtureConfig(), dataDir: mkdtempSync(join(tmpdir(), "factory-t-")), port: 4780, controlToken: "t".repeat(64) }), db };
  }

  it("serves reads and mutations through the normal trust checks", async () => {
    const { app } = realApp(), hub = fakeHub(), { t } = tunnel(app as never, hub);
    const list = await t.execute(req({ path: "/api/jobs" }));
    expect(list.status).toBe(200); expect(Buffer.from(list.bodyBase64, "base64").toString()).toContain("ENG-1");
    const pause = await t.execute(req({ method: "POST", path: "/api/control/pause", headers: { "content-type": "application/json" }, bodyBase64: Buffer.from("{}").toString("base64") }));
    expect(pause.status).toBe(200);
    const o = JSON.parse(Buffer.from((await t.execute(req({ path: "/api/overview" }))).bodyBase64, "base64").toString()) as { control?: { paused?: boolean } };
    expect(JSON.stringify(o)).toContain("paused");
  });

  it("a blocked route never reaches the real handler (the process keeps running)", async () => {
    let shutdowns = 0;
    const { db } = openDb(":memory:");
    const app = buildServer({ db, logger: pino({ level: "silent" }), config: fixtureConfig(), dataDir: mkdtempSync(join(tmpdir(), "factory-t-")), port: 4780, controlToken: "t".repeat(64), shutdown: () => { shutdowns++; } });
    const { t } = tunnel(app as never, fakeHub());
    expect((await t.execute(req({ method: "POST", path: "/api/control/shutdown" }))).status).toBe(403);
    expect(shutdowns).toBe(0);
    // sanity: the same call through the trusted dashboard path WOULD have run, which is exactly why the policy layer exists
    const direct = await app.inject({ method: "POST", url: "/api/control/shutdown", remoteAddress: "127.0.0.1", headers: { host: "127.0.0.1:4780", origin: "http://127.0.0.1:4780", "x-factory-ui": "1", "sec-fetch-site": "same-origin" }, payload: {} });
    expect(direct.statusCode).toBe(200); await waitFor(() => shutdowns === 1);
  });

  it("the remote path cannot reach non-/api routes or smuggle a different host", async () => {
    const { app } = realApp(), { t } = tunnel(app as never, fakeHub());
    expect((await t.execute(req({ path: "/health" }))).status).toBe(400);
    expect((await t.execute(req({ path: "/api/jobs", headers: { host: "evil.example" } as never }))).status).toBe(200); // the hub's host header is ignored, not trusted
  });
});

describe("heartbeat tells the hub whether remote access is on", () => {
  it("includes remoteAccess in the reporter's heartbeat metadata", async () => {
    const { HubReporter } = await import("../src/hub/reporter.js");
    const { db } = openDb(":memory:"); const hub = fakeHub(); const bodies: Array<{ metadata?: Record<string, unknown> }> = [];
    const f: FetchLike = async (url, init) => { if (new URL(url).pathname.endsWith("/heartbeat")) bodies.push(JSON.parse(init.body!)); return hub.fetch(url, init); };
    const dataDir = mkdtempSync(join(tmpdir(), "factory-hub-"));
    for (const on of [false, true]) {
      await new HubReporter({ db, dataDir, logger: log, fetch: f, getSettings: () => settings({ remoteAccess: on }), getKey: () => KEY, version: "1" }).tick();
      rmState(dataDir);
    }
    expect(bodies.map((b) => b.metadata?.remoteAccess)).toEqual([false, true]);
  });
});
function rmState(dir: string) { const f = join(dir, "hub-state.json"); if (existsSync(f)) writeFileSync(f, "{}"); }
