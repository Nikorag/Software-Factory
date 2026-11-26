import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { FactoryDb } from "../db/client.js";
import { decisions, worktrees } from "../db/schema.js";
import { git as realGit, type GitFn } from "./git.js";

export class WorktreeError extends Error {
  constructor(message: string, readonly code: "invalid-key" | "owned" | "dirty" | "no-base" | "not-found" | "not-a-repo") {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface WorktreeInfo { jobId: string; path: string; branch: string; base: string; resumed: boolean }
export interface ReconcileReport { missing: string[]; orphans: string[] }

const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

export class WorktreeManager {
  private readonly git: GitFn;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly o: {
    db: FactoryDb;
    logger: Logger;
    workspacesRoot: string; // <dataDir>/workspaces
    repoPath: (projectId: string) => string; // path of the original checkout
    defaultBranch: (projectId: string) => string;
    networkEnv?: (projectId: string) => Promise<NodeJS.ProcessEnv | undefined>; // account-scoped auth for fetch
    git?: GitFn;
  }) {
    this.git = o.git ?? realGit;
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.locks.set(key, run);
    return run.finally(() => { if (this.locks.get(key) === run) this.locks.delete(key); });
  }

  static branchFor(issueKey: string): string { return `factory/${issueKey}`; }

  private pathFor(projectId: string, issueKey: string): string {
    if (!KEY.test(issueKey) || !KEY.test(projectId)) throw new WorktreeError(`unsafe project/issue identifier: ${projectId}/${issueKey}`, "invalid-key");
    const root = resolve(this.o.workspacesRoot);
    const p = resolve(root, projectId, issueKey);
    if (!p.startsWith(root + sep)) throw new WorktreeError("worktree path escapes workspaces root", "invalid-key");
    return p;
  }

  private async isClean(path: string): Promise<boolean> {
    return (await this.git(path, ["status", "--porcelain"])).length === 0;
  }

  private async listed(repo: string): Promise<Map<string, string | null>> {
    const out = await this.git(repo, ["worktree", "list", "--porcelain"]);
    const m = new Map<string, string | null>();
    let cur: string | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) { cur = real(line.slice(9)); m.set(cur, null); }
      else if (line.startsWith("branch ") && cur) m.set(cur, line.slice(7).replace(/^refs\/heads\//, ""));
    }
    return m;
  }

  /**
   * Create (or idempotently resume) the isolated worktree for a job. The original checkout's working tree
   * is never touched; only git metadata (a worktree entry and a branch) is added.
   */
  async create(job: { id: string; projectId: string; externalKey: string }): Promise<WorktreeInfo> {
    const path = this.pathFor(job.projectId, job.externalKey);
    return await this.serialize(path, () => this.createLocked(job, path));
  }

  private async createLocked(job: { id: string; projectId: string; externalKey: string }, path: string): Promise<WorktreeInfo> {
    const { db, logger } = this.o;
    const repo = this.o.repoPath(job.projectId);
    const def = this.o.defaultBranch(job.projectId);
    const branch = WorktreeManager.branchFor(job.externalKey);
    if (branch === def) throw new WorktreeError("refusing to use the default branch", "invalid-key");
    await this.git(repo, ["rev-parse", "--git-dir"]).catch(() => { throw new WorktreeError(`${repo} is not a git repository`, "not-a-repo"); });

    // Ownership: one worktree per path, owned by exactly one job.
    const byPath = db.select().from(worktrees).where(eq(worktrees.path, path)).get();
    if (byPath && byPath.jobId !== job.id) {
      if (byPath.state === "removed") db.delete(worktrees).where(eq(worktrees.jobId, byPath.jobId)).run();
      else throw new WorktreeError(`worktree ${path} is owned by job ${byPath.jobId} (${byPath.state})`, "owned");
    }
    const mine = db.select().from(worktrees).where(eq(worktrees.jobId, job.id)).get();

    // Resume path: a crash after creation must not duplicate or clobber work.
    if (mine && mine.state === "active" && existsSync(path)) {
      const listed = await this.listed(repo);
      if (listed.get(real(path)) === branch) {
        if (!(await this.isClean(path))) logger.warn({ jobId: job.id, path }, "resuming worktree with uncommitted changes");
        return { jobId: job.id, path, branch, base: await this.baseOf(mine, repo, def), resumed: true };
      }
    }
    if (mine && mine.state === "preserved") throw new WorktreeError(`worktree for job ${job.id} was preserved for investigation`, "owned");
    if (mine) db.delete(worktrees).where(eq(worktrees.jobId, job.id)).run(); // stale row: recreate below
    await this.git(repo, ["worktree", "prune"]);

    await this.git(repo, ["fetch", "--quiet", "origin", def], { timeoutMs: 120_000, env: await this.o.networkEnv?.(job.projectId) }).catch((e) => logger.warn({ err: String(e) }, "fetch failed; using local refs"));
    let base = "";
    for (const cand of [`refs/remotes/origin/${def}`, `refs/heads/${def}`]) {
      if (await this.git(repo, ["rev-parse", "--verify", "--quiet", cand]).then(() => true, () => false)) { base = cand.replace(/^refs\/(remotes|heads)\//, ""); break; }
    }
    if (!base) throw new WorktreeError(`default branch ${def} not found`, "no-base");

    // Record intent before touching git so a crash leaves a row that create() can reconcile.
    mkdirSync(dirname(path), { recursive: true });
    const baseSha = (await this.git(repo, ["rev-parse", "--verify", base])).trim();
    db.insert(worktrees).values({ jobId: job.id, projectId: job.projectId, path, branch, baseSha, state: "active" }).run();
    try {
      const branchExists = await this.git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
      if (existsSync(path)) throw new WorktreeError(`path ${path} already exists and is not a registered worktree`, "owned");
      await this.git(repo, branchExists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, base]);
      if (existsSync(join(path, ".gitmodules"))) {
        await this.git(path, ["submodule", "update", "--init", "--recursive"], { timeoutMs: 300_000 });
      }
      if (!(await this.isClean(path))) throw new WorktreeError(`new worktree at ${path} is not clean`, "dirty");
    } catch (e) {
      db.delete(worktrees).where(eq(worktrees.jobId, job.id)).run();
      throw e;
    }
    db.insert(decisions).values({ jobId: job.id, kind: "worktree.create", decision: `${path} @ ${branch} from ${base}`, actor: "factory" }).run();
    return { jobId: job.id, path, branch, base: baseSha, resumed: false };
  }

  /**
   * The commit a worktree's branch was created from. Recorded at creation; for worktrees created before it was recorded,
   * the real branch point (merge-base with the remote default branch) is computed once and stored. Never the local
   * default branch, which can lag far behind and would make every upstream commit look like the agent's work.
   */
  private async baseOf(row: typeof worktrees.$inferSelect, repo: string, def: string): Promise<string> {
    if (row.baseSha) return row.baseSha;
    for (const ref of [`origin/${def}`, def]) {
      const sha = await this.git(repo, ["merge-base", ref, row.branch]).catch(() => "");
      if (sha.trim()) {
        this.o.db.update(worktrees).set({ baseSha: sha.trim() }).where(eq(worktrees.jobId, row.jobId)).run();
        return sha.trim();
      }
    }
    throw new WorktreeError(`cannot determine the base commit of ${row.branch}`, "no-base");
  }

  /** Mark a worktree to keep for investigation (e.g. failed job). It is never auto-removed. */
  preserve(jobId: string, reason: string): void {
    const row = this.o.db.select().from(worktrees).where(eq(worktrees.jobId, jobId)).get();
    if (!row) throw new WorktreeError(`no worktree for job ${jobId}`, "not-found");
    this.o.db.transaction((tx) => {
      tx.update(worktrees).set({ state: "preserved" }).where(eq(worktrees.jobId, jobId)).run();
      tx.insert(decisions).values({ jobId, kind: "worktree.preserve", decision: row.path, rationale: reason, actor: "factory" }).run();
    });
  }

  /**
   * Remove a worktree after its work has merged. Refuses if it has uncommitted changes. The local branch is
   * deleted with `-d` (merge-checked) unless `deleteBranch: "force"`, which callers use only after verifying
   * the merge (squash merges are invisible to `-d`).
   * `discardChanges` is for a human who has been told what is lost (deleting a job): uncommitted changes are discarded
   * (`worktree remove --force`) instead of refusing.
   */
  remove(jobId: string, opts: { deleteBranch?: "safe" | "force"; discardChanges?: boolean } = {}): Promise<void> {
    const row = this.o.db.select().from(worktrees).where(eq(worktrees.jobId, jobId)).get();
    if (!row) throw new WorktreeError(`no worktree for job ${jobId}`, "not-found");
    return this.serialize(row.path, async () => {
      if (row.state === "removed") return;
      const repo = this.o.repoPath(row.projectId);
      if (existsSync(row.path)) {
        const dirty = !(await this.isClean(row.path));
        if (dirty && !opts.discardChanges) {
          this.preserve(jobId, "dirty at cleanup");
          throw new WorktreeError(`worktree ${row.path} has uncommitted changes; preserved`, "dirty");
        }
        await this.git(repo, ["worktree", "remove", ...(dirty ? ["--force"] : []), row.path]);
      }
      await this.git(repo, ["worktree", "prune"]);
      const flag = opts.deleteBranch === "force" ? "-D" : "-d";
      await this.git(repo, ["branch", flag, row.branch], { protectedBranches: [this.o.defaultBranch(row.projectId)] })
        .catch((e) => this.o.logger.warn({ branch: row.branch, err: String(e) }, "branch not deleted"));
      this.o.db.transaction((tx) => {
        tx.update(worktrees).set({ state: "removed" }).where(eq(worktrees.jobId, jobId)).run();
        tx.insert(decisions).values({ jobId, kind: "worktree.remove", decision: row.path, actor: "factory" }).run();
      });
    });
  }

  /** Compare DB and git for a project. Reports drift; destroys nothing (orphans may hold someone's work). */
  async reconcile(projectId: string): Promise<ReconcileReport> {
    const repo = this.o.repoPath(projectId);
    await this.git(repo, ["worktree", "prune"]);
    const listed = await this.listed(repo);
    const root = real(this.o.workspacesRoot) + sep;
    const rows = this.o.db.select().from(worktrees).where(eq(worktrees.projectId, projectId)).all();
    const known = new Set(rows.map((r) => real(r.path)));
    const missing = rows.filter((r) => r.state === "active" && !listed.has(real(r.path))).map((r) => r.path);
    const orphans = [...listed.keys()].filter((p) => p.startsWith(root) && !known.has(p));
    return { missing, orphans };
  }
}
