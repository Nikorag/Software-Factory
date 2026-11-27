import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { carryRepoFiles, mergeRepoFile, parseRepoFile, readRepoFileText, refreshRepoFile } from "../src/config/repo-file.js";
import { ConfigError } from "../src/config/load.js";
import { ProjectConfig } from "../src/config/schema.js";
import { checkProject } from "../src/repo/check.js";
import { onboardingOf } from "../src/repo/readiness.js";
import { GitError, type GitFn } from "../src/repo/git.js";
import { makeRepo, sh } from "./helpers/git-fixture.js";

const FILE = `id: p
name: From Repo
github: { account: me, repo: me/thing }
commands:
  install: pnpm install --frozen-lockfile
  test: pnpm test
allowLoopback: true
`;
const project = (over: Record<string, unknown> = {}) => ProjectConfig.parse({ id: "p", name: "P", repository: "/x", ...over });

describe("parseRepoFile", () => {
  it("accepts a root mapping and a one-element list", () => {
    expect(parseRepoFile(FILE, "p")).toMatchObject({ id: "p", allowLoopback: true, commands: { test: "pnpm test" } });
    const list = `- id: p\n  commands: { test: pnpm test }\n`;
    expect(parseRepoFile(list, "p").commands?.test).toBe("pnpm test");
  });
  it("rejects unknown keys and typos, naming the path", () => {
    expect(() => parseRepoFile("id: p\ncommands: { tset: x }\n", "p")).toThrow(/commands/);
    expect(() => parseRepoFile("id: p\nbogus: 1\n", "p")).toThrow(/bogus|Unrecognized/);
    expect(() => parseRepoFile("id: p\ngithub: { repo: nope }\n", "p")).toThrow(/github\.repo/);
  });
  it("rejects an id that differs from the project's", () => {
    expect(() => parseRepoFile("id: other\n", "p")).toThrow(/does not match/);
  });
  it("rejects secret-looking keys, bad YAML and a multi-project list", () => {
    expect(() => parseRepoFile("id: p\napiKey: abc\n", "p")).toThrow(/looks like a secret/);
    expect(() => parseRepoFile("id: p\ncommands: { token: abc }\n", "p")).toThrow(ConfigError);
    expect(() => parseRepoFile("id: [", "p")).toThrow(/not valid YAML/);
    expect(() => parseRepoFile("- id: p\n- id: q\n", "p")).toThrow(/one project/);
  });
});

describe("mergeRepoFile (precedence)", () => {
  it("overrides only the fields the file sets", () => {
    const base = project({ commands: { test: "yaml test", lint: "yaml lint" }, github: { account: "yaml-acct", repo: "a/b" }, defaultBranch: "trunk" });
    const m = mergeRepoFile(base, parseRepoFile("id: p\ncommands: { test: repo test, build: repo build }\ngithub: { repo: c/d }\n", "p"));
    expect(m.commands).toEqual({ test: "repo test", lint: "yaml lint", build: "repo build" });
    expect(m.github).toEqual({ account: "yaml-acct", repo: "c/d" });
    expect(m.defaultBranch).toBe("trunk");
    expect(m.name).toBe("P");
    expect(m.allowLoopback).toBe(false);
  });
});

