import { describe, expect, it } from "vitest";
import pino from "pino";
import { openDb } from "../src/db/client.js";
import { buildServer } from "../src/server/app.js";
import { UpdateChecker } from "../src/service/versions.js";
import type { UpdatePlan } from "../src/service/update.js";

const plan = (o: Partial<UpdatePlan> = {}): UpdatePlan => ({ current: "v0.1.0", currentSha: "a", target: "v0.1.1", targetSha: "b", targetIsTag: true, behind: 1, upToDate: false, dirty: false, latestTag: "v0.1.1", pending: null, ...o });

describe("update notice", () => {
  it("reports a newer release, and asks git at most once per ttl", async () => {
    let calls = 0, t = 0;
    const c = new UpdateChecker({ ttlMs: 1000, now: () => t, plan: async () => { calls++; return plan(); } });
    expect(await c.status()).toMatchObject({ current: "v0.1.0", latest: "v0.1.1", available: true });
    await c.status(); await Promise.all([c.status(), c.status()]);
    expect(calls).toBe(1);
    t = 5000; await c.status();
    expect(calls).toBe(2);
  });
  it("refresh() asks again right now, ignoring the cache, and reports the installed version", async () => {
    let n = 0, available = false;
    const c = new UpdateChecker({ ttlMs: 3600_000, plan: async () => { n++; return plan(available ? {} : { upToDate: true, behind: 0 }); } });
    expect((await c.status()).available).toBe(false);
    available = true;
    expect((await c.status()).available).toBe(false);                    // still cached: the page would keep saying up to date
    const fresh = await c.refresh();
    expect(fresh).toMatchObject({ available: true, latest: "v0.1.1" });
    expect(fresh.version).toMatch(/^\d+\.\d+\.\d+/);                    // package.json's version, shown even if git cannot be asked
    expect(n).toBe(2);
  });
  it("says nothing is available when up to date", async () => {
    expect((await new UpdateChecker({ plan: async () => plan({ upToDate: true, behind: 0 }) }).status()).available).toBe(false);
  });
  it("fails quietly (offline, not a git install) and retries after the ttl", async () => {
    let t = 0, n = 0;
    const c = new UpdateChecker({ ttlMs: 100, now: () => t, plan: async () => { n++; throw new Error("fatal: unable to access remote\nmore"); } });
    expect(await c.status()).toMatchObject({ available: false, error: "fatal: unable to access remote" });
    await c.status(); expect(n).toBe(1);
    t = 200; await c.status(); expect(n).toBe(2);
  });
  it("is served at /api/update", async () => {
    const { db } = openDb(":memory:");
    const app = buildServer({ db, logger: pino({ level: "silent" }), port: 4780, updates: new UpdateChecker({ plan: async () => plan() }) });
    const r = await app.inject({ method: "GET", url: "/api/update", headers: { host: "127.0.0.1:4780" }, remoteAddress: "127.0.0.1" });
    expect(r.json()).toMatchObject({ available: true, latest: "v0.1.1" });
  });
  it("POST /api/update/check forces a fresh check, and needs the dashboard origin or the token", async () => {
    const { db } = openDb(":memory:");
    let upToDate = true;
    const app = buildServer({ db, logger: pino({ level: "silent" }), port: 4780, controlToken: "t".repeat(64), updates: new UpdateChecker({ plan: async () => plan(upToDate ? { upToDate: true, behind: 0 } : {}) }) });
    const HOST = { host: "127.0.0.1:4780" }, UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1" };
    const get = () => app.inject({ method: "GET", url: "/api/update", headers: HOST, remoteAddress: "127.0.0.1" });
    const post = (h: Record<string, string>) => app.inject({ method: "POST", url: "/api/update/check", headers: h, remoteAddress: "127.0.0.1" });
    expect((await get()).json().available).toBe(false);
    upToDate = false;
    expect((await get()).json().available).toBe(false);                  // cached
    expect((await post(HOST)).statusCode).toBe(401);
    expect((await post(UI)).json()).toMatchObject({ available: true });
    expect((await get()).json().available).toBe(true);                   // and the cache now holds the fresh answer
  });
});
