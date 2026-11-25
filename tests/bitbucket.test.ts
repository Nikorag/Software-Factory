import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeader, BitbucketAuthError, gitEnv, gitUser, resolveCredential } from "../src/bitbucket/auth.js";
import { createBitbucketClient } from "../src/bitbucket/client.js";
import { loadConfig } from "../src/config/load.js";
import { BitbucketConfig, ProjectConfig, ProjectInput, type LoadedConfig } from "../src/config/schema.js";
import { addProfile } from "../src/config/profiles.js";
import { seedHomeConfig, upsertProject } from "../src/config/store.js";
import { openDb } from "../src/db/client.js";
import { repoSlug } from "../src/delivery/handlers.js";
import { GitHubError } from "../src/github/client.js";
import { createHosts } from "../src/host/index.js";
import { ensureClone } from "../src/repo/clone.js";
import { inspectRepository, parseRemote } from "../src/repo/inspect.js";
import { pushBranch } from "../src/repo/push.js";
import { buildServer } from "../src/server/app.js";
import { FakeBitbucket } from "./helpers/fake-bitbucket.js";
import { memoryStore } from "./helpers/fake-atlassian.js";
import { fixtureConfigDir } from "./helpers/config.js";
import { makeRepo, sh, tmp } from "./helpers/git-fixture.js";

let bb: FakeBitbucket;
beforeAll(async () => { bb = await new FakeBitbucket().start(); });
afterAll(() => bb.stop());
beforeEach(() => { bb.prs = []; bb.statuses.clear(); bb.comments = []; bb.restrictions = []; bb.pipelines = []; bb.calls = []; bb.restrictionStatus = 200; bb.expect = "Bearer good-token"; });

const ACCESS = { kind: "access-token" as const, token: "good-token" };
const client = (c = ACCESS) => createBitbucketClient({ credential: c, apiBase: bb.url, sleep: async () => {} });
const bproj = (o: Record<string, unknown> = {}) => ProjectConfig.parse({ id: "w", name: "W", repository: "/x/w", host: "bitbucket", bitbucket: { repo: "acme/widgets" }, defaultBranch: "main", commands: { test: "t" }, ...o });

describe("Bitbucket credentials", () => {
  it("sends an access token as Bearer and an API token as Basic (email:token), with the documented git usernames", () => {
    expect(authHeader(ACCESS)).toBe("Bearer good-token");
    const api = { kind: "api-token" as const, email: "me@x.com", token: "tok" };
    expect(authHeader(api)).toBe(`Basic ${Buffer.from("me@x.com:tok").toString("base64")}`);
    expect([gitUser(ACCESS), gitUser(api)]).toEqual(["x-token-auth", "x-bitbucket-api-token-auth"]);
  });
  it("authenticates git over HTTPS to Bitbucket only, through environment variables (never the command line)", () => {
    const env = gitEnv(ACCESS);
    expect(env.GIT_CONFIG_KEY_1).toBe("http.https://bitbucket.org/.extraheader");
    expect(env.GIT_CONFIG_VALUE_1).toBe(`AUTHORIZATION: basic ${Buffer.from("x-token-auth:good-token").toString("base64")}`);
    expect(env.GIT_CONFIG_VALUE_0).toBe("");                                                    // other stored credentials are not consulted
  });
  it("says exactly what is missing: an unknown credential, or one with no token saved", () => {
    const cfg = { bitbucket: BitbucketConfig.parse({ credentials: { work: { kind: "access-token" } } }) };
    expect(() => resolveCredential(cfg, "nope", memoryStore())).toThrow(/no Bitbucket credential named "nope"/);
    expect(() => resolveCredential(cfg, "work", memoryStore())).toThrow(BitbucketAuthError);
    expect(resolveCredential(cfg, "work", memoryStore({ work: "abc12345" }))).toEqual({ kind: "access-token", email: undefined, token: "abc12345" });
    expect(() => BitbucketConfig.parse({ credentials: { x: { kind: "api-token" } } })).toThrow(/needs the Atlassian account email/);
  });
});

