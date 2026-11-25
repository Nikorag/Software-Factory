import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, type DbHandle } from "../src/db/client.js";
import { jobs, projects, worktrees } from "../src/db/schema.js";
import { WorktreeError, WorktreeManager } from "../src/repo/worktrees.js";
import { prepareWorkspace } from "../src/repo/handlers.js";
import { getProjectConfig, isRunnable, syncProjects, validateProjects } from "../src/repo/registry.js";
import { ProjectConfig } from "../src/config/schema.js";
import { makeRepo, sh } from "./helpers/git-fixture.js";

let h: DbHandle;
let fx: ReturnType<typeof makeRepo>;
let wt: WorktreeManager;

const mkJob = (id: string, key: string, ext = key) => {
  h.db.insert(jobs).values({ id, projectId: "p", externalId: ext, externalKey: key, status: id.endsWith("done") ? "done" : "queued" }).run();
  return { id, projectId: "p", externalKey: key };
};

beforeEach(() => {
  h = openDb(":memory:");
  fx = makeRepo();
  h.db.insert(projects).values({ id: "p", configJson: "{}" }).run();
  wt = new WorktreeManager({ db: h.db, logger: pino({ level: "silent" }), workspacesRoot: fx.workspaces, repoPath: () => fx.repo, defaultBranch: () => "main" });
});

