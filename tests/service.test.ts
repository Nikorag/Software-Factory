import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config/load.js";
import * as control from "../src/core/control.js";
import { Engine, type HandlerRegistry } from "../src/core/engine.js";
import { enqueue, getJob } from "../src/core/jobs.js";
import { simulatedHandlers } from "../src/core/simulation.js";
import { openDb } from "../src/db/client.js";
import { jobs, projects } from "../src/db/schema.js";
import type { DiscoveryReport } from "../src/linear/discovery.js";
import { acquireLock, LockHeldError } from "../src/service/lock.js";
import { agentStatus, buildPlist, installAgent, LABEL, renderPlist, uninstallAgent } from "../src/service/launchd.js";
import { counts, HealthChecker, systemInfo } from "../src/service/metrics.js";
import { Scheduler } from "../src/service/scheduler.js";
import { forgetSecrets, resolveSecret } from "../src/service/secrets.js";
import { tmp } from "./helpers/git-fixture.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(10); return cond(); };
const empty = (): DiscoveryReport => ({ enqueued: [], skipped: [], errors: [] });

function rig(handlers: HandlerRegistry = simulatedHandlers(), over: { discover?: () => Promise<DiscoveryReport>; flush?: () => Promise<{ sent: number; failed: number; pending: number }>; validate?: () => Promise<void> } = {}) {
  const { db } = openDb(":memory:");
  db.insert(projects).values({ id: "p", configJson: "{}" }).run();
  const config = loadConfig("config");
  const engine = new Engine({ db, logger: pino({ level: "silent" }), config, handlers, backoffBaseMs: 0, heartbeatMs: 60_000 });
  const calls = { discover: 0, flush: 0, validate: 0 };
  const sched = new Scheduler({
    db, engine, logger: pino({ level: "silent" }),
    discover: async () => { calls.discover++; return (over.discover ?? (async () => empty()))(); },
    flush: async () => { calls.flush++; return (over.flush ?? (async () => ({ sent: 0, failed: 0, pending: 0 })))(); },
    validate: async () => { calls.validate++; await over.validate?.(); },
    intervals: { discoveryMs: 40, workerIdleMs: 10, pausedPollMs: 10, validateMs: 60_000, maxBackoffMs: 200 },
  });
  const add = (key = "JAM-1") => enqueue(db, { projectId: "p", externalId: key, externalKey: key }).job;
  return { db, engine, sched, calls, add };
}

