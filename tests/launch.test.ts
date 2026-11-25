import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isUp, pidOf, startService, stopService, type LaunchdOps } from "../src/service/launch.js";
import type { Profile } from "../src/config/profiles.js";
import { commandOf, identify } from "../src/service/proc.js";
import { agentPidDir } from "../src/service/runstate.js";
import { tmp } from "./helpers/git-fixture.js";

const profile = (port: number): Profile => { const home = tmp(); mkdirSync(home, { recursive: true }); return { name: "t", home, port }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(20); return cond(); };
const noLaunchd = (over: Partial<LaunchdOps> = {}): LaunchdOps => ({ status: () => ({ installed: false, loaded: false }), bootout: () => false, start: () => {}, ...over });
const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

/** A process whose command line looks like `factory serve`, holding a current-format lock. */
async function fakeService(p: Profile, script = "setInterval(() => {}, 1000)"): Promise<ChildProcess> {
  const c = spawn(process.execPath, ["-e", script, "/x/dist/src/cli.js", "serve"], { stdio: "ignore" });
  await until(() => (commandOf(c.pid!) ?? "").includes("serve"));
  writeFileSync(join(p.home, "factory.lock"), JSON.stringify(identify(c.pid!)));
  return c;
}
const listen = async (handler: Parameters<typeof createServer>[1]): Promise<{ srv: Server; port: number }> => {
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, port: (srv.address() as { port: number }).port };
};

describe("background service helpers", () => {
  it("isUp tells a live factory from nothing at all", async () => {
    const { srv, port } = await listen((req, res) => { res.statusCode = req.url === "/health" ? 200 : 404; res.end("{}"); });
    expect(await isUp(profile(port))).toBe(true);
    srv.close();
    expect(await isUp(profile(port))).toBe(false);
  });
  it("pidOf only names a verified holder: garbage, a dead pid or a reused pid (wrong start time) is no one", async () => {
    const p = profile(1);
    expect(pidOf(p)).toBeNull(); // no lock file
    writeFileSync(join(p.home, "factory.lock"), "not a pid");
    expect(pidOf(p)).toBeNull();
    writeFileSync(join(p.home, "factory.lock"), JSON.stringify({ pid: process.pid, start: "Mon Jan  1 00:00:00 2001" }));
    expect(pidOf(p)).toBeNull();
    writeFileSync(join(p.home, "factory.lock"), String(process.pid)); // old format, alive, but not a factory
    expect(pidOf(p)).toBeNull();
    const svc = await fakeService(p);
    try { expect(pidOf(p)).toBe(svc.pid); } finally { svc.kill("SIGKILL"); }
  });
});

describe("stopService", () => {
  it("says so when nothing is running", async () => {
    expect(await stopService(profile(1), 2000, { launchd: noLaunchd() })).toBe("not-running");
  });
  it("never signals a pid that is not verifiably the factory (a reused pid after a crash or reboot)", async () => {
    const p = profile(1);
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(join(p.home, "factory.lock"), String(bystander.pid));
      expect(await stopService(p, 1000, { launchd: noLaunchd() })).toBe("not-running");
      writeFileSync(join(p.home, "factory.lock"), JSON.stringify({ pid: bystander.pid, start: "Mon Jan  1 00:00:00 2001" }));
      expect(await stopService(p, 1000, { launchd: noLaunchd() })).toBe("not-running");
      await sleep(100);
      expect(exited(bystander)).toBe(false);
    } finally { bystander.kill("SIGKILL"); }
  });
  it("asks the service over its authenticated control API first", async () => {
    const p0 = profile(1);
    const svc = await fakeService(p0);
    const seen: string[] = [];
    const { srv, port } = await listen((req, res) => {
      if (req.url === "/api/control/shutdown" && req.method === "POST") { seen.push(req.headers.authorization ?? ""); res.end("{}"); svc.kill("SIGKILL"); srv.close(); return; }
      res.statusCode = req.url === "/health" ? 200 : 404; res.end("{}");
    });
    const p = { ...p0, port };
    writeFileSync(join(p.home, "control-token"), "secret-token");
    expect(await stopService(p, 5000, { launchd: noLaunchd() })).toBe("stopped");
    expect(seen).toEqual(["Bearer secret-token"]);
    expect(svc.signalCode).toBe("SIGKILL"); // from the fake server's "shutdown", not a SIGTERM from stopService
  });
  it("falls back to SIGTERM for a verified holder that does not answer", async () => {
    const p = profile(1);
    const svc = await fakeService(p);
    expect(await stopService(p, 5000, { launchd: noLaunchd() })).toBe("stopped");
    expect(await until(() => exited(svc))).toBe(true);
    expect(svc.signalCode).toBe("SIGTERM");
  });
  it("a loaded LaunchAgent is booted out (so launchd does not restart it), not killed", async () => {
    const p = profile(1);
    const bootout = vi.fn((_p: Profile) => true);
    expect(await stopService(p, 1000, { launchd: noLaunchd({ status: () => ({ installed: true, loaded: true }), bootout }) })).toBe("stopped");
    expect(bootout).toHaveBeenCalledWith(p);
  });
  it("SIGKILLs a holder that ignores SIGTERM, then kills the agent groups it leaves behind", async () => {
    const p = profile(1);
    const svc = await fakeService(p, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      await until(() => identify(orphan.pid!).start !== null);
      mkdirSync(agentPidDir(p.home), { recursive: true });
      writeFileSync(join(agentPidDir(p.home), `${orphan.pid}.json`), JSON.stringify({ pgid: orphan.pid, start: identify(orphan.pid!).start, owner: identify(svc.pid!) }));
      expect(await stopService(p, 600, { launchd: noLaunchd() })).toBe("killed");
      expect(await until(() => exited(svc))).toBe(true); expect(svc.signalCode).toBe("SIGKILL");
      expect(await until(() => exited(orphan))).toBe(true);
    } finally { svc.kill("SIGKILL"); orphan.kill("SIGKILL"); }
  });
});

describe("startService", () => {
  it("lets launchd start a profile that has a LaunchAgent instead of spawning an unsupervised copy", async () => {
    const free = await listen(() => {}); free.srv.close();
    const p = profile(free.port);
    let srv: Server | undefined;
    const start = vi.fn((_p: Profile) => { srv = createServer((_q, r) => r.end("{}")); srv.listen(free.port, "127.0.0.1"); });
    try {
      expect(await startService(p, p.home, 5000, { launchd: noLaunchd({ status: () => ({ installed: true, loaded: false }), start }) })).toEqual({ started: true });
      expect(start).toHaveBeenCalledWith(p);
    } finally { srv?.close(); }
  });
});
