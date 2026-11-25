import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_ROOT } from "../config/load.js";
import { type Profile } from "../config/profiles.js";
import { agentServes, stopAgent, serveCommand, startAgent } from "./launchd.js";
import { brandElectron } from "./branding.js";
import { lockHolder } from "./lock.js";
import { reapOrphans } from "../agents/children.js";
import { agentPidDir } from "./runstate.js";

export const urlOf = (p: Profile, path = "/") => `http://127.0.0.1:${p.port}${path}`;

/** Is a factory service answering on this profile's port? */
export async function isUp(p: Profile, timeoutMs = 800): Promise<boolean> {
  try { return (await fetch(urlOf(p, "/health"), { signal: AbortSignal.timeout(timeoutMs) })).ok; } catch { return false; }
}

const lockFile = (p: Profile) => join(p.home, "factory.lock");
/** The pid of this profile's running service, verified (its start time matches the lock), or null. Never a bare, possibly reused, pid. */
export const pidOf = (p: Profile): number | null => lockHolder(lockFile(p));

/** The LaunchAgent operations start/stop need (injectable: tests must never touch the real launchd). */
export interface LaunchdOps {
  status(p: Profile): { installed: boolean; loaded: boolean };
  bootout(p: Profile): boolean;
  start(p: Profile): void;
}
const realLaunchd: LaunchdOps = {
  status: (p) => agentServes(p.home, { profile: p.name }), // only this install's agent, never another install's with the same label
  bootout: (p) => stopAgent({ profile: p.name }),
  start: (p) => startAgent({ profile: p.name }),
};
const noLaunchd: LaunchdOps = { status: () => ({ installed: false, loaded: false }), bootout: () => false, start: () => {} };
const launchdOf = (d?: LaunchdOps) => d ?? (process.platform === "darwin" ? realLaunchd : noLaunchd);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a profile's service in the background, detached from this terminal, with its output going to <home>/logs/service.out.
 * Returns once it answers on its port (or says why not). Does nothing if it is already running.
 */
export async function startService(p: Profile, root: string, timeoutMs = 30_000, deps: { launchd?: LaunchdOps } = {}): Promise<{ started: boolean; error?: string }> {
  if (await isUp(p)) return { started: false };
  const launchd = launchdOf(deps.launchd);
  if (launchd.status(p).installed) {
    // This profile has a LaunchAgent: let launchd own the process (it restarts it after a crash), rather than a second, unsupervised copy.
    try { launchd.start(p); } catch (e) { return { started: false, error: `launchctl could not start it: ${(e as Error).message}` }; }
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) { if (await isUp(p)) return { started: true }; await sleep(400); }
    return { started: false, error: `the LaunchAgent did not answer on port ${p.port} within ${timeoutMs / 1000}s; see ${join(p.home, "logs", "launchd.err.log")}` };
  }
  mkdirSync(join(p.home, "logs"), { recursive: true });
  const out = openSync(join(p.home, "logs", "service.out"), "a");
  const cmd = serveCommand(PACKAGE_ROOT);
  const args = [...cmd.slice(1, -1), "--profile", p.name, "serve"];
  const child = spawn(cmd[0]!, args, { cwd: PACKAGE_ROOT, detached: true, stdio: ["ignore", out, out], env: { ...process.env, FACTORY_ROOT: root } });
  child.unref();
  closeSync(out);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await isUp(p)) return { started: true };
    if (child.exitCode !== null) return { started: false, error: `exited with code ${child.exitCode}; see ${join(p.home, "logs", "service.out")}` };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { started: false, error: `did not answer on port ${p.port} within ${timeoutMs / 1000}s; see ${join(p.home, "logs", "service.out")}` };
}

export type StopOutcome = "stopped" | "killed" | "not-running";

/**
 * Graceful stop. The service aborts running agents, waits for them to exit and re-queues their jobs untouched.
 *  1. A loaded LaunchAgent is booted out: launchd stops the process and, because it is unloaded, does not restart it
 *     (a kill would not stick: KeepAlive restarts anything but a clean exit). It starts again at the next login or `start`.
 *  2. Otherwise (or if something else still holds the profile) ask the service itself over the authenticated control API.
 *  3. Only if that fails, SIGTERM the lock holder, and only a verified one (pid AND start time match the lock).
 * If it does not stop in time it is SIGKILLed (verified again first) and the agent processes it leaves behind are killed.
 */
export async function stopService(p: Profile, timeoutMs = 30_000, deps: { launchd?: LaunchdOps; fetch?: typeof fetch } = {}): Promise<StopOutcome> {
  const launchd = launchdOf(deps.launchd);
  const doFetch = deps.fetch ?? fetch;
  let acted = false;
  if (launchd.status(p).loaded) acted = launchd.bootout(p) || acted;
  const pid = pidOf(p);
  const up = await isUp(p);
  if (pid === null && !up) return acted ? "stopped" : "not-running";
  let asked = false;
  try {
    const token = readFileSync(join(p.home, "control-token"), "utf8").trim();
    const r = await doFetch(urlOf(p, "/api/control/shutdown"), { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    asked = r.ok;
  } catch { /* not answering: fall back to a signal */ }
  if (!asked && pid !== null) { try { process.kill(pid, "SIGTERM"); asked = true; } catch { /* already gone */ } }
  if (!asked) return acted ? "stopped" : "not-running"; // something answers on the port but it is not verifiably ours: leave it alone
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pidOf(p) === null && !(await isUp(p, 400))) return "stopped";
    await sleep(250);
  }
  const still = pidOf(p);
  if (still === null) return "stopped";
  try { process.kill(still, "SIGKILL"); } catch { /* gone */ } // its jobs are recovered from the database at the next start
  await sleep(300);
  await reapOrphans(agentPidDir(p.home), { graceMs: 2000 }); // its agents did not get the chance to stop
  return "killed";
}

/** The desktop app's entry point, if Electron is installed. */
export function desktopEntry(): { electron: string; main: string } | null {
  try {
    const electron = createRequire(import.meta.url)("electron") as unknown;
    const main = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop", "main.cjs");
    return typeof electron === "string" && existsSync(electron) && existsSync(main) ? { electron, main } : null;
  } catch { return null; }
}

/** Opens the app window for a profile and returns immediately (the terminal is free). A window that is already open is brought forward and switched. */
export function openDesktop(p: Profile, root: string): boolean {
  const d = desktopEntry();
  if (!d) return false;
  // The app can start the background services itself (its "Start all profiles" menu item): hand it the exact command that works here.
  brandElectron(d.electron, join(dirname(d.main), "icon.png")); // the Dock and menu bar say "Software Factory" with its icon, not "Electron" (no-op after the first time)
  const startCmd = [...serveCommand(PACKAGE_ROOT).slice(0, -1), "start", "--no-window"];
  const shutdownCmd = [...serveCommand(PACKAGE_ROOT).slice(0, -1), "shutdown"]; // stopping goes through the CLI too: launchd-aware, never a bare pid
  const env: NodeJS.ProcessEnv = { ...process.env, FACTORY_ROOT: root, FACTORY_START_JSON: JSON.stringify(startCmd), FACTORY_SHUTDOWN_JSON: JSON.stringify(shutdownCmd) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(d.electron, [d.main, "--profile", p.name], { detached: true, stdio: "ignore", env });
  child.unref();
  return true;
}
