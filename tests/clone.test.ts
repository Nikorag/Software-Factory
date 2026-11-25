import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectConfig } from "../src/config/schema.js";
import { ensureClone } from "../src/repo/clone.js";
import { gitAuthEnv } from "../src/repo/gh.js";
import { GitError, type GitFn } from "../src/repo/git.js";
import { makeRepo, sh, tmp } from "./helpers/git-fixture.js";

const managed = (path: string, over: Record<string, unknown> = {}) =>
  ProjectConfig.parse({ id: "p", name: "P", repository: path, managed: true, github: { repo: "Nikorag/Thing", account: "Nikorag" }, ...over });

describe("ensureClone", () => {
  it("clones a missing managed repo into place", async () => {
    const { origin } = makeRepo();
    const dest = join(tmp(), "projects", "p");
    const r = await ensureClone(managed(dest), { remoteUrl: origin, authEnv: null });
    expect(r).toEqual({ status: "cloned", path: dest });
    expect(existsSync(join(dest, "README.md"))).toBe(true);
    expect(sh(dest, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
  it("is a no-op when already cloned from the right repository", async () => {
    const { origin } = makeRepo();
    const dest = join(tmp(), "p");
    await ensureClone(managed(dest), { remoteUrl: origin, authEnv: null });
    sh(dest, "remote", "set-url", "origin", "git@github.com-Nikorag:Nikorag/Thing.git");
    expect(await ensureClone(managed(dest), { remoteUrl: origin, authEnv: null })).toEqual({ status: "present", path: dest });
  });
  it("refuses a directory that is a different repository, and a non-empty non-repo", async () => {
    const other = makeRepo();
    sh(other.repo, "remote", "set-url", "origin", "git@github.com:someone/else.git");
    expect(await ensureClone(managed(other.repo), { authEnv: null })).toMatchObject({ status: "error", error: expect.stringContaining("refusing to touch") });
    const junk = join(tmp(), "junk"); mkdirSync(junk); writeFileSync(join(junk, "f"), "x");
    expect(await ensureClone(managed(junk), { authEnv: null })).toMatchObject({ status: "error" });
    expect(existsSync(join(junk, "f"))).toBe(true);
  });
  it("skips projects that use an existing checkout", async () => {
    expect((await ensureClone(managed("/x", { managed: false }))).status).toBe("skipped");
  });
  it("redacts auth headers from clone errors", async () => {
    const leaky: GitFn = async () => { throw new GitError("git clone failed: AUTHORIZATION: basic c2VjcmV0dG9rZW4=", []); };
    const r = await ensureClone(managed(join(tmp(), "z")), { git: leaky, authEnv: null });
    expect(JSON.stringify(r)).not.toContain("c2VjcmV0dG9rZW4=");
  });
});

describe("gitAuthEnv", () => {
  it("builds a per-process https auth header without exposing the token in plain text", async () => {
    const env = await gitAuthEnv("Nikorag", async () => "ghp_TOKEN");
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader" });
    expect(env!.GIT_CONFIG_VALUE_1).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:ghp_TOKEN").toString("base64")}`);
    expect(env!.GIT_CONFIG_VALUE_0).toBe(""); // other credential helpers disabled
  });
  it("returns nothing without an account", async () => { expect(await gitAuthEnv(undefined)).toBeUndefined(); });
});
