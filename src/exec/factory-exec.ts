import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProjectCommand, SandboxUnavailable, type CommandKind } from "./commands.js";

/**
 * The only way an *agent* runs project code: `factory-exec test|lint|typecheck|build`. The command text comes from
 * the factory's own spec file (outside the worktree, unwritable by the agent), never from the agent, and runs inside
 * the sandbox. The agent therefore cannot execute arbitrary commands through it, and what it can run has no network.
 */
export interface ExecSpec {
  worktree: string;
  profileDir: string;
  commands: Partial<Record<Exclude<CommandKind, "install">, string>>;
  timeoutMs: number;
  sandbox?: { required?: boolean; readAllow?: string[]; gitCommonDir?: string; loopback?: boolean };
}

export async function main(argv: string[]): Promise<number> {
  const [specPath, kind] = argv;
  if (!specPath || !kind) { console.error("usage: factory-exec <test|lint|typecheck|build>"); return 64; }
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as ExecSpec;
  if (!["test", "lint", "typecheck", "build"].includes(kind)) { console.error(`unknown check "${kind}" (allowed: test, lint, typecheck, build)`); return 64; }
  const command = spec.commands[kind as keyof ExecSpec["commands"]];
  if (!command) { console.error(`no ${kind} command is configured for this project`); return 65; }
  try {
    const r = await runProjectCommand({ kind: kind as CommandKind, command, worktree: spec.worktree, timeoutMs: spec.timeoutMs, profileDir: spec.profileDir, sandbox: spec.sandbox });
    console.log(r.tail);
    console.log(`\n[factory-exec] ${kind}: ${r.ok ? "PASSED" : r.timedOut ? "TIMED OUT" : `FAILED (exit ${r.exitCode})`} in ${Math.round(r.durationMs / 1000)}s${r.sandboxed ? " (sandboxed, no network)" : ""}`);
    return r.ok ? 0 : 1;
  } catch (e) {
    console.error(e instanceof SandboxUnavailable ? e.message : `factory-exec failed: ${(e as Error).message}`);
    return 70;
  }
}

/** Writes the job's exec spec and a wrapper script; returns the wrapper path (what the agent is allowed to run). */
export function writeExecWrapper(jobDir: string, spec: ExecSpec): string {
  mkdirSync(jobDir, { recursive: true });
  const specPath = join(jobDir, "exec-spec.json");
  writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith(".ts");
  const loader = isTs ? ` --import ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href)}` : "";
  const entry = join(dirname(here), isTs ? "run-factory-exec.ts" : "run-factory-exec.js");
  const wrapper = join(jobDir, "factory-exec");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)}${loader} ${JSON.stringify(entry)} ${JSON.stringify(specPath)} "$@"\n`, { mode: 0o700 });
  chmodSync(wrapper, 0o700);
  return wrapper;
}