describe("Bitbucket pull requests (behind the factory's PR interface)", () => {
  it("opens a pull request and maps it to the shape delivery expects", async () => {
    const pr = await client().createPr("acme/widgets", { head: "factory/ENG-1", base: "main", title: "Add due dates", body: "evidence" });
    expect(pr).toMatchObject({ number: 1, state: "OPEN", headRefName: "factory/ENG-1", baseRefName: "main", title: "Add due dates", url: "https://bitbucket.org/acme/widgets/pull-requests/1", mergeable: "UNKNOWN", isDraft: false });
    expect(bb.calls.at(-1)!.body).toMatchObject({ source: { branch: { name: "factory/ENG-1" } }, destination: { branch: { name: "main" } }, description: "evidence", close_source_branch: false });
    expect(bb.calls.at(-1)!.auth).toBe("Bearer good-token");
  });
  it("is idempotent: creating again for a branch that already has an open PR returns that one", async () => {
    const first = await client().createPr("acme/widgets", { head: "factory/ENG-1", base: "main", title: "t", body: "b" });
    const again = await client().createPr("acme/widgets", { head: "factory/ENG-1", base: "main", title: "t", body: "b" });
    expect(again.number).toBe(first.number);
    expect(bb.prs).toHaveLength(1);
  });
  it("finds a PR by branch, preferring the open one, and ignores other branches", async () => {
    bb.addPr({ branch: "factory/a", state: "DECLINED" }); bb.addPr({ branch: "factory/a", state: "OPEN" }); bb.addPr({ branch: "factory/other" });
    expect((await client().findPr("acme/widgets", "factory/a"))!.state).toBe("OPEN");
    expect(await client().findPr("acme/widgets", "factory/none")).toBeNull();
  });
  it("maps Bitbucket's states and review state: merged, declined as closed, approvals and requested changes", async () => {
    bb.addPr({ branch: "m", state: "MERGED" }); bb.addPr({ branch: "d", state: "DECLINED" }); bb.addPr({ branch: "s", state: "SUPERSEDED" });
    bb.addPr({ branch: "a", participants: [{ approved: true, state: "approved" }] }); bb.addPr({ branch: "c", participants: [{ approved: true }, { state: "changes_requested" }] });
    const get = async (n: number) => client().getPr("acme/widgets", n);
    expect(await get(1)).toMatchObject({ state: "MERGED", mergedAt: "2026-11-25T10:00:00Z" });
    expect((await get(2)).state).toBe("CLOSED"); expect((await get(3)).state).toBe("CLOSED");
    expect((await get(4)).reviewDecision).toBe("APPROVED"); expect((await get(5)).reviewDecision).toBe("CHANGES_REQUESTED");
    expect((await get(1)).reviewDecision).toBe("");
  });
  it("reads CI as commit statuses (pipelines), and comments on the PR", async () => {
    bb.addPr({ branch: "x" });
    bb.statuses.set(1, [{ key: "pipe", name: "Pipeline #12", state: "SUCCESSFUL", url: "https://bitbucket.org/acme/widgets/pipelines/results/12" }, { key: "lint", name: "lint", state: "FAILED", url: "u" }, { key: "t", name: "tests", state: "INPROGRESS", url: "u" }, { key: "s", name: "stopped", state: "STOPPED", url: "u" }]);
    expect((await client().checks("acme/widgets", 1)).map((c) => `${c.name}:${c.bucket}`)).toEqual(["Pipeline #12:pass", "lint:fail", "tests:pending", "stopped:cancel"]);
    expect(await client().checks("acme/widgets", 2)).toEqual([]);                              // a repo with no CI is not an error
    await client().commentOnPr("acme/widgets", 1, "Ready for review");
    expect(bb.comments).toEqual([{ pr: 1, raw: "Ready for review" }]);
  });
  it("fetches the log of a failed pipeline step for remediation, best effort", async () => {
    bb.pipelines = [{ uuid: "{p-1}", build_number: 12 }];
    const log = await client().failedLog("acme/widgets", { name: "Pipeline #12", workflow: "", bucket: "fail", state: "FAILED", link: "https://bitbucket.org/acme/widgets/pipelines/results/12" });
    expect(log).toContain("npm ERR! test failed");
    expect(await client().failedLog("acme/widgets", { name: "x", workflow: "", bucket: "fail", state: "FAILED", link: "https://elsewhere" })).toBe("");   // nothing to look up: empty, not an error
  });
  it("explains an expired or under-privileged token, and never retries an auth failure", async () => {
    bb.expect = "Bearer something-else";
    await expect(client().getPr("acme/widgets", 1)).rejects.toThrow(/\(401\).*rejected or has expired.*Settings → Integrations → Bitbucket/);
    const e = await client().getPr("acme/widgets", 1).catch((x) => x);
    expect(e).toBeInstanceOf(GitHubError); expect(e.retryable).toBe(false);
    expect(bb.calls.filter((c) => c.path.endsWith("/pullrequests/1"))).toHaveLength(2);
  });
  it("authenticates an API token with Basic auth", async () => {
    bb.expect = authHeader({ kind: "api-token", email: "me@x.com", token: "tok" });
    expect((await client({ kind: "api-token", email: "me@x.com", token: "tok" } as never).repository("acme/widgets")).name).toBe("acme/widgets");
  });
  it("reads branch restrictions as branch protection", async () => {
    expect(await client().protection("acme/widgets", "main")).toEqual({ status: "unprotected" });
    bb.restrictions = [{ kind: "require_passing_builds_to_merge", pattern: "main" }, { kind: "require_approvals_to_merge", pattern: "ma*" }, { kind: "push", pattern: "release/*" }];
    expect(await client().protection("acme/widgets", "main")).toEqual({ status: "protected", requiredChecks: ["passing builds"], requiresReviews: true });
    bb.restrictionStatus = 403;
    expect((await client().protection("acme/widgets", "main")).status).toBe("unavailable");
    expect((await client().protection("nobody/nothing", "main")).status).toBe("unknown");
  });
  it("has no merge operation at all", () => { expect(Object.keys(client()).some((k) => /merge/i.test(k))).toBe(false); });
});

