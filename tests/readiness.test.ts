import { mkdirSync, writeFileSync } from "node:fs";
import { join as j } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectConfig } from "../src/config/schema.js";
import { inspectRepository } from "../src/repo/inspect.js";
import { onboardingOf } from "../src/repo/readiness.js";
import type { RepoReport } from "../src/repo/inspect.js";
import { makeRepo, sh, tmp } from "./helpers/git-fixture.js";

const project = (o: object = {}) => ProjectConfig.parse({ id: "p", name: "P", repository: "/x", linear: { teamKey: "ENG" }, commands: { test: "npm test" }, ...o });
const report = (o: Partial<RepoReport> = {}): RepoReport => ({ projectId: "p", path: "/x", ok: true, isGitRepo: true, clean: true, currentBranch: "main", defaultBranch: "main", remote: { url: "u", github: { owner: "me", repo: "p" } }, hasClaudeMd: true, hasSpecKit: true, hasSubmodules: false, buildSystems: [], detectedCommands: {}, ciWorkflows: [], branchProtection: { status: "unknown", reason: "" }, findings: [], ...o });

describe("onboarding status (derived from the repository, never a flag)", () => {
  it("is ready only when every step is true", () => {
    const o = onboardingOf(project(), report(), { ok: true, at: Date.now() });
    expect(o.status).toBe("ready");
    expect(o.steps.every((s) => s.ok)).toBe(true);
  });
  it("tells you the next action for each missing step", () => {
    const o = onboardingOf(project({ commands: {}, linear: undefined }), report({ hasSpecKit: false }), null);
    expect(o.status).toBe("not-started");                                          // only the repository is in place
    expect(onboardingOf(project({ commands: {}, linear: undefined }), report(), null).status).toBe("in-progress"); // Spec Kit too
    const by = Object.fromEntries(o.steps.map((s) => [s.id, s]));
    expect(by.speckit).toMatchObject({ ok: false, detail: "press Onboard Spec Kit" });
    expect(by.test!.detail).toMatch(/will not implement changes/);
    expect(by.linear!.ok).toBe(false);
    expect(by.checks!.detail).toMatch(/Run checks/);
  });
  it("recognises a pushed onboarding branch as 'pull request waiting', and a failed check", () => {
    const o = onboardingOf(project(), report({ hasSpecKit: false, onboardingBranchPushed: true }), { ok: false, at: 1 });
    expect(o.steps.find((s) => s.id === "speckit")!.detail).toMatch(/merge it, then press Validate/);
    expect(o.steps.find((s) => s.id === "checks")!.detail).toMatch(/last run failed/);
  });
  it("is not-started before the project has ever been validated", () => {
    const o = onboardingOf(project({ commands: {}, linear: undefined }), null, null);
    expect(o.status).toBe("not-started");
    expect(o.steps.find((s) => s.id === "repo")!.detail).toMatch(/press Validate/);
  });
});

describe("Spec Kit detection judges origin's default branch, not a stale checkout", () => {
  it("sees Spec Kit that was merged upstream even though the local checkout does not have it yet (the JAM-418 situation)", async () => {
    const { origin, repo } = makeRepo({ "a.txt": "1\n" });
    // someone merges the onboarding PR upstream
    const other = j(tmp(), "other"); sh(tmp(), "clone", "-q", origin, other);
    mkdirSync(j(other, ".specify"), { recursive: true }); writeFileSync(j(other, ".specify", "x"), "x"); sh(other, "add", "-A"); sh(other, "-c", "user.name=t", "-c", "user.email=t@e.com", "commit", "-q", "-m", "speckit"); sh(other, "push", "-q");
    const p = ProjectConfig.parse({ id: "p", name: "P", repository: repo, commands: { test: "t" } });
    expect((await inspectRepository(p, { gh: async () => ({ status: 404, body: {} }) })).hasSpecKit).toBe(false); // not fetched yet: honest
    sh(repo, "fetch", "-q", "origin");                                                                         // what Validate now does for managed clones
    const r = await inspectRepository(p, { gh: async () => ({ status: 404, body: {} }) });
    expect(r.hasSpecKit).toBe(true);
    expect(sh(repo, "status", "--porcelain")).toBe("");                                                        // the checkout was never touched
  });
  it("notices a pushed factory/onboard-speckit branch", async () => {
    const { repo } = makeRepo({ "a.txt": "1\n" });
    sh(repo, "checkout", "-q", "-b", "factory/onboard-speckit"); writeFileSync(j(repo, "b.txt"), "x"); sh(repo, "add", "-A"); sh(repo, "-c", "user.name=t", "-c", "user.email=t@e.com", "commit", "-q", "-m", "x"); sh(repo, "push", "-q", "-u", "origin", "factory/onboard-speckit"); sh(repo, "checkout", "-q", "main");
    const p = ProjectConfig.parse({ id: "p", name: "P", repository: repo, commands: { test: "t" } });
    const r = await inspectRepository(p, { gh: async () => ({ status: 404, body: {} }) });
    expect(r.onboardingBranchPushed).toBe(true);
    expect(r.hasSpecKit).toBe(false);
  });
});