describe("scheduler", () => {
  it("runs queued jobs to completion by itself, and polls, flushes and validates", async () => {
    const r = rig(); const j = r.add();
    r.sched.start();
    expect(await until(() => getJob(r.db, j.id)!.stage === "COMPLETED")).toBe(true);
    expect(await until(() => r.calls.discover > 0 && r.calls.flush > 0 && r.calls.validate > 0)).toBe(true);
    expect(r.sched.status()).toMatchObject({ running: true, lastDiscovery: { ok: true }, lastValidation: { ok: true } });
    await r.sched.stop();
    expect(r.sched.status().running).toBe(false);
  });
  it("picks up work that arrives later (the worker idles, it does not exit)", async () => {
    const r = rig(); r.sched.start();
    await sleep(60);
    const j = r.add("JAM-LATE");
    expect(await until(() => getJob(r.db, j.id)!.stage === "COMPLETED")).toBe(true);
    await r.sched.stop();
  });
  it("while PAUSED it starts nothing and polls nothing new, but still flushes Linear write-back", async () => {
    const r = rig(); control.pause(r.db, "t"); const j = r.add();
    r.sched.start();
    expect(await until(() => r.calls.flush >= 2)).toBe(true);
    expect(r.calls.discover).toBe(0);
    expect(getJob(r.db, j.id)).toMatchObject({ stage: "DISCOVERED", status: "queued" });
    control.resume(r.db, "t");
    expect(await until(() => getJob(r.db, j.id)!.stage === "COMPLETED")).toBe(true);
    expect(await until(() => r.calls.discover > 0)).toBe(true); // polling resumes too
    await r.sched.stop();
  });
  it("a failing Linear poll is recorded and backed off, never fatal: work and write-back continue", async () => {
    let n = 0;
    const r = rig(simulatedHandlers(), { discover: async () => { if (++n < 3) throw new Error("linear down"); return empty(); } });
    const j = r.add(); r.sched.start();
    expect(await until(() => getJob(r.db, j.id)!.stage === "COMPLETED")).toBe(true);
    expect(await until(() => r.sched.status().lastDiscovery?.ok === true)).toBe(true);
    expect(r.calls.flush).toBeGreaterThan(0);
    expect(r.sched.status().consecutiveDiscoveryErrors).toBe(0);
    await r.sched.stop();
  });
  it("reports per-project discovery errors in status", async () => {
    const r = rig(simulatedHandlers(), { discover: async () => ({ ...empty(), errors: [{ projectId: "zonto-hub", error: "boom" }] }) });
    r.sched.start();
    expect(await until(() => r.sched.status().lastDiscovery?.ok === false)).toBe(true);
    expect(r.sched.status().lastDiscovery!.error).toContain("zonto-hub: boom");
    await r.sched.stop();
  });
  it("a validation or flush crash never stops the loops", async () => {
    const r = rig(simulatedHandlers(), { validate: async () => { throw new Error("gh down"); }, flush: async () => { throw new Error("linear 500"); } });
    const j = r.add(); r.sched.start();
    expect(await until(() => getJob(r.db, j.id)!.stage === "COMPLETED")).toBe(true);
    expect(r.sched.status().lastValidation).toMatchObject({ ok: false });
    expect(r.sched.status().lastFlush).toMatchObject({ ok: false });
    await r.sched.stop();
  });
  it("graceful stop aborts the running agent, re-queues the job untouched, and a restarted service finishes it", async () => {
    let started = false;
    const hang: HandlerRegistry = { ...simulatedHandlers(), IMPLEMENTATION: () => new Promise(() => { started = true; }) };
    const r = rig(hang); const j = r.add(); r.sched.start();
    expect(await until(() => started)).toBe(true);
    await r.sched.stop();
    expect(getJob(r.db, j.id)).toMatchObject({ stage: "IMPLEMENTATION", status: "queued", stageAttempts: 0, leaseOwner: null });
    const engine2 = new Engine({ db: r.db, logger: pino({ level: "silent" }), config: loadConfig("config"), handlers: simulatedHandlers(), backoffBaseMs: 0 });
    const s2 = new Scheduler({ db: r.db, engine: engine2, logger: pino({ level: "silent" }), discover: async () => empty(), flush: async () => ({ sent: 0, failed: 0, pending: 0 }), validate: async () => {}, intervals: { discoveryMs: 40, workerIdleMs: 10 } });
    s2.start();
    expect(await until(() => getJob(r.db, j.id)!.stage === "COMPLETED")).toBe(true);
    await s2.stop();
  });
  it("an emergency stop during a run holds the job and the scheduler starts nothing until resumed", async () => {
    let started = false;
    const hang: HandlerRegistry = { ...simulatedHandlers(), IMPLEMENTATION: () => new Promise(() => { started = true; }) };
    const r = rig(hang); const j = r.add(); r.sched.start();
    expect(await until(() => started)).toBe(true);
    control.emergencyStop(r.db, "t"); r.engine.abortActive("estop");
    expect(await until(() => getJob(r.db, j.id)!.stage === "PAUSED")).toBe(true);
    const second = r.add("JAM-2"); await sleep(120);
    expect(getJob(r.db, second.id)).toMatchObject({ stage: "DISCOVERED" }); // nothing new started
    await r.sched.stop();
  });
});

