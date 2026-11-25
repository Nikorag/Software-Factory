import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainChildren, installCrashHandlers, liveChildren, reapOrphans, setChildPidDir, shutdownController, trackChild, verifiedGroup } from "../src/agents/children.js";
import { runProcess } from "../src/agents/process.js";
import { alive, identify } from "../src/service/proc.js";
import { tmp } from "./helpers/git-fixture.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(20); return cond(); };
const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;
const groupAlive = (g: number) => { try { process.kill(-g, 0); return true; } catch { return false; } };
/** A detached group: a shell leader plus a `sleep` grandchild (what an agent running a test suite looks like). */
async function group(): Promise<{ leader: ChildProcess; pgid: number; start: string }> {
  const leader = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  await until(() => identify(leader.pid!).start !== null);
  return { leader, pgid: leader.pid!, start: identify(leader.pid!).start! };
}
const spawned: number[] = [];
afterEach(() => { setChildPidDir(null); for (const g of spawned.splice(0)) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } } });

describe("child process groups are recorded", () => {
  it("runProcess records each group under the pid dir while it runs and removes it when it ends", async () => {
    const dir = join(tmp(), "run", "agents");
    setChildPidDir(dir);
    const run = runProcess({ cmd: "/bin/sh", args: ["-c", "sleep 0.5"], cwd: tmp(), env: process.env, timeoutMs: 10_000 });
    expect(await until(() => readdirSync(dir).length === 1)).toBe(true);
    const rec = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")) as { pgid: number; start: string; owner: { pid: number } };
    expect(rec.owner.pid).toBe(process.pid); expect(rec.start).toBe(identify(rec.pgid).start); expect(liveChildren()).toContain(rec.pgid);
    expect((await run).exitCode).toBe(0);
    expect(readdirSync(dir)).toEqual([]); expect(liveChildren()).toEqual([]);
  });
  it("records nothing on disk when no pid dir is set (tests, one-off CLI commands)", async () => {
    const r = await runProcess({ cmd: "/bin/sh", args: ["-c", "true"], cwd: tmp(), env: process.env, timeoutMs: 5000 });
    expect(r.exitCode).toBe(0); expect(liveChildren()).toEqual([]);
  });
});

