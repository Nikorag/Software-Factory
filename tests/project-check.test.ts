import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectConfig } from "../src/config/schema.js";
import { sandboxAvailable } from "../src/exec/sandbox.js";
import { checkProject } from "../src/repo/check.js";
import { makeRepo, sh } from "./helpers/git-fixture.js";

const sb = describe.skipIf(!sandboxAvailable());
const proj = (repo: string, commands: Record<string, string>) => ProjectConfig.parse({ id: "p", name: "P", repository: repo, commands });
const dep = (base: string) => ({ dataDir: join(base, "data"), sandbox: { required: true }, timeoutMs: 30_000 });

sb("project:check (real git worktree, real sandbox)", () => {
  it("runs install then the checks in a throwaway worktree, reports pass, and cleans up without touching the repo", async () => {
    const fx = makeRepo({ "package.json": "{}", "hello.txt": "hi" });
    const seen: string[] = [];
    const rep = await checkProject(proj(fx.repo, { install: "echo installing && touch installed.flag", lint: "test -f hello.txt", test: "test -f installed.flag && echo TESTS-PASS" }), { ...dep(fx.base), onResult: (r) => seen.push(r.kind) });
    expect(rep).toMatchObject({ ok: true, missingTest: false, baseRef: "origin/main" });
    expect(seen).toEqual(["install", "lint", "test"]);
    expect(rep.results.every((r) => r.sandboxed)).toBe(true);
    expect(existsSync(rep.worktree)).toBe(false); // removed
    expect(sh(fx.repo, "status", "--porcelain")).toBe("");
    expect(sh(fx.repo, "worktree", "list")).not.toContain("_check");
    expect(sh(fx.repo, "branch", "--list")).not.toContain("check"); // detached: no branch created
  });
  it("runs a configured visual check after test, with the same result shape", async () => {
    const fx = makeRepo();
    const rep = await checkProject(proj(fx.repo, { visual: "echo VISUAL-RAN", test: "true" }), dep(fx.base));
    expect(rep.results.map((r) => r.kind)).toEqual(["test", "visual"]);
    expect(rep.results[1]).toMatchObject({ kind: "visual", ok: true, exitCode: 0, sandboxed: true });
    expect(rep.results[1]!.tail).toContain("VISUAL-RAN");
    const none = await checkProject(proj(fx.repo, { test: "true" }), dep(fx.base));
    expect(none.results.map((r) => r.kind)).toEqual(["test"]);
  });
  it("reports a failing check with its output and is not ok", async () => {
    const fx = makeRepo();
    const rep = await checkProject(proj(fx.repo, { test: "echo 'FAIL: 2 broken' >&2; exit 4" }), dep(fx.base));
    expect(rep.ok).toBe(false);
    expect(rep.results[0]).toMatchObject({ kind: "test", ok: false, exitCode: 4 });
    expect(rep.results[0]!.tail).toContain("FAIL: 2 broken");
  });
  it("stops after a failed install (nothing else can be trusted) and flags a project with no test command", async () => {
    const fx = makeRepo();
    const rep = await checkProject(proj(fx.repo, { install: "exit 1", test: "echo should-not-run" }), dep(fx.base));
    expect(rep.results.map((r) => r.kind)).toEqual(["install"]);
    const none = await checkProject(proj(fx.repo, { lint: "true" }), dep(fx.base));
    expect(none).toMatchObject({ ok: false, missingTest: true });
  });
  it("runs on the default branch, not on whatever the user has checked out, and can be re-run (stale worktree replaced)", async () => {
    const fx = makeRepo({ "a.txt": "main" });
    sh(fx.repo, "checkout", "-q", "-b", "wip"); sh(fx.repo, "commit", "-q", "--allow-empty", "-m", "wip");
    const first = await checkProject(proj(fx.repo, { test: "cat a.txt" }), { ...dep(fx.base), keep: true });
    expect(first.results[0]!.tail).toContain("main");
    expect(existsSync(first.worktree)).toBe(true);
    const second = await checkProject(proj(fx.repo, { test: "cat a.txt" }), dep(fx.base)); // replaces the kept one
    expect(second.ok).toBe(true);
    expect(sh(fx.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("wip"); // the user's checkout never moved
  });
});