describe("remotes and per-project hosts", () => {
  it("parses Bitbucket remotes in every common form, and strips embedded credentials", () => {
    for (const url of ["https://bitbucket.org/acme/widgets.git", "https://user:secret@bitbucket.org/acme/widgets", "git@bitbucket.org:acme/widgets.git", "git@bitbucket.org-work:acme/widgets.git", "ssh://git@bitbucket.org/acme/widgets.git"]) {
      expect(parseRemote(url).bitbucket, url).toEqual({ owner: "acme", repo: "widgets" });
      expect(parseRemote(url).github).toBeNull();
    }
    expect(parseRemote("https://user:secret@bitbucket.org/acme/widgets").url).not.toContain("secret");
    expect(parseRemote("git@github.com:o/r.git")).toMatchObject({ github: { owner: "o", repo: "r" }, bitbucket: null });
  });
  it("a project is GitHub unless it says Bitbucket, and each decides its own host, slug, clone URL and credentials", async () => {
    const cfg = { bitbucket: BitbucketConfig.parse({ credentials: { default: { kind: "access-token" } } }) };
    const hosts = createHosts(cfg, { store: memoryStore({ default: "good-token" }) });
    const gh = ProjectConfig.parse({ id: "g", name: "G", repository: "/x/g", github: { repo: "me/app" } }), b = bproj();
    expect([gh.host, b.host]).toEqual(["github", "bitbucket"]);
    expect(await hosts.slug(gh)).toBe("me/app"); expect(await hosts.slug(b)).toBe("acme/widgets");
    expect([hosts.cloneUrl(gh), hosts.cloneUrl(b)]).toEqual(["https://github.com/me/app.git", "https://bitbucket.org/acme/widgets.git"]);
    expect((await hosts.gitAuth(b))!.GIT_CONFIG_KEY_1).toBe("http.https://bitbucket.org/.extraheader");
    expect(await hosts.gitAuth(gh)).toBeUndefined();                                            // GitHub with no gh account: git's normal credentials
  });
  it("reads a checkout's Bitbucket slug from origin, and refuses an origin on the wrong host", async () => {
    const hosts = createHosts({ bitbucket: BitbucketConfig.parse({}) });
    const m = makeRepo(); sh(m.repo, "remote", "set-url", "origin", "git@bitbucket.org:acme/widgets.git");
    expect(await hosts.slug(bproj({ repository: m.repo, bitbucket: {} }))).toBe("acme/widgets");
    expect(await repoSlug(bproj({ repository: m.repo, bitbucket: {} }))).toBe("acme/widgets");   // delivery uses the same rule
    sh(m.repo, "remote", "set-url", "origin", "git@github.com:me/app.git");
    await expect(hosts.slug(bproj({ repository: m.repo, bitbucket: {} }))).rejects.toThrow(/cannot determine the Bitbucket repository/);
  });
  it("uses the right credential per project, so a token scoped to one repository serves only that project", () => {
    const cfg = { bitbucket: BitbucketConfig.parse({ credentials: { default: { kind: "access-token" }, other: { kind: "access-token" } } }) };
    const hosts = createHosts(cfg, { store: memoryStore({ default: "token-default", other: "token-other" }) });
    const a = (hosts.gitAuth(bproj({ bitbucket: { repo: "acme/widgets" } })));
    const b = (hosts.gitAuth(bproj({ id: "o", bitbucket: { repo: "acme/other", credential: "other" } })));
    return Promise.all([a, b]).then(([x, y]) => { expect(x!.GIT_CONFIG_VALUE_1).toContain(Buffer.from("x-token-auth:token-default").toString("base64")); expect(y!.GIT_CONFIG_VALUE_1).toContain(Buffer.from("x-token-auth:token-other").toString("base64")); });
  });
});

