import { join } from "node:path";
import { agentEnv } from "../agents/env.js";
import { runProcess, type RunResult } from "../agents/process.js";
import { sandboxAvailable, sandboxPrefix, type SandboxOptions } from "./sandbox.js";

export type CommandKind = "install" | "build" | "test" | "lint" | "typecheck";

export interface CommandResult {
  kind: CommandKind;
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /** Last part of combined output: what a reviewer or the agent needs, bounded for prompts. */
  tail: string;
  sandboxed: boolean;
  logFile?: string;
}

export class SandboxUnavailable extends Error {
  constructor() {
    super("sandbox-exec is not available, and sandboxing is required (set factory.sandbox.required: false to run project commands unconfined, which is NOT recommended)");
    this.name = "SandboxUnavailable";
  }
}

export interface RunCommandOptions {
  kind: CommandKind;
  command: string; // from trusted config (never from an agent or a ticket)
  worktree: string;
  timeoutMs: number;
  signal?: AbortSignal;
  logFile?: string;
  profileDir: string; // where the sandbox profile file is written (outside the worktree)
  sandbox?: { required?: boolean; readAllow?: string[]; writeAllow?: string[]; gitCommonDir?: string; home?: string };
  tailChars?: number;
}

const TAIL = 8000;
export const tailOf = (s: string, n = TAIL) => (s.length > n ? `…[${s.length - n} earlier chars omitted]\n${s.slice(-n)}` : s);

/**
 * Runs a configured project command with a scrubbed environment (no tokens), in its own process group, inside the
 * sandbox. Installs get network and package-cache writes; everything else gets neither.
 */
export async function runProjectCommand(o: RunCommandOptions, deps: { run?: typeof runProcess; available?: () => boolean } = {}): Promise<CommandResult> {
  const run = deps.run ?? runProcess;
  const required = o.sandbox?.required ?? true;
  const useSandbox = (deps.available ?? sandboxAvailable)();
  if (!useSandbox && required) throw new SandboxUnavailable();
  const isInstall = o.kind === "install";
  const opts: SandboxOptions = {
    worktree: o.worktree, network: isInstall, home: o.sandbox?.home, readAllow: o.sandbox?.readAllow, gitCommonDir: o.sandbox?.gitCommonDir,
    writeAllow: isInstall ? (o.sandbox?.writeAllow ?? undefined) : undefined,
  };
  const prefix = useSandbox ? sandboxPrefix(opts, join(o.profileDir, `sandbox-${o.kind}.sb`)) : [];
  const argv = [...prefix, "/bin/sh", "-c", o.command];
  const r: RunResult = await run({
    cmd: argv[0]!, args: argv.slice(1), cwd: o.worktree, env: agentEnv(process.env, { NO_COLOR: "1", FORCE_COLOR: "0" }),
    stdin: "", timeoutMs: o.timeoutMs, signal: o.signal, logFile: o.logFile,
  });
  const out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`;
  const failedToStart = r.spawnError !== undefined;
  return {
    kind: o.kind, command: o.command, ok: !failedToStart && !r.timedOut && !r.cancelled && r.exitCode === 0, exitCode: r.exitCode,
    timedOut: r.timedOut, cancelled: r.cancelled, durationMs: r.durationMs, sandboxed: useSandbox, logFile: o.logFile,
    tail: tailOf(failedToStart ? `could not start: ${r.spawnError}` : out, o.tailChars),
  };
}
