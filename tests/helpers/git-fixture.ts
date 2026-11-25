import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always", // local submodule tests
});

export const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "factory-t-")));

/** A repo cloned from a local bare origin, with one commit on main. */
export function makeRepo(files: Record<string, string> = { "README.md": "hi\n" }) {
  const base = tmp();
  const origin = join(base, "origin.git");
  const repo = join(base, "repo");
  sh(base, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(repo, f, ".."), { recursive: true });
    writeFileSync(join(repo, f), c);
  }
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  sh(repo, "remote", "add", "origin", origin);
  sh(repo, "push", "-q", "-u", "origin", "main");
  sh(repo, "remote", "set-head", "origin", "main");
  return { base, origin, repo, workspaces: join(base, "workspaces") };
}