describe("clone, push and inspection on Bitbucket", () => {
  it("clones a managed Bitbucket project from bitbucket.org with Bitbucket credentials, and refuses a directory that is another repository", async () => {
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const git = (async (_cwd: string, args: string[], o?: { env?: NodeJS.ProcessEnv }) => { calls.push({ args, env: o?.env }); return ""; }) as never;
    const hosts = createHosts({ bitbucket: BitbucketConfig.parse({ credentials: { default: { kind: "access-token" } } }) }, { store: memoryStore({ default: "good-token" }) });
    const dir = join(tmp(), "w");
    expect(await ensureClone(bproj({ repository: dir, managed: true }), { git, hosts })).toMatchObject({ status: "cloned" });
    expect(calls[0]!.args.slice(0, 3)).toEqual(["clone", "--quiet", "https://bitbucket.org/acme/widgets.git"]);
    expect(calls[0]!.env!.GIT_CONFIG_VALUE_1).toContain("AUTHORIZATION: basic");
    const present = join(tmp(), "present"); mkdirSync(present); writeFileSync(join(present, "f"), "x");
    const wrong = (async () => "git@github.com:me/app.git") as never;
    expect((await ensureClone(bproj({ repository: present, managed: true }), { git: wrong, hosts })).status).toBe("error");
    const right = (async () => "https://bitbucket.org/acme/widgets.git") as never;
    expect((await ensureClone(bproj({ repository: present, managed: true }), { git: right, hosts })).status).toBe("present");
  });
  it("pushes with the host's git credentials when given them (and still only factory/* branches, never forced)", async () => {
    const seen: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const git = (async (_c: string, args: string[], o?: { env?: NodeJS.ProcessEnv }) => { seen.push({ args, env: o?.env }); return ""; }) as never;
    await pushBranch("/wt", "factory/ENG-1", { defaultBranch: "main", env: gitEnv(ACCESS), git });
    expect(seen[0]!.env!.GIT_CONFIG_VALUE_1).toContain("AUTHORIZATION: basic");
    expect(seen[0]!.args).toEqual(["push", "--set-upstream", "origin", "factory/ENG-1:factory/ENG-1"]);
    await expect(pushBranch("/wt", "main", { defaultBranch: "main", env: gitEnv(ACCESS), git })).rejects.toThrow(/only factory\/\* branches/);
  });
  it("validates a Bitbucket project: its own remote kind, CI file, and protection from the injected reader", async () => {
    const m = makeRepo({ "bitbucket-pipelines.yml": "pipelines: {}\n" }); sh(m.repo, "remote", "set-url", "origin", "git@bitbucket.org:acme/widgets.git");
    const r = await inspectRepository(bproj({ repository: m.repo }), { bitbucketProtection: async (slug) => ({ status: "protected", requiredChecks: [slug], requiresReviews: true }) });
    expect(r.remote).toMatchObject({ bitbucket: { owner: "acme", repo: "widgets" }, github: null });
    expect(r.ciWorkflows).toEqual(["bitbucket-pipelines.yml"]);
    expect(r.branchProtection).toEqual({ status: "protected", requiredChecks: ["acme/widgets"], requiresReviews: true });
    expect(r.findings.some((f) => f.severity === "error")).toBe(false);
    sh(m.repo, "remote", "set-url", "origin", "git@github.com:me/app.git");
    expect((await inspectRepository(bproj({ repository: m.repo }), {})).findings.some((f) => f.code === "not-bitbucket")).toBe(true);   // the project says Bitbucket, origin says GitHub
  });
});

