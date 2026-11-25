import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { trackChild } from "./children.js";

export interface RunOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  logFile?: string;
  graceMs?: number; // SIGTERM -> SIGKILL delay
  maxOutputBytes?: number;
}
export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
  durationMs: number;
}

/**
 * Runs a child in its own process group so timeout/cancel kills the whole tree (an agent's shell, test runners,
 * dev servers), not just the top process. stdin is always explicit so the child never waits on a TTY.
 */
export function runProcess(o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const max = o.maxOutputBytes ?? 32 * 1024 * 1024;
    let stdout = "", stderr = "", timedOut = false, cancelled = false, settled = false;
    let log: ReturnType<typeof createWriteStream> | undefined;
    if (o.logFile) {
      mkdirSync(dirname(o.logFile), { recursive: true });
      log = createWriteStream(o.logFile, { flags: "a" });
    }
    const done = (r: Partial<RunResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      o.signal?.removeEventListener("abort", onAbort);
      log?.end();
      resolve({ exitCode: null, stdout, stderr, timedOut, cancelled, durationMs: Date.now() - started, ...r });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(o.cmd, o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) { return done({ spawnError: (e as Error).message }); }
    // Recorded so a shutdown waits for it, a crash kills it, and a service that died without either reaps it at its next start.
    const untrack = child.pid ? trackChild(child.pid, o.cmd) : () => {};

    const killGroup = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* already gone */ } };
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), o.graceMs ?? 5000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
    const onAbort = () => { cancelled = true; stop(); };
    if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout!.on("data", (d: Buffer) => { log?.write(d); if (stdout.length < max) stdout += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { log?.write(`[stderr] ${d}`); if (stderr.length < max) stderr += d.toString(); });
    child.on("error", (e) => { untrack(); done({ spawnError: e.message }); });
    // "close" (not "exit") so all output is drained. Make sure nothing in the group outlives a finished run.
    child.on("close", (code) => { killGroup("SIGKILL"); untrack(); done({ exitCode: code }); });
    child.stdin!.on("error", () => { /* child exited before reading stdin */ });
    child.stdin!.end(o.stdin ?? "");
  });
}
