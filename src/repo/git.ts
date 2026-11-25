import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitError extends Error {
  constructor(message: string, readonly args: string[], readonly stderr = "", readonly code?: number | string) {
    super(message);
    this.name = "GitError";
  }
}

export class UnsafeGitOperation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeGitOperation";
  }
}

const FORCE_FLAGS = new Set(["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "-d", "--prune"]);

/**
 * Hard safety rules, enforced on every git invocation made by the factory:
 *  - never force-push, mirror-push or delete remote refs
 *  - never push to (or to a refspec targeting) a protected branch such as the default branch
 *  - never rewrite protected branches locally (reset --hard / branch -D / checkout -B on them)
 */
export function assertSafeGitArgs(args: string[], protectedBranches: readonly string[] = []): void {
  const sub = args.find((a) => !a.startsWith("-") && !a.includes("="))?.toLowerCase();
  const isProtected = (ref: string) => {
    const name = ref.replace(/^\+/, "").split(":").pop()!.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
    return protectedBranches.includes(name);
  };
  if (sub === "push") {
    if (args.some((a) => FORCE_FLAGS.has(a) || a.startsWith("--force") || a.startsWith("+"))) {
      throw new UnsafeGitOperation("force/mirror/delete pushes are forbidden");
    }
    const positional = args.slice(args.indexOf("push") + 1).filter((a) => !a.startsWith("-"));
    const refs = positional.slice(1); // first positional is the remote
    if (refs.some(isProtected)) throw new UnsafeGitOperation("pushing to a protected branch is forbidden");
    if (refs.length === 0 && protectedBranches.length > 0) throw new UnsafeGitOperation("push requires an explicit branch refspec");
  }
  if (sub === "branch" && args.some((a) => a === "-D" || a === "-d" || a === "--delete") && args.some(isProtected)) {
    throw new UnsafeGitOperation("deleting a protected branch is forbidden");
  }
  if ((sub === "reset" && args.includes("--hard")) && protectedBranches.length > 0 && args.some(isProtected)) {
    throw new UnsafeGitOperation("rewriting a protected branch is forbidden");
  }
}

export interface GitOptions { timeoutMs?: number; protectedBranches?: readonly string[] }
export type GitFn = (cwd: string, args: string[], opts?: GitOptions) => Promise<string>;

/** Runs git without a shell (no injection), never prompting for credentials. */
export const git: GitFn = async (cwd, args, opts = {}) => {
  assertSafeGitArgs(args, opts.protectedBranches);
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    return stdout.replace(/\n$/, "");
  } catch (e) {
    const err = e as { stderr?: string; code?: number | string; message: string };
    throw new GitError(`git ${args.join(" ")} failed: ${(err.stderr ?? err.message).trim()}`, args, err.stderr, err.code);
  }
};