describe("configuring projects per host", () => {
  it("a project needs the repository of ITS host", () => {
    expect(ProjectInput.safeParse({ id: "a", name: "A", host: "bitbucket", github: { repo: "me/x" } }).success).toBe(false);
    expect(ProjectInput.safeParse({ id: "a", name: "A", host: "bitbucket", bitbucket: { repo: "acme/widgets" } }).success).toBe(true);
    expect(ProjectInput.safeParse({ id: "a", name: "A", github: { repo: "me/x" } }).success).toBe(true);
  });
  it("saves a Bitbucket project from the dashboard's settings, and an unchanged GitHub project writes no host line", () => {
    const dir = seedHomeConfig(join(tmp(), "config"));
    const c = upsertProject({ id: "w", name: "W", host: "bitbucket", bitbucket: { repo: "acme/widgets", credential: "work" }, linear: { teamKey: "ENG", projectName: "W" }, commands: { test: "t" } }, dir);
    expect(c.projects.projects[0]).toMatchObject({ host: "bitbucket", bitbucket: { repo: "acme/widgets", credential: "work" } });
    upsertProject({ id: "g", name: "G", github: { repo: "me/g" }, linear: { teamKey: "ENG", projectName: "G" } }, dir);
    const loaded = loadConfig(dir);
    expect(loaded.projects.projects.map((p) => p.host)).toEqual(["bitbucket", "github"]);       // both hosts side by side in one profile
    expect(() => upsertProject({ id: "x", name: "X", host: "bitbucket", github: { repo: "me/x" } }, dir)).toThrow(/Bitbucket repo/);
  });
  it("gives each profile its own keychain service for Bitbucket tokens", () => {
    const w = addProfile("work", tmp());
    expect(loadConfig(join(w.home, "config")).bitbucket.keychainService).toBe("software-factory-bitbucket-work");
  });
});

