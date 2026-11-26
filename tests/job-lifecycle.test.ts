import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { archiveJob, deleteJob, enqueue, getJob, JobError } from "../src/core/jobs.js";
import { openDb } from "../src/db/client.js";
import { agentInvocations, decisions, jobs, projects, stageExecutions, worktrees } from "../src/db/schema.js";
import { buildServer } from "../src/server/app.js";
import { WorktreeManager } from "../src/repo/worktrees.js";
import { fixtureConfig } from "./helpers/config.js";
import { makeRepo, sh, tmp } from "./helpers/git-fixture.js";

const TOKEN = "t".repeat(64);
const AUTH = { host: "127.0.0.1:4780", authorization: `Bearer ${TOKEN}` };

function setup() {
  const { db } = openDb(":memory:");
  const dataDir = tmp();
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  db.insert(projects).values({ id: "p", configJson: "{}" }).run();
  const app = buildServer({ db, logger: pino({ level: "silent" }), config: fixtureConfig(), dataDir, port: 4780, controlToken: TOKEN });
  const job = (key: string, status: "done" | "failed" | "running" = "done") => {
    const { job: j } = enqueue(db, { projectId: "p", externalId: key, externalKey: key });
    db.update(jobs).set({ status, stage: status === "done" ? "DONE" : "X" }).where(eq(jobs.id, j.id)).run();
    return j.id;
  };
  const call = (method: "GET" | "POST" | "DELETE", url: string) => app.inject({ method, url, headers: AUTH, remoteAddress: "127.0.0.1" });
  return { db, dataDir, job, call };
}

describe("archive and delete", () => {
  it("archives a finished job, hides it from the default list and restores it", async () => {
    const s = setup();
    const id = s.job("JAM-1");
    s.job("JAM-2");
    expect((await s.call("POST", `/api/jobs/${id}/archive`)).statusCode).toBe(200);
    expect((await s.call("GET", "/api/jobs")).json().jobs.map((j: { key: string }) => j.key)).toEqual(["JAM-2"]);
    expect((await s.call("GET", "/api/jobs?archived=only")).json().jobs.map((j: { key: string }) => j.key)).toEqual(["JAM-1"]);
    expect((await s.call("GET", "/api/jobs?archived=all")).json().total).toBe(2);
    await s.call("POST", `/api/jobs/${id}/unarchive`);
    expect((await s.call("GET", "/api/jobs")).json().total).toBe(2);
  });

  it("refuses to archive or delete a job that is still in flight", async () => {
    const s = setup();
    const id = s.job("JAM-1", "running");
    expect((await s.call("POST", `/api/jobs/${id}/archive`)).statusCode).toBe(409);
    expect((await s.call("DELETE", `/api/jobs/${id}`)).statusCode).toBe(409);
    expect(getJob(s.db, id)).toBeDefined();
  });

  it("deletes a finished job with its history and agent log, and nothing else", async () => {
    const s = setup();
    const id = s.job("JAM-1"), other = s.job("JAM-2");
    const log = join(s.dataDir, "logs", "a.log");
    writeFileSync(log, "x");
    s.db.insert(agentInvocations).values({ jobId: id, agent: "claude/impl", logPath: log }).run();
    s.db.insert(stageExecutions).values({ jobId: id, stage: "X", attempt: 1, outcome: "succeeded", idempotencyKey: "k1" }).run();
    s.db.insert(decisions).values({ jobId: id, kind: "k", decision: "d", actor: "a" }).run();
    expect((await s.call("DELETE", `/api/jobs/${id}`)).statusCode).toBe(200);
    expect(getJob(s.db, id)).toBeUndefined();
    expect(getJob(s.db, other)).toBeDefined();
    expect(s.db.select().from(agentInvocations).all()).toHaveLength(0);
    expect(existsSync(log)).toBe(false);
    expect((await s.call("DELETE", `/api/jobs/${id}`)).statusCode).toBe(409); // already gone
  });

  it("will not delete a job whose worktree is still on disk", () => {
    const s = setup();
    const id = s.job("JAM-1");
    s.db.insert(worktrees).values({ jobId: id, projectId: "p", path: "/tmp/wt-x", branch: "factory/JAM-1", state: "preserved" }).run();
    expect(() => deleteJob(s.db, id)).toThrow(JobError);
    expect(archiveJob(s.db, id, "t").archivedAt).not.toBeNull(); // archiving is still allowed
    s.db.update(worktrees).set({ state: "removed" }).where(eq(worktrees.jobId, id)).run();
    deleteJob(s.db, id);
    expect(getJob(s.db, id)).toBeUndefined();
  });

  it("pages and filters the list", async () => {
    const s = setup();
    for (let i = 1; i <= 7; i++) s.job(`JAM-${i}`, i % 2 ? "done" : "failed");
    const p1 = (await s.call("GET", "/api/jobs?pageSize=3&page=1")).json();
    expect(p1).toMatchObject({ total: 7, pages: 3, page: 1 });
    expect(p1.jobs).toHaveLength(3);
    expect((await s.call("GET", "/api/jobs?pageSize=3&page=9")).json().page).toBe(3); // clamped
    expect((await s.call("GET", "/api/jobs?status=failed")).json().total).toBe(3);
    expect((await s.call("GET", "/api/jobs?q=jam-5")).json().jobs.map((j: { key: string }) => j.key)).toEqual(["JAM-5"]);
    expect((await s.call("GET", "/api/jobs?q=%25")).json().total).toBe(0); // % is literal, not a wildcard
  });
});

