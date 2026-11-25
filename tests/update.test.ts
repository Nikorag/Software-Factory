import { writeFileSync } from "node:fs";
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
  return { repo, publish };
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
  it("reinstalls dependencies and rebuilds after moving, in that order", async () => {
    const { repo, publish } = world();
    publish("b.txt", "v1.1.0");
    const calls: string[] = [];
    const run = async (f: string, a: string[], cwd: string) => { if (f === "pnpm") { calls.push(a.join(" ")); return ""; } return (await import("node:child_process")).execFileSync(f, a, { cwd, encoding: "utf8" }).trim(); };
    await applyUpdate(await planUpdate({ root: repo, run }), { root: repo, run });
    expect(calls).toEqual(["install --frozen-lockfile --silent", "web:build"]);
  });
});