describe("single-instance lock", () => {
  it("is exclusive, names the holder, and releases", () => {
    const f = join(tmp(), "factory.lock");
    const a = acquireLock(f, process.pid);
    expect(() => acquireLock(f, 999_999_999)).toThrow(LockHeldError); // our pid is alive and differs
    expect(statSync(f).mode & 0o777).toBe(0o600);
    a.release(); expect(existsSync(f)).toBe(false);
    acquireLock(f).release();
  });
  it("takes over a stale lock left by a dead process, but not a live one's", () => {
    const f = join(tmp(), "factory.lock");
    writeFileSync(f, "999999999"); // no such pid
    const l = acquireLock(f, process.pid);
    expect(readFileSync(f, "utf8")).toBe(String(process.pid));
    l.release();
    writeFileSync(f, String(process.ppid)); // our parent is alive
    expect(() => acquireLock(f, process.pid)).toThrow(/already running/);
  });
  it("release never removes a lock that now belongs to someone else", () => {
    const f = join(tmp(), "factory.lock");
    const a = acquireLock(f, process.pid);
    writeFileSync(f, String(process.ppid));
    a.release();
    expect(readFileSync(f, "utf8")).toBe(String(process.ppid));
  });
});

describe("secrets", () => {
  it("never touches the real keychain when FACTORY_NO_KEYCHAIN is set (how the test suite stays isolated)", () => {
    forgetSecrets();
    expect(process.env.FACTORY_NO_KEYCHAIN).toBe("1");
    expect(resolveSecret({ envName: "SURELY_UNSET_VAR", keychainService: "software-factory-linear" }, { env: {} })).toBeUndefined();
  });
  it("prefers the environment, falls back to the keychain, caches it, and never throws when absent", () => {
    forgetSecrets();
    const run = vi.fn((_f: string, _a: string[]) => "kc-secret\n");
    expect(resolveSecret({ envName: "X_KEY", keychainService: "svc" }, { env: { X_KEY: "from-env" }, run })).toBe("from-env");
    expect(run).not.toHaveBeenCalled();
    if (process.platform === "darwin") {
      expect(resolveSecret({ envName: "X_KEY", keychainService: "svc" }, { env: {}, run })).toBe("kc-secret");
      expect(resolveSecret({ envName: "X_KEY", keychainService: "svc" }, { env: {}, run })).toBe("kc-secret");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(["find-generic-password", "-s", "svc", "-w"]));
      forgetSecrets();
      expect(resolveSecret({ envName: "X_KEY", keychainService: "svc" }, { env: {}, run: () => { throw new Error("not found"); } })).toBeUndefined();
    }
    expect(resolveSecret({ envName: "X_KEY" }, { env: {} })).toBeUndefined();
  });
});

describe("metrics and health", () => {
  it("counts jobs, outbox backlog and recent agent failures from persisted state", () => {
    const { db } = openDb(":memory:"); db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    const a = enqueue(db, { projectId: "p", externalId: "1", externalKey: "J-1" }).job; enqueue(db, { projectId: "p", externalId: "2", externalKey: "J-2" });
    db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, a.id)).run();
    expect(counts(db).byStatus).toMatchObject({ queued: 1, failed: 1, done: 0 });
    expect(counts(db).recentAgentFailures).toEqual({ rateLimited: 0, auth: 0, timeout: 0, total: 0 });
  });
  it("reads macOS memory pressure, and flags low memory", async () => {
    const low = await systemInfo(tmp(), async () => "The system has 34359738368 bytes.\nSystem-wide memory free percentage: 6%");
    expect(low.memory).toMatchObject({ freePercent: 6, pressure: "critical" });
    const ok = await systemInfo(tmp(), async () => "System-wide memory free percentage: 55%");
    expect(ok.memory).toMatchObject({ freePercent: 55, pressure: "normal" });
    const none = await systemInfo(tmp(), async () => { throw new Error("no memory_pressure"); });
    expect(none.memory.freePercent).toBeNull(); expect(none.memory.availableBytes).toBeGreaterThan(0);
    expect(none.disk!.freeBytes).toBeGreaterThan(0);
  });
  it("probes each dependency read-only, caches it, and reports a failing probe instead of throwing", async () => {
    let t = 1000, calls = 0;
    const h = new HealthChecker({ now: () => t, ttlMs: 5000,
      claudeAuth: async () => { calls++; return JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }); },
      linearViewer: async () => { throw new Error("401 bad key"); }, ghAuth: async () => "✓ Logged in to github.com", specifyInstalled: () => false, sandboxAvailable: () => true });
    const r = await h.check();
    const by = Object.fromEntries(r.map((x) => [x.name, x]));
    expect(by["claude code"]).toMatchObject({ status: "ok" }); expect(by["claude code"]!.detail).toContain("claude.ai");
    expect(by.linear).toMatchObject({ status: "fail", detail: "401 bad key" });
    expect(by.github!.status).toBe("ok"); expect(by["spec kit"]!.status).toBe("warn"); expect(by.sandbox!.status).toBe("ok");
    await h.check(); expect(calls).toBe(1); // cached
    t += 6000; await h.check(); expect(calls).toBe(2);
    const out = new HealthChecker({ claudeAuth: async () => JSON.stringify({ loggedIn: false }) });
    expect((await out.check())[0]).toMatchObject({ status: "fail", detail: expect.stringContaining("/login") });
  });
});

