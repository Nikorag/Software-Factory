import { describe, expect, it } from "vitest";
import { assertSafeGitArgs, UnsafeGitOperation } from "../src/repo/git.js";
import { parseRemote } from "../src/repo/inspect.js";

const P = ["main"];
describe("git safety guard", () => {
  it.each([
    [["push", "--force", "origin", "factory/X"]], [["push", "-f", "origin", "factory/X"]],
    [["push", "--force-with-lease", "origin", "factory/X"]], [["push", "origin", "+factory/X"]],
    [["push", "origin", "main"]], [["push", "origin", "HEAD:main"]], [["push", "origin", "HEAD:refs/heads/main"]],
    [["push", "--delete", "origin", "factory/X"]], [["push", "origin"]], [["branch", "-D", "main"]],
  ])("blocks %j", (args) => expect(() => assertSafeGitArgs(args, P)).toThrow(UnsafeGitOperation));
  it.each([
    [["push", "-u", "origin", "factory/ENG-1"]], [["status", "--porcelain"]], [["worktree", "add", "-b", "factory/X", "/p", "origin/main"]],
    [["branch", "-d", "factory/X"]], [["fetch", "--quiet", "origin", "main"]],
  ])("allows %j", (args) => expect(() => assertSafeGitArgs(args, P)).not.toThrow());
});

describe("parseRemote", () => {
  it("parses ssh and https GitHub remotes", () => {
    expect(parseRemote("git@github.com:acme/app.git").github).toEqual({ owner: "acme", repo: "app" });
    expect(parseRemote("https://github.com/acme/app").github).toEqual({ owner: "acme", repo: "app" });
  });
  it("supports SSH host aliases used for multiple GitHub accounts", () => {
    expect(parseRemote("git@github.com-Nikorag:Nikorag/claude-skills.git").github).toEqual({ owner: "Nikorag", repo: "claude-skills" });
  });
  it("strips embedded credentials and ignores non-GitHub hosts", () => {
    const r = parseRemote("https://ghp_secret123@github.com/acme/app.git");
    expect(r.url).not.toContain("ghp_secret123");
    expect(r.github).toEqual({ owner: "acme", repo: "app" });
    expect(parseRemote("git@gitlab.com:a/b.git").github).toBeNull();
  });
});
