import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createGhClient, GitHubError, type GhExec } from "../src/github/client.js";
import { PushRejected, pushBranch } from "../src/repo/push.js";
import { GitError, type GitFn } from "../src/repo/git.js";

const pr = (o: Record<string, unknown> = {}) => ({ number: 5, url: "https://github.com/o/r/pull/5", title: "T", state: "OPEN", isDraft: false, headRefName: "factory/JAM-1", headRefOid: "abc", baseRefName: "main", mergedAt: null, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", ...o });
const fake = (responses: Record<string, string | Error>) => {
  const calls: string[][] = [];
  const run: GhExec = async (args) => {
    calls.push(args);
    const key = Object.keys(responses).find((k) => args.join(" ").includes(k));
    const r = key ? responses[key]! : "";
    if (r instanceof Error) throw r;
    return r;
  };
  return { run, calls };
};

describe("createGhClient (argument building and parsing; verified field names from real gh 2.105 output)", () => {
  it("findPr asks for the head branch across all states, prefers the open PR, and ignores other branches", async () => {
    const { run, calls } = fake({ "pr list": JSON.stringify([pr({ number: 3, state: "CLOSED" }), pr({ number: 9 }), pr({ number: 4, headRefName: "other" })]) });
    const p = await createGhClient({ run }).findPr("o/r", "factory/JAM-1");
    expect(p).toMatchObject({ number: 9, state: "OPEN" });
    expect(calls[0]).toEqual(expect.arrayContaining(["--repo", "o/r", "--head", "factory/JAM-1", "--state", "all"]));
    expect(await createGhClient({ run: fake({ "pr list": "[]" }).run }).findPr("o/r", "x")).toBeNull();
  });
  it("createPr passes head/base/title and the body via a file (never on the command line), then returns the parsed PR", async () => {
    const seen: { args: string[]; body?: string }[] = [];
    const run: GhExec = async (args) => {
      if (args[1] === "create") { seen.push({ args, body: readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8") }); return "https://github.com/o/r/pull/5\n"; }
      return JSON.stringify(pr());
    };
    const out = await createGhClient({ run }).createPr("o/r", { head: "factory/JAM-1", base: "main", title: "JAM-1: t", body: "SECRET-LOOKING BODY with `backticks` and $(subshell)" });
    expect(out.number).toBe(5);
    const create = seen[0]!;
    expect(create.args).toEqual(expect.arrayContaining(["--repo", "o/r", "--head", "factory/JAM-1", "--base", "main", "--title", "JAM-1: t"]));
    expect(create.args.join(" ")).not.toContain("SECRET-LOOKING BODY");
    expect(create.body).toContain("$(subshell)");
  });
  it("parses checks, and treats 'no checks reported' (a repo without CI) as an empty list, not an error", async () => {
    const c = await createGhClient({ run: fake({ "pr checks": JSON.stringify([{ name: "app", state: "SUCCESS", bucket: "pass", link: "https://github.com/o/r/actions/runs/1/job/2", workflow: "CI" }]) }).run }).checks("o/r", 5);
    expect(c).toEqual([{ name: "app", workflow: "CI", bucket: "pass", state: "SUCCESS", link: "https://github.com/o/r/actions/runs/1/job/2" }]);
    const none = Object.assign(new Error("exit 1"), { stderr: "no checks reported on the 'factory/JAM-1' branch" });
    expect(await createGhClient({ run: fake({ "pr checks": none }).run }).checks("o/r", 5)).toEqual([]);
  });
  it("classifies errors: network/rate-limit retryable, auth/not-found not, and tokens never appear in messages", async () => {
    const mk = (msg: string) => createGhClient({ run: fake({ "pr view": Object.assign(new Error(msg), { stderr: msg }) }).run }).getPr("o/r", 1).catch((e) => e as GitHubError) as Promise<GitHubError>;
    expect((await mk("HTTP 503: Service Unavailable"))).toMatchObject({ retryable: true });
    expect((await mk("API rate limit exceeded"))).toMatchObject({ retryable: true });
    expect((await mk("could not resolve host: api.github.com"))).toMatchObject({ retryable: true });
    expect((await mk("HTTP 404: Not Found"))).toMatchObject({ retryable: false });
    expect((await mk("HTTP 401 bad credentials"))).toMatchObject({ retryable: false });
    const leak = await mk("failed with token ghp_" + "a".repeat(36));
    expect(leak.message).not.toContain("ghp_a");
  });
  it("extracts run and job ids from a check link to fetch the failed log, and bounds its size", async () => {
    const { run, calls } = fake({ "run view": "x".repeat(20_000) });
    const log = await createGhClient({ run }).failedLog("o/r", { name: "app", workflow: "CI", bucket: "fail", state: "FAILURE", link: "https://github.com/o/r/actions/runs/123/job/456" });
    expect(calls[0]).toEqual(expect.arrayContaining(["run", "view", "123", "--job", "456", "--log-failed"]));
    expect(log.length).toBeLessThan(6100);
    expect(await createGhClient({ run }).failedLog("o/r", { name: "n", workflow: "", bucket: "fail", state: "", link: "https://example.com/nothing" })).toBe("");
  });
  it("never issues a merge-related gh command, whatever is called", async () => {
    const { run, calls } = fake({ "pr list": "[]", "pr view": JSON.stringify(pr()), "pr checks": "[]", "pr create": "https://github.com/o/r/pull/5" });
    const c = createGhClient({ run });
    await c.findPr("o/r", "b"); await c.getPr("o/r", 1); await c.checks("o/r", 1); await c.createPr("o/r", { head: "h", base: "m", title: "t", body: "b" }); await c.commentOnPr("o/r", 1, "hi");
    expect(calls.flat()).not.toContain("merge");
    expect(Object.keys(c)).not.toContain("merge");
  });
});

describe("pushBranch (the only way anything reaches the remote)", () => {
  const rec = () => { const calls: { args: string[]; opts?: unknown }[] = []; const git: GitFn = async (_c, args, opts) => { calls.push({ args, opts }); return ""; }; return { git, calls }; };
  it("pushes exactly one explicit factory branch refspec, protecting the default branch", async () => {
    const { git, calls } = rec();
    await pushBranch("/wt", "factory/JAM-1", { defaultBranch: "main", git });
    expect(calls[0]!.args).toEqual(["push", "--set-upstream", "origin", "factory/JAM-1:factory/JAM-1"]);
    expect((calls[0]!.opts as { protectedBranches: string[] }).protectedBranches).toEqual(["main"]);
    expect(calls[0]!.args.join(" ")).not.toMatch(/--force|-f\b|\+/);
  });
  it("refuses the default branch and anything outside factory/*", async () => {
    const { git, calls } = rec();
    for (const b of ["main", "feature/x", "factory", "release"]) await expect(pushBranch("/wt", b, { defaultBranch: "main", git })).rejects.toBeInstanceOf(PushRejected);
    expect(calls).toHaveLength(0);
  });
  it("turns a non-fast-forward rejection into PushRejected (never retried, never forced) and passes other errors through", async () => {
    const reject: GitFn = async () => { throw new GitError("git push failed: ! [rejected] factory/JAM-1 (fetch first)", []); };
    await expect(pushBranch("/wt", "factory/JAM-1", { defaultBranch: "main", git: reject })).rejects.toThrow(/never force-pushes/);
    const net: GitFn = async () => { throw new GitError("git push failed: Could not resolve host", []); };
    await expect(pushBranch("/wt", "factory/JAM-1", { defaultBranch: "main", git: net })).rejects.toBeInstanceOf(GitError);
  });
});
