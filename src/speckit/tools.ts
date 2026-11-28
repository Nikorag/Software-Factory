import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { git as realGit, type GitFn } from "../repo/git.js";
import { runProcess, type RunOptions, type RunResult } from "../agents/process.js";

/** Finds an executable on PATH or in common user-install dirs (a LaunchAgent's PATH is minimal). */
export function findBinary(name: string, env: NodeJS.ProcessEnv = process.env, extraDirs = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]): string | null {
  for (const dir of [...(env.PATH ?? "").split(":"), ...extraDirs]) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export const isInitialised = (worktree: string): boolean => existsSync(join(worktree, ".specify", "init-options.json")) && existsSync(join(worktree, ".claude", "skills", "speckit-specify", "SKILL.md"));

export interface InitDeps { bin?: string; run?: (o: RunOptions) => Promise<RunResult>; env?: NodeJS.ProcessEnv }

/** Runs `specify init` (the factory runs this trusted tool itself; an agent never does). Flags verified against `specify init --help` (1.4.4). */
export async function initSpecKit(cwd: string, d: InitDeps = {}): Promise<void> {
  const bin = d.bin ?? findBinary("specify");
  if (!bin) throw new Error("`specify` is not installed (uv tool install specify-cli)");
  const r = await (d.run ?? runProcess)({
    cmd: bin, args: ["init", "--here", "--force", "--integration", "claude", "--script", "sh", "--non-interactive", "--ignore-agent-tools"],
    cwd, env: { ...(d.env ?? process.env), NO_COLOR: "1", CI: "1" }, stdin: "", timeoutMs: 180_000,
  });
  if (r.spawnError || r.exitCode !== 0) throw new Error(`specify init failed (exit ${r.exitCode}): ${(r.stderr || r.stdout || r.spawnError || "").slice(0, 500)}`);
}

// Identity via environment, which git honours over `-c`/config, so a user's own GIT_AUTHOR_* cannot override it.
const IDENT_ENV = { GIT_AUTHOR_NAME: "Software Factory", GIT_AUTHOR_EMAIL: "factory@localhost", GIT_COMMITTER_NAME: "Software Factory", GIT_COMMITTER_EMAIL: "factory@localhost" };

/** Commits only the given paths, if they changed. The factory commits spec artefacts itself; spec agents cannot commit. */
export async function commitPaths(cwd: string, paths: string[], message: string, git: GitFn = realGit): Promise<boolean> {
  const existing = [];
  for (const p of paths) if (existsSync(join(cwd, p))) existing.push(p);
  if (existing.length === 0) return false;
  await git(cwd, ["add", "--", ...existing]);
  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (!staged) return false;
  await git(cwd, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env: IDENT_ENV });
  return true;
}

/** Never sweep dependency or build output into a commit, even in a repo that forgot to gitignore it. */
export const NEVER_COMMIT =/(^|\/)(node_modules|\.pnpm-store|test-results|playwright-report|blob-report)(\/|$)|(^|\/)playwright\/\.cache(\/|$)|(^|\/)\.DS_Store$/; // incl. Playwright's default screenshot, trace and report dirs

/** Commits whatever is left in the worktree (e.g. tasks ticked by an agent) as the factory. Returns whether a commit was made. */
export async function commitAll(cwd: string, message: string, git: GitFn = realGit): Promise<boolean> {
  // Not `:(exclude)node_modules` pathspecs: when node_modules exists and is gitignored (the usual case), git refuses the whole
  // `add` ("The following paths are ignored"). Stage normally, then unstage anything that must never be committed.
  await git(cwd, ["add", "-A", "--", "."]);
  const never = (await git(cwd, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter((f) => f && NEVER_COMMIT.test(f));
  for (let i = 0; i < never.length; i += 200) await git(cwd, ["reset", "-q", "--", ...never.slice(i, i + 200)]);
  if (!(await git(cwd, ["diff", "--cached", "--name-only"]))) return false;
  await git(cwd, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env: IDENT_ENV });
  return true;
}