describe("readRepoFileText / refreshRepoFile (real git)", () => {
  it("applies the file committed on the default branch", async () => {
    const { repo } = makeRepo({ "README.md": "hi\n", ".software-factory.yml": FILE });
    const p = project({ repository: repo, commands: { lint: "yaml lint" } });
    expect(await refreshRepoFile(p)).toEqual({ status: "applied" });
    expect(p).toMatchObject({ name: "From Repo", allowLoopback: true, github: { account: "me", repo: "me/thing" }, commands: { install: "pnpm install --frozen-lockfile", test: "pnpm test", lint: "yaml lint" } });
    expect(p.repoFileError).toBeUndefined();
  });

  it("ignores a modified or untracked working-copy file", async () => {
    const { repo } = makeRepo({ "README.md": "hi\n", ".software-factory.yml": FILE });
    writeFileSync(join(repo, ".software-factory.yml"), "id: p\ncommands: { test: evil }\n"); // uncommitted edit
    expect((await readRepoFileText(project({ repository: repo })))).toBe(FILE.trimEnd());
    const p = project({ repository: repo });
    await refreshRepoFile(p);
    expect(p.commands.test).toBe("pnpm test");

    const bare = makeRepo();
    writeFileSync(join(bare.repo, ".software-factory.yml"), FILE); // untracked
    expect(await readRepoFileText(project({ repository: bare.repo }))).toBeNull();
  });

  it("falls back to the local default branch when there is no origin", async () => {
    const { repo } = makeRepo({ "README.md": "hi\n", ".software-factory.yml": FILE });
    sh(repo, "remote", "remove", "origin");
    expect(await readRepoFileText(project({ repository: repo }))).toBe(FILE.trimEnd());
  });

  it("a missing file is a no-op with no error", async () => {
    const { repo } = makeRepo();
    const p = project({ repository: repo, commands: { test: "yaml test" } });
    expect(await refreshRepoFile(p)).toEqual({ status: "none" });
    expect(p.commands).toEqual({ test: "yaml test" });
    expect(p.repoFileError).toBeUndefined();
  });

  it("a missing repository or branch is a no-op, never a crash", async () => {
    const p = project({ repository: "/definitely/not/here" });
    expect(await refreshRepoFile(p)).toEqual({ status: "none" });
  });

  it("an invalid file applies nothing, keeps the previous settings and shows the error on the project", async () => {
    const good = makeRepo({ "README.md": "hi\n", ".software-factory.yml": FILE });
    const p = project({ repository: good.repo });
    await refreshRepoFile(p);
    // a bad commit replaces the good file
    writeFileSync(join(good.repo, ".software-factory.yml"), "id: p\nallowLoopback: false\ncommands: { tset: x }\n");
    sh(good.repo, "commit", "-qam", "typo"); sh(good.repo, "push", "-q");
    const r = await refreshRepoFile(p);
    expect(r.status).toBe("error");
    expect(p.repoFileError).toMatch(/commands/);
    expect(p).toMatchObject({ allowLoopback: true, commands: { test: "pnpm test" } }); // last good values stay; the bad file's allowLoopback:false is not applied
    expect(onboardingOf(p, null, null).steps.find((s) => s.id === "repo-file")).toMatchObject({ ok: false });

    const mismatch = makeRepo({ "README.md": "hi\n", ".software-factory.yml": "id: other\ncommands: { test: x }\n" });
    const q = project({ repository: mismatch.repo, commands: { test: "yaml test" } });
    expect((await refreshRepoFile(q)).status).toBe("error");
    expect(q.commands.test).toBe("yaml test");
  });

  it("a fixed file clears the error, and a removed field falls back to projects.yaml", async () => {
    const { repo } = makeRepo({ "README.md": "hi\n", ".software-factory.yml": "id: p\ncommands: { test: repo test }\n" });
    const p = project({ repository: repo, commands: { lint: "yaml lint" } });
    await refreshRepoFile(p);
    writeFileSync(join(repo, ".software-factory.yml"), "id: p\ncommands: { lint: repo lint }\n");
    sh(repo, "commit", "-qam", "edit"); sh(repo, "push", "-q");
    await refreshRepoFile(p);
    expect(p.commands).toEqual({ lint: "repo lint" });
  });

  it("a defaultBranch set by the file does not change where the file is read from", async () => {
    const { repo } = makeRepo({ "README.md": "hi\n", ".software-factory.yml": "id: p\ndefaultBranch: trunk\ncommands: { test: pnpm test }\n" });
    const p = project({ repository: repo });
    for (let i = 0; i < 3; i++) {
      expect(await refreshRepoFile(p)).toEqual({ status: "applied" });
      expect(p.defaultBranch).toBe("trunk");
      expect(p.commands.test).toBe("pnpm test");
    }
  });

  it("keeps the applied settings when the file later disappears", async () => {
    const { repo } = makeRepo({ "README.md": "hi\n", ".software-factory.yml": FILE });
    const p = project({ repository: repo });
    await refreshRepoFile(p);
    sh(repo, "rm", "-q", ".software-factory.yml"); sh(repo, "commit", "-qm", "rm"); sh(repo, "push", "-q");
    expect(await refreshRepoFile(p)).toEqual({ status: "none" });
    expect(p.commands.test).toBe("pnpm test");
    expect(p.repoFileError).toBeUndefined();
  });

  it("a git failure keeps the previous settings and reports an error, instead of reading as 'no file'", async () => {
    const { repo } = makeRepo({ "README.md": "hi\n", ".software-factory.yml": FILE });
    const p = project({ repository: repo });
    await refreshRepoFile(p);
    const broken: GitFn = async () => { throw new GitError("git failed: index.lock", [], "", 128); };
    const r = await refreshRepoFile(p, broken);
    expect(r.status).toBe("error");
    expect(p.commands.test).toBe("pnpm test");
    expect(p.allowLoopback).toBe(true);
    expect(p.repoFileError).toMatch(/could not be read/);
  });

  it("rejects a defaultBranch that could be read as a git option", () => {
    for (const b of ["-D", "--upload-pack=x", "a..b", "x.lock", "a b"]) expect(() => parseRepoFile(`id: p\ndefaultBranch: "${b}"\n`, "p")).toThrow(/defaultBranch/);
    expect(parseRepoFile("id: p\ndefaultBranch: release/1.x\n", "p").defaultBranch).toBe("release/1.x");
  });

  it("keeps winning after projects.yaml is re-read (settings save)", async () => {
    const { repo } = makeRepo({ "README.md": "hi\n", ".software-factory.yml": FILE });
    const old = project({ repository: repo });
    await refreshRepoFile(old);
    const fresh = project({ repository: repo, commands: { test: "saved in settings", lint: "saved lint" } });
    carryRepoFiles([old], [fresh]);
    expect(fresh.commands).toMatchObject({ test: "pnpm test", lint: "saved lint" });
    expect(fresh.allowLoopback).toBe(true);
  });
});

describe("checkProject with a file that moves the default branch", () => {
  it("fetches the new branch and builds the worktree from origin/<it>", async () => {
    const { repo, base } = makeRepo({ "README.md": "hi\n", ".software-factory.yml": "id: p\ndefaultBranch: trunk\n" });
    sh(repo, "push", "-q", "origin", "HEAD:refs/heads/trunk");
    sh(repo, "update-ref", "-d", "refs/remotes/origin/trunk"); // trunk exists only on origin until fetched
    const p = project({ repository: repo });
    const report = await checkProject(p, { dataDir: join(base, "data"), sandbox: { required: false }, timeoutMs: 10_000, skipInstall: true });
    expect(report.baseRef).toBe("origin/trunk");
    expect(p.defaultBranch).toBe("trunk");
  });
});
