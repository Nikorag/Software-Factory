import { git as realGit, GitError, type GitFn } from "./git.js";
import { gitAuthEnv } from "./gh.js";

export class PushRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushRejected";
  }
}

/**
 * Pushes one job branch to origin. Never forced (the git guard forbids it), never to the default branch, always with an
 * explicit `branch:branch` refspec. A non-fast-forward rejection means someone else changed the remote branch: that is
 * surfaced to a human, never overwritten.
 */
export async function pushBranch(wt: string, branch: string, o: { defaultBranch: string; account?: string; /** git credentials for the host (Bitbucket, or anything not a gh account); wins over `account` */ env?: NodeJS.ProcessEnv; git?: GitFn }): Promise<void> {
  const git = o.git ?? realGit;
  if (branch === o.defaultBranch || !branch.startsWith("factory/")) throw new PushRejected(`refusing to push "${branch}": only factory/* branches may be pushed`);
  try {
    await git(wt, ["push", "--set-upstream", "origin", `${branch}:${branch}`], { protectedBranches: [o.defaultBranch], env: o.env ?? await gitAuthEnv(o.account), timeoutMs: 180_000 });
  } catch (e) {
    if (e instanceof GitError && /rejected|non-fast-forward|fetch first|stale info/i.test(e.message)) {
      throw new PushRejected(`origin/${branch} has commits this branch does not (someone else pushed). The factory never force-pushes; a human must reconcile.`);
    }
    throw e;
  }
}
