import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyUpdate, planUpdate } from "../src/service/update.js";
import { makeRepo, sh, tmp } from "./helpers/git-fixture.js";

/** `repo` is the installed copy; `publish` makes a new commit in origin (optionally tagged), as a maintainer would. */
function world() {
  const { origin, repo } = makeRepo({ "a.txt": "1\n" });
  sh(repo, "tag", "v1.0.0"); sh(repo, "push", "-q", "origin", "v1.0.0");
  const other = join(tmp(), "other");
  sh(tmp(), "clone", "-q", origin, other);
  const publish = (file: string, tag?: string) => {
    writeFileSync(join(other, file), "x\n"); sh(other, "add", "-A"); sh(other, "commit", "-q", "-m", `add ${file}`); sh(other, "push", "-q", "origin", "main");
    if (tag) { sh(other, "tag", tag); sh(other, "push", "-q", "origin", tag); }
  };
  return { repo, publish, origin };
}

describe("update", () => {
  it("reports up to date when nothing newer is released", async () => {
    const { repo } = world();
    expect((await planUpdate({ root: repo })).upToDate).toBe(true);
  });
  it("follows the newest release tag, not the tip of main", async () => {
    const { repo, publish } = world();
    publish("b.txt", "v1.1.0"); publish("wip.txt"); // main is now ahead of the release
    const plan = await planUpdate({ root: repo });
    expect(plan).toMatchObject({ target: "v1.1.0", targetIsTag: true, upToDate: false, latestTag: "v1.1.0", dirty: false });
    await applyUpdate(plan, { root: repo, skipBuild: true });
    expect(sh(repo, "describe", "--tags", "--exact-match")).toBe("v1.1.0");
    expect(sh(repo, "ls-files")).toContain("b.txt");
    expect(sh(repo, "ls-files")).not.toContain("wip.txt"); // unreleased work is not installed
    expect((await planUpdate({ root: repo })).upToDate).toBe(true);
  });
  it("can be pointed at a specific tag or at main", async () => {
    const { repo, publish } = world();
    publish("b.txt", "v1.1.0"); publish("c.txt");
    const main = await planUpdate({ root: repo, ref: "main" });
    expect(main).toMatchObject({ target: "origin/main", targetIsTag: false, behind: 2 });
    await applyUpdate(main, { root: repo, skipBuild: true });
    expect(sh(repo, "ls-files")).toContain("c.txt");
  });
  it("never moves a checkout that is ahead of the newest release backwards", async () => {
    const { repo } = world();
    writeFileSync(join(repo, "mine.txt"), "x\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "mine");
    expect((await planUpdate({ root: repo })).upToDate).toBe(true);
  });
  it("refuses an install with local changes and changes nothing", async () => {
    const { repo, publish } = world();
    publish("b.txt", "v1.1.0");
    writeFileSync(join(repo, "a.txt"), "edited\n");
    const plan = await planUpdate({ root: repo });
    expect(plan.dirty).toBe(true);
    await expect(applyUpdate(plan, { root: repo, skipBuild: true })).rejects.toThrow(/local changes/);
    expect(sh(repo, "rev-parse", "HEAD")).toBe(plan.currentSha);
  });
  it("reinstalls dependencies, checks the native module and rebuilds after moving, in that order", async () => {
    const { repo, publish } = world();
    publish("b.txt", "v1.1.0");
    const { run, calls } = fakeRun(repo);
    await applyUpdate(await planUpdate({ root: repo, run }), { root: repo, run });
    expect(calls).toEqual(["pnpm install --frozen-lockfile --silent", "node probe", "pnpm web:build"]);
    expect(existsSync(marker(repo))).toBe(false);
  });
  it("rebuilds better-sqlite3 when it was built for another Node", async () => {
    const { repo, publish } = world();
    publish("b.txt", "v1.1.0");
    let probes = 0;
    const { run, calls } = fakeRun(repo, { probe: () => { if (probes++ === 0) throw new Error("Command failed\nwas compiled against a different Node.js version using NODE_MODULE_VERSION 127"); } });
    await applyUpdate(await planUpdate({ root: repo, run }), { root: repo, run });
    expect(calls).toEqual(["pnpm install --frozen-lockfile --silent", "node probe", "pnpm rebuild better-sqlite3", "node probe", "pnpm web:build"]);
  });
  it("rolls back to the previous version and reinstalls it when installing the new one fails", async () => {
    const { repo, publish } = world();
    publish("b.txt", "v1.1.0");
    const before = sh(repo, "rev-parse", "HEAD");
    const { run, calls } = fakeRun(repo, { install: () => { if (existsSync(join(repo, "b.txt"))) throw Object.assign(new Error("Command failed: pnpm install"), { stderr: "ERR_PNPM_FETCH_404 nope" }); } });
    await expect(applyUpdate(await planUpdate({ root: repo, run }), { root: repo, run })).rejects.toThrow(/rolled back to .*ERR_PNPM_FETCH_404/);
    expect(sh(repo, "rev-parse", "HEAD")).toBe(before);
    expect(calls.filter((c) => c.startsWith("pnpm install"))).toHaveLength(2); // the new version (failed), then the old one again
    expect(calls.at(-1)).toBe("pnpm web:build");
    const again = await planUpdate({ root: repo });
    expect(again).toMatchObject({ upToDate: false, behind: 1, pending: null }); // the update is still offered: never "up to date" after a failure
  });
  it("rolls a branch install back to where it was", async () => {
    const { repo, publish } = world();
    publish("c.txt");
    const before = sh(repo, "rev-parse", "HEAD");
    const { run } = fakeRun(repo, { install: () => { if (existsSync(join(repo, "c.txt"))) throw new Error("boom"); } });
    await expect(applyUpdate(await planUpdate({ root: repo, run, ref: "main" }), { root: repo, run })).rejects.toThrow(/rolled back/);
    expect(sh(repo, "rev-parse", "main")).toBe(before);
    expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });
  it("leaves a pending marker when even the rollback cannot install, and the next update finishes the job", async () => {
    const { repo, publish } = world();
    publish("b.txt", "v1.1.0");
    const broken = fakeRun(repo, { install: () => { throw new Error("offline"); } });
    await expect(applyUpdate(await planUpdate({ root: repo, run: broken.run }), { root: repo, run: broken.run })).rejects.toThrow(/run `software-factory update` again/i);
    const plan = await planUpdate({ root: repo });
    expect(plan.upToDate).toBe(false);
    expect(plan.pending).toMatchObject({ from: plan.currentSha });
    const ok = fakeRun(repo);
    await applyUpdate(plan, { root: repo, run: ok.run });
    expect(sh(repo, "describe", "--tags", "--exact-match")).toBe("v1.1.0");
    expect((await planUpdate({ root: repo })).upToDate).toBe(true);
  });
  it("finishes an interrupted update (code moved, dependencies not installed) even though there are no new commits", async () => {
    const { repo, publish } = world();
    publish("b.txt", "v1.1.0");
    const from = sh(repo, "rev-parse", "HEAD");
    await applyUpdate(await planUpdate({ root: repo }), { root: repo, skipBuild: true });
    writeFileSync(marker(repo), JSON.stringify({ from, fromBranch: null, to: sh(repo, "rev-parse", "HEAD"), startedAt: 1 })); // as if killed mid-install
    const plan = await planUpdate({ root: repo });
    expect(plan).toMatchObject({ behind: 0, upToDate: false, pending: { from } });
    const { run, calls } = fakeRun(repo);
    await applyUpdate(plan, { root: repo, run });
    expect(calls).toContain("pnpm install --frozen-lockfile --silent");
    expect(sh(repo, "describe", "--tags", "--exact-match")).toBe("v1.1.0");
    expect((await planUpdate({ root: repo })).upToDate).toBe(true);
  });
  it("works on an install cloned from a tag only (no origin/main until it is taught to fetch branches)", async () => {
    const { repo: maintainer, publish, origin } = world();
    void maintainer;
    const installed = join(tmp(), "app");
    sh(tmp(), "-c", "advice.detachedHead=false", "clone", "-q", "--depth", "1", "--branch", "v1.0.0", `file://${origin}`, installed);
    publish("b.txt");
    const plan = await planUpdate({ root: installed, ref: "main" });
    expect(plan).toMatchObject({ target: "origin/main", upToDate: false });
    expect(sh(installed, "config", "--get-all", "remote.origin.fetch")).toContain("+refs/heads/*:refs/remotes/origin/*");
    await applyUpdate(plan, { root: installed, skipBuild: true });
    expect(sh(installed, "ls-files")).toContain("b.txt");
  });
});

const marker = (repo: string) => join(repo, ".git", "factory-update.json");

/** git for real; pnpm and the native-module probe recorded (and optionally failing). */
function fakeRun(repo: string, f: { install?: () => void; probe?: () => void } = {}) {
  const calls: string[] = [];
  const run = async (file: string, a: string[], cwd: string) => {
    if (file === "pnpm") { calls.push(`pnpm ${a.join(" ")}`); if (a[0] === "install") f.install?.(); return ""; }
    if (file === process.execPath) { calls.push("node probe"); f.probe?.(); return ""; }
    return execFileSync(file, a, { cwd: cwd ?? repo, encoding: "utf8" }).trim();
  };
  return { run, calls };
}
