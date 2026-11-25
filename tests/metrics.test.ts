import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { enqueue } from "../src/core/jobs.js";
import { openDb } from "../src/db/client.js";
import { agentInvocations, projects } from "../src/db/schema.js";
import { buildServer } from "../src/server/app.js";
import { cachedSystemInfo, counts, HealthChecker } from "../src/service/metrics.js";
import { tmp } from "./helpers/git-fixture.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("recent agent failures", () => {
  it("counts only failures inside the window, by kind, and survives rows without (valid) usage", () => {
    const { db } = openDb(":memory:"); db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    const job = enqueue(db, { projectId: "p", externalId: "1", externalKey: "J-1" }).job;
    const now = new Date("2026-01-01T12:00:00Z");
    const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000);
    const row = (failure: string | undefined, minsAgo: number, raw?: string | null) => db.insert(agentInvocations).values({ jobId: job.id, agent: "claude-code", startedAt: at(minsAgo), usageJson: raw !== undefined ? raw : JSON.stringify({ failure }) }).run();
    row("rate_limited", 5); row("rate_limited", 10); row("auth", 30); row("timeout", 59); row("crashed", 1);
    row(undefined, 2); row(undefined, 3, null); row(undefined, 4, "not json");
    row("rate_limited", 61); row("auth", 600); // outside the hour
    expect(counts(db, now).recentAgentFailures).toEqual({ rateLimited: 2, auth: 1, timeout: 1, total: 5 });
  });
});

describe("system info cache", () => {
  it("runs memory_pressure once per ttl, sharing one read between concurrent callers", async () => {
    let t = 0, calls = 0;
    const info = cachedSystemInfo(5000, async () => { calls++; return "System-wide memory free percentage: 40%"; }, () => t);
    const dir = tmp();
    const [a, b] = await Promise.all([info(dir), info(dir)]);
    expect(calls).toBe(1); expect(a.memory.freePercent).toBe(40); expect(b).toBe(a);
    t = 4000; await info(dir); expect(calls).toBe(1);
    t = 5001; await info(dir); expect(calls).toBe(2);
  });
});

describe("health probes", () => {
  it("shares one in-flight probe between overlapping checks", async () => {
    let calls = 0, release!: () => void;
    const h = new HealthChecker({ ghAuth: () => { calls++; return new Promise<string>((r) => { release = () => r("Logged in"); }); } });
    const both = Promise.all([h.check(), h.check(), h.check({ refresh: true })]);
    await tick(); expect(calls).toBe(1);
    release();
    for (const r of await both) expect(r[0]).toMatchObject({ name: "github", status: "ok" });
  });

  it("keeps a failure only briefly, a success for longer, and answers from the last result while one refresh runs", async () => {
    let t = 0, loggedIn = false, calls = 0;
    const h = new HealthChecker({ now: () => t, ttlMs: 300_000, failTtlMs: 30_000, ghAuth: async () => { calls++; return loggedIn ? "Logged in" : "not logged in"; } });
    expect((await h.check())[0]!.status).toBe("fail");
    loggedIn = true; // the user runs `gh auth login`
    t = 20_000; expect((await h.check())[0]!.status).toBe("fail"); expect(calls).toBe(1); // still cached
    t = 31_000; expect((await h.check())[0]!.status).toBe("fail"); // stale: answered at once, refreshed behind it
    expect(calls).toBe(2); await tick();
    expect((await h.check())[0]).toMatchObject({ status: "ok", checkedAt: 31_000 });
    t = 31_000 + 200_000; await h.check(); expect(calls).toBe(2); // a success is trusted for ttlMs
  });

  it("re-probes on request instead of waiting for the cache", async () => {
    let calls = 0;
    const h = new HealthChecker({ sandboxAvailable: () => { calls++; return true; } });
    await h.check(); await h.check(); expect(calls).toBe(1);
    await h.check({ refresh: true }); expect(calls).toBe(2);
  });

  it("GET /api/health?refresh=1 re-runs the probes; plain /api/health keeps using the cache", async () => {
    let calls = 0;
    const dataDir = tmp(); mkdirSync(join(dataDir, "logs"), { recursive: true });
    const app = buildServer({ db: openDb(":memory:").db, logger: pino({ level: "silent" }), dataDir, port: 4780, health: new HealthChecker({ sandboxAvailable: () => { calls++; return true; } }) });
    const get = (url: string) => app.inject({ method: "GET", url, headers: { host: "127.0.0.1:4780" }, remoteAddress: "127.0.0.1" });
    expect((await get("/api/health")).json().health[0]).toMatchObject({ name: "sandbox", status: "ok" });
    await get("/api/health"); expect(calls).toBe(1);
    expect((await get("/api/health?refresh=1")).statusCode).toBe(200); expect(calls).toBe(2);
  });
});