describe("credential API", () => {
  const HOST = { host: "127.0.0.1:4780" }, UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1" };
  function setup() {
    const dir = fixtureConfigDir();
    upsertProject({ id: "w", name: "W", host: "bitbucket", bitbucket: { repo: "acme/widgets", credential: "work" }, commands: { test: "t" } }, dir);
    const config: LoadedConfig = loadConfig(dir);
    const store = memoryStore();
    const app = buildServer({ db: openDb(":memory:").db, logger: pino({ level: "silent" }), config, port: 4780, controlToken: "t".repeat(64), bitbucket: { store, apiBase: bb.url } });
    const req = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, headers: Record<string, string>, body?: unknown) =>
      app.inject({ method, url, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, remoteAddress: "127.0.0.1", payload: body === undefined ? undefined : JSON.stringify(body) });
    return { dir, config, store, req };
  }
  it("adds a credential (token to the keychain, only its kind in config), lists it with the projects that use it, and needs the dashboard origin or token", async () => {
    const s = setup();
    expect((await s.req("PUT", "/api/bitbucket/credentials/work", HOST, { kind: "access-token", token: "good-token" })).statusCode).toBe(401);
    expect((await s.req("PUT", "/api/bitbucket/credentials/work", UI, { kind: "api-token", token: "good-token" })).statusCode).toBe(400);     // needs an email
    expect((await s.req("PUT", "/api/bitbucket/credentials/Bad Name", UI, { kind: "access-token", token: "good-token" })).statusCode).toBeGreaterThanOrEqual(400);
    const ok = await s.req("PUT", "/api/bitbucket/credentials/work", UI, { kind: "access-token", token: "good-token" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(s.store.data.work).toBe("good-token");
    expect(JSON.stringify(s.config)).not.toContain("good-token");
    expect(await import("node:fs").then((fs) => fs.readFileSync(join(s.dir, "bitbucket.yaml"), "utf8"))).not.toContain("good-token");
    const list = (await s.req("GET", "/api/bitbucket/credentials", HOST)).json().credentials;
    expect(list).toEqual([{ name: "work", kind: "access-token", email: null, hasToken: true, usedBy: ["w"] }]);
    expect(JSON.stringify(list)).not.toContain("good-token");                                     // the token is never sent back
  });
  it("tests a credential against a repository, with a readable error when it fails", async () => {
    const s = setup();
    await s.req("PUT", "/api/bitbucket/credentials/work", UI, { kind: "access-token", token: "good-token" });
    expect((await s.req("POST", "/api/bitbucket/credentials/work/test", UI, { repo: "acme/widgets" })).json()).toMatchObject({ ok: true, name: "acme/widgets", isPrivate: true, mainBranch: "main" });
    expect((await s.req("POST", "/api/bitbucket/credentials/work/test", UI, { repo: "acme/missing" })).json().error).toMatch(/not found/);
    bb.expect = "Bearer other";
    expect((await s.req("POST", "/api/bitbucket/credentials/work/test", UI, { repo: "acme/widgets" })).json().error).toMatch(/rejected or has expired/);
    expect((await s.req("POST", "/api/bitbucket/credentials/work/test", UI, { repo: "not a repo" })).statusCode).toBe(400);
  });
  it("refuses to delete a credential a project still uses, and deletes an unused one", async () => {
    const s = setup();
    await s.req("PUT", "/api/bitbucket/credentials/work", UI, { kind: "access-token", token: "good-token" });
    await s.req("PUT", "/api/bitbucket/credentials/spare", UI, { kind: "api-token", email: "me@x.com", token: "spare-token" });
    expect((await s.req("DELETE", "/api/bitbucket/credentials/work", UI)).json().error).toMatch(/still used by: w/);
    expect((await s.req("DELETE", "/api/bitbucket/credentials/spare", UI)).statusCode).toBe(200);
    expect(s.config.bitbucket.credentials.spare).toBeUndefined();
    expect(s.store.get("spare")).toBeUndefined();
  });
  it("exposes each project's host to the dashboard", async () => {
    const s = setup();
    const app = buildServer({ db: openDb(":memory:").db, logger: pino({ level: "silent" }), config: s.config, port: 4780 });
    const list = (await app.inject({ method: "GET", url: "/api/projects", headers: HOST, remoteAddress: "127.0.0.1" })).json().projects;
    expect(list.find((p: { id: string }) => p.id === "w")).toMatchObject({ host: "bitbucket", bitbucketRepo: "acme/widgets", bitbucketCredential: "work" });
    expect(list.find((p: { id: string }) => p.id === "example-game").host).toBe("github");
  });
});
