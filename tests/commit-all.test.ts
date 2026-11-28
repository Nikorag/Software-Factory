import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitAll } from "../src/speckit/tools.js";
import { git } from "../src/repo/git.js";
import { makeRepo, sh } from "./helpers/git-fixture.js";

const put = (repo: string, f: string, c = "x\n") => { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), c); };

describe("commitAll (found live: it failed every implementation attempt once node_modules existed)", () => {
  it("commits real changes when node_modules exists and IS gitignored", async () => {
    const { repo } = makeRepo({ ".gitignore": "node_modules/\n", "README.md": "hi\n" });
    put(repo, "node_modules/dep/index.js"); put(repo, "src/new.ts");
    expect(await commitAll(repo, "impl", git)).toBe(true);
    expect(sh(repo, "show", "--name-only", "--format=", "HEAD")).toBe("src/new.ts");
  });
  it("never commits dependency output even when the repo forgot to gitignore it (including nested and .DS_Store)", async () => {
    const { repo } = makeRepo();
    put(repo, "node_modules/dep/index.js"); put(repo, "packages/a/node_modules/x.js"); put(repo, ".pnpm-store/v3/f"); put(repo, "docs/.DS_Store"); put(repo, "src/keep.ts");
    expect(await commitAll(repo, "impl", git)).toBe(true);
    expect(sh(repo, "show", "--name-only", "--format=", "HEAD")).toBe("src/keep.ts");
  });
  it("never commits Playwright's default output (screenshots, traces, reports), even nested", async () => {
    const { repo } = makeRepo();
    put(repo, "test-results/a/trace.zip"); put(repo, "playwright-report/index.html"); put(repo, "blob-report/r.zip"); put(repo, "playwright/.cache/x"); put(repo, "web/test-results/s.png"); put(repo, "playwright/tests/a.spec.ts"); put(repo, "src/keep.ts");
    expect(await commitAll(repo, "impl", git)).toBe(true);
    expect(sh(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["playwright/tests/a.spec.ts", "src/keep.ts"]);
  });
  it("returns false when only ignorable output changed", async () => {
    const { repo } = makeRepo();
    put(repo, "node_modules/dep/index.js");
    expect(await commitAll(repo, "impl", git)).toBe(false);
  });
});