describe("LaunchAgent", () => {
  const opts = (home: string) => ({ dataDir: join(home, "data"), home, repoRoot: process.cwd(), configDir: join(process.cwd(), "config") });
  it("renders a valid plist: restart only on crash, low priority, absolute paths, and NO secrets", () => {
    const home = tmp();
    const xml = buildPlist(opts(home));
    const f = join(home, "t.plist"); writeFileSync(f, xml);
    if (process.platform === "darwin") expect(execFileSync("/usr/bin/plutil", ["-lint", f], { encoding: "utf8" })).toContain("OK");
    expect(xml).toContain(`<string>${LABEL}</string>`);
    expect(xml).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/); // a clean exit (launchctl bootout) is not restarted
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/); expect(xml).toContain("<string>Background</string>"); expect(xml).toMatch(/<key>Nice<\/key>\s*<integer>5<\/integer>/);
    expect(xml).toContain(process.execPath); expect(xml).toContain("<string>serve</string>");
    expect(xml).toContain("FACTORY_CONFIG_DIR");
    expect(xml).not.toMatch(/LINEAR_API_KEY|GH_TOKEN|ANTHROPIC|SECRET|PASSWORD|sk-ant|lin_api/i);
    expect(xml).toMatch(/<key>PATH<\/key>\s*<string>[^<]*\/usr\/bin/);
  });
  it("escapes XML in every value", () => {
    const xml = renderPlist({ programArguments: ["a<b>&\"c"], workingDirectory: "/w", env: { K: "v&<>" }, stdoutPath: "/o", stderrPath: "/e" });
    expect(xml).toContain("a&lt;b&gt;&amp;&quot;c"); expect(xml).toContain("v&amp;&lt;&gt;");
  });
  it("installing writes the file but does NOT start anything; only --load runs launchctl, with the right domain", () => {
    const home = tmp(); const run = vi.fn((_f: string, _a: string[]) => "");
    const a = installAgent({ ...opts(home), run });
    expect(existsSync(a.path)).toBe(true); expect(a).toMatchObject({ loaded: false }); expect(run).not.toHaveBeenCalled();
    expect(a.path).toBe(join(home, "Library", "LaunchAgents", `${LABEL}.plist`));
    const b = installAgent({ ...opts(home), load: true, run });
    expect(b.loaded).toBe(true);
    const bootstrap = run.mock.calls.find((c) => c[1][0] === "bootstrap")!;
    expect(bootstrap[1][1]).toMatch(/^gui\/\d+$/); expect(bootstrap[1][2]).toBe(a.path);
  });
  it("uninstall boots out and removes the file; status parses launchctl output", () => {
    const home = tmp(); installAgent({ ...opts(home), run: () => "" });
    const run = vi.fn((_f: string, _a: string[]) => "");
    expect(uninstallAgent({ home, run })).toEqual({ removed: true });
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(["bootout"]));
    expect(uninstallAgent({ home, run })).toEqual({ removed: false });
    expect(agentStatus({ home, run: () => "state = running\n\tpid = 4242\n" })).toMatchObject({ loaded: true, pid: 4242, state: "running" });
    expect(agentStatus({ home, run: () => { throw new Error("not found"); } })).toMatchObject({ installed: false, loaded: false });
  });
});