describe("WorktreeManager.create", () => {
  it("creates an isolated worktree on factory/<KEY> from the default branch, leaving the original checkout untouched", async () => {
    const headBefore = sh(fx.repo, "rev-parse", "HEAD");
    const info = await wt.create(mkJob("j1", "ENG-1"));
    expect(info).toMatchObject({ branch: "factory/ENG-1", path: join(fx.workspaces, "p", "ENG-1"), resumed: false });
    expect(sh(info.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("factory/ENG-1");
    expect(sh(info.path, "status", "--porcelain")).toBe("");
    expect(sh(fx.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(sh(fx.repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(sh(fx.repo, "status", "--porcelain")).toBe("");
    expect(h.db.select().from(worktrees).get()).toMatchObject({ jobId: "j1", state: "active" });
  });
  it("is idempotent: a second call resumes instead of recreating, preserving uncommitted work", async () => {
    const job = mkJob("j1", "ENG-1");
    const a = await wt.create(job);
    writeFileSync(join(a.path, "wip.txt"), "work in progress");
    const b = await wt.create(job);
    expect(b.resumed).toBe(true);
    expect(existsSync(join(a.path, "wip.txt"))).toBe(true);
  });
  it("rejects unsafe identifiers (path traversal, option injection)", async () => {
    for (const key of ["../evil", "a/b", "-rf", "", "a b"]) {
      await expect(wt.create({ id: "jx", projectId: "p", externalKey: key })).rejects.toMatchObject({ code: "invalid-key" });
    }
    expect(existsSync(join(fx.base, "evil"))).toBe(false);
  });
  it("prevents two jobs from sharing a worktree, even when racing", async () => {
    const a = mkJob("j1", "ENG-1", "lin-1");
    h.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, "j1")).run();
    const b = mkJob("j2", "ENG-1", "lin-1");
    const results = await Promise.allSettled([wt.create(a), wt.create(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(WorktreeError);
    expect(rejected.reason.code).toBe("owned");
  });
  it("keeps projects separate: same issue key in two projects gets distinct paths", async () => {
    h.db.insert(projects).values({ id: "q", configJson: "{}" }).run();
    const second = makeRepo();
    const mgr = new WorktreeManager({ db: h.db, logger: pino({ level: "silent" }), workspacesRoot: fx.workspaces, repoPath: (id) => (id === "q" ? second.repo : fx.repo), defaultBranch: () => "main" });
    h.db.insert(jobs).values({ id: "jq", projectId: "q", externalId: "e", externalKey: "ENG-1" }).run();
    const [a, b] = [await mgr.create(mkJob("j1", "ENG-1")), await mgr.create({ id: "jq", projectId: "q", externalKey: "ENG-1" })];
    expect(a.path).not.toBe(b.path);
  });
  it("recovers when the directory vanished after the DB row was written (crash mid-create)", async () => {
    const job = mkJob("j1", "ENG-1");
    const a = await wt.create(job);
    rmSync(a.path, { recursive: true, force: true });
    const b = await wt.create(job);
    expect(b.resumed).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    expect(h.db.select().from(worktrees).all()).toHaveLength(1);
  });
  it("reuses a leftover branch instead of failing or resetting it", async () => {
    sh(fx.repo, "branch", "factory/ENG-1");
    const info = await wt.create(mkJob("j1", "ENG-1"));
    expect(sh(info.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("factory/ENG-1");
  });
  it("refuses to adopt a pre-existing non-worktree directory", async () => {
    mkdirSync(join(fx.workspaces, "p", "ENG-1"), { recursive: true });
    await expect(wt.create(mkJob("j1", "ENG-1"))).rejects.toMatchObject({ code: "owned" });
    expect(h.db.select().from(worktrees).all()).toHaveLength(0); // no dangling row
  });
  it("initialises submodules", async () => {
    const sub = makeRepo({ "lib.txt": "lib" });
    sh(fx.repo, "submodule", "add", "-q", sub.origin, "vendor/lib");
    sh(fx.repo, "commit", "-q", "-m", "add submodule");
    sh(fx.repo, "push", "-q");
    const info = await wt.create(mkJob("j1", "ENG-1"));
    expect(existsSync(join(info.path, "vendor", "lib", "lib.txt"))).toBe(true);
  });
  it("branches from origin's latest default branch, not a stale local one", async () => {
    const other = join(fx.base, "other");
    sh(fx.base, "clone", "-q", fx.origin, other);
    writeFileSync(join(other, "new.txt"), "n");
    sh(other, "add", "-A"); sh(other, "commit", "-q", "-m", "upstream"); sh(other, "push", "-q");
    const info = await wt.create(mkJob("j1", "ENG-1"));
    expect(existsSync(join(info.path, "new.txt"))).toBe(true);
  });
});

describe("cleanup", () => {
  it("removes a clean worktree and its merged branch", async () => {
    const info = await wt.create(mkJob("j1", "ENG-1"));
    await wt.remove("j1");
    expect(existsSync(info.path)).toBe(false);
    expect(sh(fx.repo, "branch", "--list", "factory/ENG-1")).toBe("");
    expect(h.db.select().from(worktrees).get()?.state).toBe("removed");
  });
  it("refuses to delete a dirty worktree and preserves it", async () => {
    const info = await wt.create(mkJob("j1", "ENG-1"));
    writeFileSync(join(info.path, "precious.txt"), "x");
    await expect(wt.remove("j1")).rejects.toMatchObject({ code: "dirty" });
    expect(existsSync(join(info.path, "precious.txt"))).toBe(true);
    expect(h.db.select().from(worktrees).get()?.state).toBe("preserved");
  });
  it("keeps an unmerged branch on safe delete but removes it on forced delete", async () => {
    const info = await wt.create(mkJob("j1", "ENG-1"));
    writeFileSync(join(info.path, "f.txt"), "f");
    sh(info.path, "add", "-A"); sh(info.path, "commit", "-q", "-m", "work");
    await wt.remove("j1");
    expect(sh(fx.repo, "branch", "--list", "factory/ENG-1")).toContain("factory/ENG-1");
    expect(existsSync(info.path)).toBe(false);
    h.db.update(worktrees).set({ state: "active" }).run();
    await wt.remove("j1", { deleteBranch: "force" });
    expect(sh(fx.repo, "branch", "--list", "factory/ENG-1")).toBe("");
  });
  it("preserved worktrees block reuse and are never recreated", async () => {
    const job = mkJob("j1", "ENG-1");
    await wt.create(job);
    wt.preserve("j1", "job failed");
    await expect(wt.create(job)).rejects.toMatchObject({ code: "owned" });
  });
  it("allows a later job for the same issue once the earlier worktree was removed", async () => {
    await wt.create(mkJob("j1done", "ENG-1", "lin-1"));
    await wt.remove("j1done");
    const info = await wt.create(mkJob("j2", "ENG-1", "lin-1"));
    expect(existsSync(info.path)).toBe(true);
  });
  it("never deletes the default branch", async () => {
    h.db.insert(jobs).values({ id: "x", projectId: "p", externalId: "z", externalKey: "Z" }).run();
    h.db.insert(worktrees).values({ jobId: "x", projectId: "p", path: join(fx.workspaces, "p", "main-wt"), branch: "main", state: "active" }).run();
    await wt.remove("x");
    expect(sh(fx.repo, "branch", "--list", "main")).toContain("main");
  });
});

describe("reconcile", () => {
  it("reports missing and orphaned worktrees without destroying anything", async () => {
    const a = await wt.create(mkJob("j1", "ENG-1"));
    const b = await wt.create(mkJob("j2", "ENG-2"));
    h.db.delete(worktrees).where(eq(worktrees.jobId, "j2")).run(); // j2's row lost -> orphan on disk
    rmSync(a.path, { recursive: true, force: true }); // j1's directory lost -> missing
    const r = await wt.reconcile("p");
    expect(r.missing).toEqual([a.path]);
    expect(r.orphans).toEqual([b.path]);
    expect(existsSync(b.path)).toBe(true);
  });
});

describe("prepareWorkspace handler", () => {
  const ctx = (job: ReturnType<typeof mkJob>) => ({ job: job as never, attempt: 1, executionId: 0, signal: new AbortController().signal, dryRun: false, logger: pino({ level: "silent" }) });
  it("returns ok with path/branch, and blocks (not retries) on ownership conflicts", async () => {
    const job = mkJob("j1", "ENG-1", "lin-1");
    const handler = prepareWorkspace(wt);
    expect(await handler(ctx(job))).toMatchObject({ kind: "ok", output: { branch: "factory/ENG-1" } });
    h.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, "j1")).run();
    const other = mkJob("j2", "ENG-1", "lin-1");
    expect(await handler(ctx(other))).toMatchObject({ kind: "blocked" });
  });
});

// Repo is visible (200) but the default branch has no protection (404).
const unprotectedGh = async (path: string) => (/\/branches\//.test(path) ? { status: 404, body: {} } : { status: 200, body: {} });

describe("registry", () => {
  const cfg = (repo: string, over: Record<string, unknown> = {}) => ProjectConfig.parse({ id: "p", name: "P", repository: repo, ...over });
  it("syncs project config idempotently and updates changes", () => {
    const db = openDb(":memory:").db;
    syncProjects(db, [cfg("/a")]); syncProjects(db, [cfg("/b")]);
    expect(getProjectConfig(db, "p")?.repository).toBe("/b");
  });
  it("only marks projects runnable after a passing validation", async () => {
    const db = openDb(":memory:").db;
    const m = makeRepo(); sh(m.repo, "remote", "set-url", "origin", "git@github.com:a/b.git");
    syncProjects(db, [cfg(m.repo)]);
    expect(isRunnable(db, "p")).toBe(false); // never validated
    await validateProjects(db, [cfg(m.repo)], { gh: unprotectedGh });
    expect(isRunnable(db, "p")).toBe(true);
    const bad = cfg(m.repo, { autonomy: "full" });
    syncProjects(db, [bad]);
    await validateProjects(db, [bad], { gh: unprotectedGh });
    expect(isRunnable(db, "p")).toBe(false); // full autonomy, no branch protection
  });
  it("skips disabled projects", async () => {
    const db = openDb(":memory:").db;
    expect(await validateProjects(db, [cfg("/x", { enabled: false })])).toEqual([]);
  });
});