describe("deleting a job together with its worktree", () => {
  function withWorktree() {
    const { db } = openDb(":memory:");
    const dataDir = tmp();
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    const fx = makeRepo();
    const mgr = new WorktreeManager({ db, logger: pino({ level: "silent" }), workspacesRoot: fx.workspaces, repoPath: () => fx.repo, defaultBranch: () => "main" });
    const app = buildServer({ db, logger: pino({ level: "silent" }), config: fixtureConfig(), dataDir, worktrees: mgr, port: 4780, controlToken: TOKEN });
    const call = (url: string) => app.inject({ method: "DELETE", url, headers: AUTH, remoteAddress: "127.0.0.1" });
    const mk = async (status: "failed" | "running" = "failed") => {
      const { job } = enqueue(db, { projectId: "p", externalId: "JAM-9", externalKey: "JAM-9" });
      db.update(jobs).set({ status, stage: status === "failed" ? "FAILED" : "IMPLEMENTATION" }).where(eq(jobs.id, job.id)).run();
      return { id: job.id, info: await mgr.create({ id: job.id, projectId: "p", externalKey: "JAM-9" }) };
    };
    return { db, fx, call, mk };
  }

  it("still refuses a plain delete while the worktree exists", async () => {
    const s = withWorktree();
    const { id, info } = await s.mk();
    const r = await s.call(`/api/jobs/${id}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/worktree .* still exists/);
    expect(existsSync(info.path)).toBe(true);
  });

  it("removes the worktree and the job when asked", async () => {
    const s = withWorktree();
    const { id, info } = await s.mk();
    const r = await s.call(`/api/jobs/${id}?removeWorktree=1`);
    expect(r.statusCode).toBe(200);
    expect(existsSync(info.path)).toBe(false);
    expect(getJob(s.db, id)).toBeUndefined();
    expect(sh(s.fx.repo, "branch", "--list", "factory/JAM-9")).toBe(""); // nothing on it, so git agrees it is merged
  });

  it("keeps an unmerged local branch unless the change is discarded, and a pushed one (PR raised) goes", async () => {
    const s = withWorktree();
    const { id, info } = await s.mk();
    writeFileSync(join(info.path, "f.txt"), "f");
    sh(info.path, "add", "-A"); sh(info.path, "commit", "-q", "-m", "work");
    expect((await s.call(`/api/jobs/${id}?removeWorktree=1`)).statusCode).toBe(200);
    expect(sh(s.fx.repo, "branch", "--list", "factory/JAM-9")).toContain("factory/JAM-9"); // unmerged and never pushed: kept
  });

  it("asks before throwing away uncommitted changes, then discards them when told to", async () => {
    const s = withWorktree();
    const { id, info } = await s.mk();
    writeFileSync(join(info.path, "precious.txt"), "x");
    const first = await s.call(`/api/jobs/${id}?removeWorktree=1`);
    expect(first.statusCode).toBe(409);
    expect(first.json().code).toBe("worktree-dirty");
    expect(existsSync(join(info.path, "precious.txt"))).toBe(true);
    expect(getJob(s.db, id)).toBeDefined();
    const second = await s.call(`/api/jobs/${id}?removeWorktree=1&discardChanges=1`);
    expect(second.statusCode).toBe(200);
    expect(existsSync(info.path)).toBe(false);
    expect(getJob(s.db, id)).toBeUndefined();
  });

  it("never touches the worktree of a job that is still running", async () => {
    const s = withWorktree();
    const { id, info } = await s.mk("running");
    const r = await s.call(`/api/jobs/${id}?removeWorktree=1`);
    expect(r.statusCode).toBe(409);
    expect(existsSync(info.path)).toBe(true);
  });
});
