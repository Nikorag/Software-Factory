import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ProjectConfig } from "../config/schema.js";
import { runProjectCommand, type CommandKind, type CommandResult } from "../exec/commands.js";
import { git as realGit, type GitFn } from "./git.js";

export interface CheckReport { project: string; baseRef: string; worktree: string; results: CommandResult[]; ok: boolean; missingTest: boolean }

/**
 * Proves a project's configured commands work *before* any ticket depends on them: checks out the default branch into a
 * throwaway worktree, then runs install and the checks exactly as a job's baseline would, in the same sandbox.
 * Nothing is committed or pushed, and the original checkout is untouched. The worktree is removed afterwards.
 */
export async function checkProject(
  project: ProjectConfig,
  d: { dataDir: string; sandbox: { required: boolean; readAllow?: string[]; writeAllow?: string[] }; timeoutMs: number; git?: GitFn; run?: typeof runProjectCommand; skipInstall?: boolean; keep?: boolean; onResult?: (r: CommandResult) => void },
): Promise<CheckReport> {
  const git = d.git ?? realGit;
  const run = d.run ?? runProjectCommand;
  const repo = project.repository;
  const wt = join(d.dataDir, "workspaces", project.id, "_check");
  mkdirSync(join(d.dataDir, "workspaces", project.id), { recursive: true });
  if (existsSync(wt)) {
    await git(repo, ["worktree", "remove", "--force", wt]).catch(() => rmSync(wt, { recursive: true, force: true }));
    await git(repo, ["worktree", "prune"]);
  }
  const base = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${project.defaultBranch}`]).then(() => `origin/${project.defaultBranch}`, () => project.defaultBranch);
  await git(repo, ["worktree", "add", "--detach", wt, base]); // detached: no branch is created in the user's repo
  const results: CommandResult[] = [];
  try {
    const gc = await git(wt, ["rev-parse", "--git-common-dir"]);
    const gitCommonDir = isAbsolute(gc) ? gc : resolve(wt, gc);
    const order: CommandKind[] = [...(d.skipInstall ? [] : (["install"] as const)), "build", "typecheck", "lint", "test"];
    for (const kind of order) {
      const command = project.commands[kind];
      if (!command) continue;
      const r = await run({
        kind, command, worktree: wt, timeoutMs: d.timeoutMs, profileDir: join(d.dataDir, "jobs", `_check-${project.id}`, "profiles"),
        logFile: join(d.dataDir, "logs", "check", project.id, `${kind}.log`), sandbox: { ...d.sandbox, gitCommonDir },
      });
      results.push(r);
      d.onResult?.(r);
      if (!r.ok && (kind === "install" || kind === "build")) break;
    }
  } finally {
    if (!d.keep) {
      await git(repo, ["worktree", "remove", "--force", wt]).catch(() => rmSync(wt, { recursive: true, force: true }));
      await git(repo, ["worktree", "prune"]).catch(() => undefined);
    }
  }
  return { project: project.id, baseRef: base, worktree: wt, results, ok: results.length > 0 && results.every((r) => r.ok) && Boolean(project.commands.test), missingTest: !project.commands.test };
}
