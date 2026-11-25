import type { StageHandler } from "../core/engine.js";
import { GitError } from "./git.js";
import { WorktreeError, type WorktreeManager } from "./worktrees.js";

/** IMPLEMENTATION_PREPARATION: create (or resume) the job's isolated worktree. Idempotent. */
export const prepareWorkspace = (wt: WorktreeManager): StageHandler => async ({ job }) => {
  try {
    const info = await wt.create({ id: job.id, projectId: job.projectId, externalKey: job.externalKey });
    return { kind: "ok", output: { path: info.path, branch: info.branch, base: info.base, resumed: info.resumed } };
  } catch (e) {
    if (e instanceof WorktreeError) return { kind: "blocked", reason: e.message }; // ownership/identity problems need a human
    if (e instanceof GitError) return { kind: "retry", reason: e.message };
    throw e;
  }
};
