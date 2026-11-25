import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_ROOT } from "../config/load.js";
import { type Profile } from "../config/profiles.js";
import { serveCommand } from "./launchd.js";
import { brandElectron } from "./branding.js";

export const urlOf = (p: Profile, path = "/") => `http://127.0.0.1:${p.port}${path}`;

/** Is a factory service answering on this profile's port? */
export async function isUp(p: Profile, timeoutMs = 800): Promise<boolean> {
  try { return (await fetch(urlOf(p, "/health"), { signal: AbortSignal.timeout(timeoutMs) })).ok; } catch { return false; }
}

const pidFile = (p: Profile) => join(p.home, "factory.lock");
export function pidOf(p: Profile): number | null {
  try { const n = Number(readFileSync(pidFile(p), "utf8").trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * Starts a profile's service in the background, detached from this terminal, with its output going to <home>/logs/service.out.
 * Returns once it answers on its port (or says why not). Does nothing if it is already running.
 */
export async function startService(p: Profile, root: string, timeoutMs = 30_000): Promise<{ started: boolean; error?: string }> {
  if (await isUp(p)) return { started: false };
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

/** Graceful stop: SIGTERM to the pid in the lock file. The service aborts running agents and re-queues their jobs untouched. */
export async function stopService(p: Profile, timeoutMs = 20_000): Promise<"stopped" | "not-running"> {
  const pid = pidOf(p);
  if (!pid || !alive(pid)) return "not-running";
  process.kill(pid, "SIGTERM");
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (!alive(pid)) return "stopped"; await new Promise((r) => setTimeout(r, 250)); }
  process.kill(pid, "SIGKILL"); // it did not stop in time: its jobs are recovered from the database at the next start
  return "stopped";
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
  const env: NodeJS.ProcessEnv = { ...process.env, FACTORY_ROOT: root, FACTORY_START_JSON: JSON.stringify(startCmd) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(d.electron, [d.main, "--profile", p.name], { detached: true, stdio: "ignore", env });
  child.unref();
  return true;
}