describe("shutdown waits for children", () => {
  it("drainChildren waits for groups to exit and SIGKILLs the ones that will not", async () => {
    const stubborn = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30 & wait"], { detached: true, stdio: "ignore" });
    spawned.push(stubborn.pid!);
    const untrack = trackChild(stubborn.pid!);
    stubborn.on("exit", untrack);
    await sleep(300); // let the shell set its trap
    process.kill(-stubborn.pid!, "SIGTERM");
    expect(await drainChildren(300)).toBe(1);
    expect(await until(() => !groupAlive(stubborn.pid!))).toBe(true);
    expect(await drainChildren(300)).toBe(0); // nothing left
  });
  it("a second signal escalates (agents SIGKILLed so the stop can finish) instead of exiting half-way; a third exits; the API never escalates", async () => {
    const g = await group(); spawned.push(g.pgid);
    const untrack = trackChild(g.pgid); g.leader.on("exit", untrack);
    let release!: () => void;
    const stop = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const exit = vi.fn();
    const shutdown = shutdownController(stop, { exit, log: () => {} });
    const first = shutdown("SIGTERM");
    await shutdown("api", false); // ignored while stopping
    expect(stop).toHaveBeenCalledTimes(1); expect(exit).not.toHaveBeenCalled(); expect(groupAlive(g.pgid)).toBe(true);
    await shutdown("SIGTERM");
    expect(await until(() => !groupAlive(g.pgid))).toBe(true); expect(exit).not.toHaveBeenCalled(); // escalated, still stopping
    await shutdown("SIGINT");
    expect(exit).toHaveBeenCalledWith(0);
    release(); await first;
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("a crash kills every child and exits non-zero (so launchd restarts the service)", async () => {
    const g = await group(); spawned.push(g.pgid);
    const untrack = trackChild(g.pgid); g.leader.on("exit", untrack);
    const exit = vi.fn(); const report = vi.fn();
    const before = process.listeners("uncaughtException").length;
    const uninstall = installCrashHandlers(report, exit);
    try {
      const handler = process.listeners("uncaughtException").at(-1)!;
      handler(new Error("boom"), "uncaughtException");
      expect(report).toHaveBeenCalledWith("uncaughtException", expect.any(Error)); expect(exit).toHaveBeenCalledWith(1);
      expect(await until(() => !groupAlive(g.pgid))).toBe(true);
    } finally { uninstall(); }
    expect(process.listeners("uncaughtException").length).toBe(before);
  });
});

describe("orphans left by a service that died", () => {
  const record = (dir: string, r: object, name: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${name}.json`), JSON.stringify(r)); };
  const deadOwner = { pid: 999_999_999, start: "Mon Jan  1 00:00:00 2001" };

  it("kills a verified leftover group (leader and grandchildren) and removes its record", async () => {
    const dir = tmp(); const g = await group(); spawned.push(g.pgid);
    record(dir, { pgid: g.pgid, start: g.start, owner: deadOwner }, String(g.pgid));
    const r = await reapOrphans(dir, { graceMs: 1000 });
    expect(r.killed).toEqual([g.pgid]);
    expect(await until(() => !groupAlive(g.pgid))).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("never kills a reused pid: a live process whose start time differs from the record", async () => {
    const dir = tmp(); const g = await group(); spawned.push(g.pgid);
    record(dir, { pgid: g.pgid, start: "Mon Jan  1 00:00:00 2001", owner: deadOwner }, String(g.pgid));
    expect(await reapOrphans(dir, { graceMs: 200 })).toEqual({ killed: [], skipped: [] });
    expect(exited(g.leader)).toBe(false); expect(groupAlive(g.pgid)).toBe(true);
    expect(readdirSync(dir)).toEqual([]); // the stale record is dropped
  });
  it("leaves alone groups whose service is still running, and drops garbage and records of groups that are gone", async () => {
    const dir = tmp(); const g = await group(); spawned.push(g.pgid);
    const otherService = spawn("sleep", ["30"], { stdio: "ignore" }); spawned.push(otherService.pid!);
    await until(() => identify(otherService.pid!).start !== null);
    record(dir, { pgid: g.pgid, start: g.start, owner: identify(otherService.pid!) }, String(g.pgid));
    record(dir, { pgid: 999_999_998, start: "Mon Jan  1 00:00:00 2001", owner: deadOwner }, "999999998");
    writeFileSync(join(dir, "junk.json"), "{not json");
    const r = await reapOrphans(dir, { graceMs: 200 });
    expect(r).toEqual({ killed: [], skipped: [g.pgid] });
    expect(groupAlive(g.pgid)).toBe(true);
    expect(readdirSync(dir)).toEqual([`${g.pgid}.json`]);
    otherService.kill("SIGKILL");
  });
  it("a missing pid dir is nothing to do", async () => {
    expect(await reapOrphans(join(tmp(), "nope"))).toEqual({ killed: [], skipped: [] });
    expect(existsSync(join(tmp(), "nope"))).toBe(false);
  });
  it("verifiedGroup: the leader must match; without a leader every member must have started after the record", () => {
    const rec = { pgid: 50, start: "Wed Nov 25 10:00:00 2026", owner: deadOwner };
    expect(verifiedGroup(rec, [])).toEqual([]);
    expect(verifiedGroup(rec, [{ pid: 50, pgid: 50, start: "Wed Nov 25 10:00:00 2026" }, { pid: 51, pgid: 50, start: "Wed Nov 25 10:00:05 2026" }])).toEqual([50, 51]);
    expect(verifiedGroup(rec, [{ pid: 50, pgid: 50, start: "Thu Nov 26 09:00:00 2026" }])).toEqual([]); // reused leader pid
    expect(verifiedGroup(rec, [{ pid: 51, pgid: 50, start: "Wed Nov 25 10:00:05 2026" }])).toEqual([51]); // leader gone, its children live on
    expect(verifiedGroup(rec, [{ pid: 51, pgid: 50, start: "Tue Nov 24 10:00:05 2026" }])).toEqual([]); // older than the record: not ours
    expect(verifiedGroup({ ...rec, start: "garbage" }, [{ pid: 51, pgid: 50, start: "Wed Nov 25 10:00:05 2026" }])).toEqual([]);
    expect(alive(process.pid)).toBe(true);
  });
});
