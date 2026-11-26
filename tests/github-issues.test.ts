import pino from "pino";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BUNDLED_CONFIG_DIR, loadConfig } from "../src/config/load.js";
import { GithubIssuesConfig, ProjectConfig, githubTrackerNames, type LoadedConfig } from "../src/config/schema.js";
import { seedHomeConfig, updateGithubIssuesConfig, updateTracker } from "../src/config/store.js";
import { addProfile } from "../src/config/profiles.js";
import { enqueue } from "../src/core/jobs.js";
import { openDb } from "../src/db/client.js";
import { jobs, linearOutbox, projects } from "../src/db/schema.js";
import { checkLinear } from "../src/doctor/checks.js";
import { createGithubIssuesClient, issueKeyOf, parseIssueRef } from "../src/github-issues/client.js";
import { LinearApiError } from "../src/linear/client.js";
import { auditTeam } from "../src/linear/check.js";
import { discoverIssues } from "../src/linear/discovery.js";
import { enqueueOutbox, flushOutbox } from "../src/linear/outbox.js";
import { applySetup } from "../src/linear/setup.js";
import { syncProjects } from "../src/repo/registry.js";
import { buildServer } from "../src/server/app.js";
import { parseSearch } from "../src/server/board-routes.js";
import { createTrackerClient, trackerName } from "../src/tracker/index.js";
import { fixtureConfigDir } from "./helpers/config.js";
import { FakeGhIssues } from "./helpers/fake-gh-issues.js";
import { tmp } from "./helpers/git-fixture.js";
import { memoryStore } from "./helpers/fake-atlassian.js";
import { join } from "node:path";

const REPO = "acme/web-app";
const NAMES = GithubIssuesConfig.parse({});
const mkClient = (gh: FakeGhIssues, o: Partial<Parameters<typeof createGithubIssuesClient>[0]> = {}) =>
  createGithubIssuesClient({ statusPrefix: NAMES.statusPrefix, statuses: NAMES.statuses, run: gh.run, sleep: async () => {}, ...o });
const quiet = pino({ level: "silent" });

describe("GitHub Issues client (as the factory's tracker)", () => {
  it("maps GitHub onto the tracker interface: repositories as teams, milestones as projects, status labels as workflow states", async () => {
    const gh = new FakeGhIssues(); gh.addMilestone(REPO, 3, "v2"); gh.addIssue(REPO, { labels: ["status: In progress"] });
    const c = mkClient(gh);
    expect(await c.viewer()).toEqual({ id: "factory-bot", name: "factory-bot" });
    expect(await c.teams()).toEqual([{ id: REPO, key: REPO, name: REPO }]);
    expect(await c.projects(REPO)).toEqual([{ id: "3", name: "v2" }]);
    const states = await c.workflowStates(REPO);
    expect(states).toEqual(expect.arrayContaining([{ id: "In progress", name: "In progress", type: "started" }, { id: "Done", name: "Done", type: "completed" }])); // "Done" closes an issue: it needs no label
    expect((await c.labels(REPO)).map((l) => l.name)).toEqual([]);                                                                                          // status labels are not ordinary labels
  });

  it("reads an issue: id carries the repository, a branch-safe key, the milestone, labels without status labels, and its status", async () => {
    const gh = new FakeGhIssues(); gh.addMilestone(REPO, 3, "v2");
    const i = gh.addIssue(REPO, { number: 12, title: "Add login", body: "Please", labels: ["bug", "status: Ready for specification"], milestone: 3 });
    const d = await mkClient(gh).getIssue(`${REPO}#${i.number}`);
    expect(d).toMatchObject({ id: "acme/web-app#12", identifier: "web-app-12", title: "Add login", description: "Please", url: "https://github.com/acme/web-app/issues/12", team: { key: REPO }, project: { id: "3", name: "v2" }, state: { name: "Ready for specification", type: "unstarted" } });
    expect(d.labels).toEqual([{ id: "bug", name: "bug" }]);
    expect(d.identifier).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);                    // usable as a worktree key
    expect(issueKeyOf("o/my.repo", 5)).toBe("my-repo-5");
    expect(parseIssueRef("https://github.com/acme/web-app/issues/9")).toEqual({ repo: REPO, number: 9 });
    expect(() => parseIssueRef("nonsense")).toThrow(/not a GitHub issue reference/);
  });

  it("states: an open issue with no status label is Open, a closed one is Done", async () => {
    const gh = new FakeGhIssues(); gh.addIssue(REPO, { number: 1 }); gh.addIssue(REPO, { number: 2, state: "closed" });
    const c = mkClient(gh);
    expect((await c.getIssue(`${REPO}#1`)).state).toMatchObject({ name: "Open", type: "unstarted" });
    expect((await c.getIssue(`${REPO}#2`)).state).toMatchObject({ name: "Done", type: "completed" });
  });

  it("finds tickets by status label and opt-in label, scoped to a milestone, never returning pull requests", async () => {
    const gh = new FakeGhIssues(); gh.addMilestone(REPO, 1, "Web"); gh.addMilestone(REPO, 2, "API");
    gh.addIssue(REPO, { number: 1, labels: ["status: Ready for specification", "factory:enabled"], milestone: 1 });
    gh.addIssue(REPO, { number: 2, labels: ["status: Ready for specification", "factory:enabled"], milestone: 2 });
    gh.addIssue(REPO, { number: 3, labels: ["status: Ready for specification"], milestone: 1 });                               // no opt-in
    gh.addIssue(REPO, { number: 4, labels: ["status: Ready for specification", "factory:enabled"], pull_request: {} });         // a PR
    gh.addIssue(REPO, { number: 5, labels: ["status: Ready for specification", "factory:enabled"], state: "closed" });          // closed
    const c = mkClient(gh);
    const base = { teamKey: REPO, stateName: "Ready for specification", labelName: "factory:enabled" };
    expect((await c.listIssues(base)).map((i) => i.id)).toEqual([`${REPO}#1`, `${REPO}#2`]);
    expect((await c.listIssues({ ...base, projectName: "web" })).map((i) => i.id)).toEqual([`${REPO}#1`]);
    expect((await c.listIssues({ ...base, projectId: "2" })).map((i) => i.id)).toEqual([`${REPO}#2`]);
    await expect(c.listIssues({ ...base, projectName: "nope" })).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("serves the Board: open tickets, one by number, and a title search; and pages past 100 issues", async () => {
    const gh = new FakeGhIssues();
    for (let n = 1; n <= 120; n++) gh.addIssue(REPO, { number: n, title: n === 7 ? "Fix the login bug" : `Task ${n}`, state: n > 110 ? "closed" : "open" });
    gh.addIssue(REPO, { number: 200, title: "a PR", pull_request: {} });
    const c = mkClient(gh);
    expect((await c.boardIssues({ teamKey: REPO, openOnly: true, limit: 500 })).length).toBe(110);
    expect((await c.boardIssues({ teamKey: REPO, number: 7 })).map((i) => i.title)).toEqual(["Fix the login bug"]);
    expect(await c.boardIssues({ teamKey: REPO, number: 999 })).toEqual([]);
    expect(await c.boardIssues({ teamKey: REPO, number: 200 })).toEqual([]);                                                    // a PR is not a ticket
    expect((await c.boardIssues({ teamKey: REPO, title: "login", openOnly: true })).map((i) => i.id)).toEqual([`${REPO}#7`]);
    expect(parseSearch("web-app-12")).toEqual({ teamKey: "WEB-APP", number: 12 });
  });

  it("moves a ticket by keeping exactly one status label; Done closes it and any other status reopens it", async () => {
    const gh = new FakeGhIssues(); const i = gh.addIssue(REPO, { number: 1, labels: ["bug", "status: Ready for specification"] });
    const c = mkClient(gh);
    await c.setState(`${REPO}#1`, "In progress");
    expect(i.labels).toEqual(["bug", "status: In progress"]); expect(i.state).toBe("open");
    await c.setState(`${REPO}#1`, "Done");
    expect(i.labels).toEqual(["bug", "status: Done"]); expect(i.state).toBe("closed");
    await c.setState(`${REPO}#1`, "Blocked");
    expect(i.labels).toEqual(["bug", "status: Blocked"]); expect(i.state).toBe("open");
  });

  it("adds and removes labels (creating them by use), and removing one that is already gone is fine", async () => {
    const gh = new FakeGhIssues(); const i = gh.addIssue(REPO, { number: 1 });
    const c = mkClient(gh);
    expect(c.freeformLabels).toBe(true);
    await c.addLabel(`${REPO}#1`, "factory:blocked");
    expect(i.labels).toEqual(["factory:blocked"]);
    await c.removeLabel(`${REPO}#1`, "factory:blocked");
    await c.removeLabel(`${REPO}#1`, "factory:blocked");
    expect(i.labels).toEqual([]);
  });

  it("writes comments carrying the factory's own id, finds them again, and links a pull request only once", async () => {
    const gh = new FakeGhIssues(); gh.addIssue(REPO, { number: 1 });
    const c = mkClient(gh);
    const id = "11111111-2222-4333-8444-555555555555";
    await c.createComment(`${REPO}#1`, "**Software factory** hello", id);
    await c.linkPullRequest(`${REPO}#1`, "https://github.com/acme/web-app/pull/5", "web-app-1: Add login");
    await c.linkPullRequest(`${REPO}#1`, "https://github.com/acme/web-app/pull/5", "web-app-1: Add login");
    const d = await c.getIssue(`${REPO}#1`);
    expect(d.comments.map((x) => x.id)).toContain(id);
    expect(d.comments.filter((x) => x.body.includes("pull/5")).length).toBe(1);
    expect(d.comments[1]!.body).toContain("[web-app-1: Add login](https://github.com/acme/web-app/pull/5)");
  });

  it("creates its own status labels and ordinary labels (never duplicating), so setup works as it does for Linear", async () => {
    const gh = new FakeGhIssues(); gh.repo(REPO);
    const c = mkClient(gh);
    const cfg = githubTrackerNames(NAMES);
    const team = { id: REPO, key: REPO, name: REPO };
    expect((await auditTeam(c, cfg, team)).ok).toBe(false);
    const r = await applySetup(c, cfg, team, {});
    expect(r.failed).toEqual([]);
    expect([...gh.repo(REPO).labels.values()].map((l) => l.name)).toEqual(expect.arrayContaining(["status: Ready for specification", "status: In progress", "factory:enabled", "factory:blocked"]));
    expect((await auditTeam(c, cfg, team)).ok).toBe(true);
    expect((await applySetup(c, cfg, team, {})).created).toEqual([]);                  // a second run changes nothing
    await expect(c.createLabel(REPO, "factory:enabled", "#000000")).resolves.toEqual({ id: "factory:enabled" }); // 422 "already exists" is success
  });

  it("retries rate limits and server errors, and explains auth and not-found failures without leaking tokens", async () => {
    const gh = new FakeGhIssues(); gh.addIssue(REPO, { number: 1 });
    const c = mkClient(gh);
    gh.failNext = { match: /GET \/user$/, message: "gh: API rate limit exceeded (HTTP 403)" };
    await expect(c.viewer()).resolves.toMatchObject({ name: "factory-bot" });
    gh.failNext = { match: /GET \/user$/, message: "gh: Bad gateway (HTTP 502)" };
    await expect(c.viewer()).resolves.toBeTruthy();
    gh.failNext = { match: /GET \/user$/, message: "gh: Bad credentials (HTTP 401) ghp_abcdefghijklmnop" };
    const e = (await c.viewer().catch((x) => x)) as LinearApiError;
    expect(e).toBeInstanceOf(LinearApiError); expect(e).toMatchObject({ code: "AUTH", retryable: false }); expect(e.message).not.toContain("ghp_abcdefghijklmnop");
    await expect(c.getIssue(`${REPO}#99`)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(c.getIssue("../../etc#1")).rejects.toThrow(/not a GitHub issue reference/);
  });
});

describe("config for a GitHub profile", () => {
  it("is chosen per profile and needs no keychain entry: statuses and labels default to the factory's own names", () => {
    const root = tmp();
    const work = addProfile("work", root);
    const dir = join(work.home, "config");
    updateTracker("github", dir);
    const c = loadConfig(dir);
    expect(c.factory.tracker).toBe("github");
    expect(c.githubIssues.statusPrefix).toBe("status: ");
    expect(c.linear.statuses.readyForSpecification).toBe("Ready for specification");
    expect(c.linear.labels.enabled).toBe("factory:enabled");
    expect(trackerName(c)).toBe("GitHub Issues");
    expect(loadConfig(BUNDLED_CONFIG_DIR).factory.tracker).toBe("linear");
  });
  it("writes the status prefix and renamed statuses to github-issues.yaml, and refuses an unloadable one", () => {
    const dir = seedHomeConfig(join(tmp(), "config"));
    updateTracker("github", dir);
    const c = updateGithubIssuesConfig({ statusPrefix: "st/", statuses: { ...NAMES.statuses, done: "Shipped" }, labels: { ...NAMES.labels, enabled: "bot" } }, dir);
    expect(c.githubIssues).toMatchObject({ statusPrefix: "st/", statuses: { done: "Shipped" } });
    expect(c.linear).toMatchObject({ statuses: { done: "Shipped" }, labels: { enabled: "bot" } });
    expect(() => updateGithubIssuesConfig({ statusPrefix: "" }, dir)).toThrow();
  });
  it("builds the client from the profile's gh login and reports it in the doctor check", async () => {
    const dir = fixtureConfigDir(); updateTracker("github", dir);
    const config = loadConfig(dir);
    const gh = new FakeGhIssues();
    expect(await createTrackerClient(config, { gh: gh.run }).viewer()).toMatchObject({ name: "factory-bot" });
    expect(await checkLinear(config, createTrackerClient(config, { gh: gh.run }))).toEqual({ name: "github-issues", status: "ok", detail: "authenticated as factory-bot" });
  });
});

describe("the pipeline on GitHub Issues", () => {
  const mk = () => {
    const { db } = openDb(":memory:");
    const linear = githubTrackerNames(NAMES);
    const p = ProjectConfig.parse({ id: "a", name: "A", repository: "/x/a", linear: { teamKey: REPO, projectName: "Web" } });
    syncProjects(db, [p]); db.update(projects).set({ validationJson: JSON.stringify({ ok: true }) }).run();
    return { db, linear, p };
  };
  it("discovers opted-in tickets in the pickup status, scoped to the milestone", async () => {
    const gh = new FakeGhIssues(); gh.addMilestone(REPO, 1, "Web"); gh.addMilestone(REPO, 2, "API");
    gh.addIssue(REPO, { number: 1, labels: ["status: Ready for specification", "factory:enabled"], milestone: 1 });
    gh.addIssue(REPO, { number: 2, labels: ["status: Ready for specification", "factory:enabled"], milestone: 2 });
    const { db, linear, p } = mk();
    const r = await discoverIssues({ db, client: mkClient(gh), linear, projects: [p], logger: quiet });
    expect(r.enqueued.map((e) => e.key)).toEqual(["web-app-1"]);
    expect(db.select().from(jobs).get()!.externalId).toBe(`${REPO}#1`);
  });
  it("writes status, label and comment updates through the same outbox, retry-safe", async () => {
    const gh = new FakeGhIssues(); const i = gh.addIssue(REPO, { number: 1, labels: ["status: Ready for specification", "factory:enabled"] });
    const { db, linear } = mk();
    const job = enqueue(db, { projectId: "a", externalId: `${REPO}#1`, externalKey: "web-app-1" }).job;
    enqueueOutbox(db, job.id, `${REPO}#1`, { kind: "set_state", stateKey: "inProgress" }, "k1");
    enqueueOutbox(db, job.id, `${REPO}#1`, { kind: "add_label", labelKey: "blocked" }, "k2");
    enqueueOutbox(db, job.id, `${REPO}#1`, { kind: "comment", body: "**Software factory** working on it" }, "k3");
    enqueueOutbox(db, job.id, `${REPO}#1`, { kind: "link_pr", url: "https://github.com/acme/web-app/pull/3", title: "t" }, "k4");
    const c = mkClient(gh);
    const first = await flushOutbox({ db, client: c, linear, logger: quiet });
    expect(first.failed).toBe(1);                                                    // like Linear: a status that was never created is reported, with what to do
    expect(db.select().from(linearOutbox).where(eq(linearOutbox.idempotencyKey, "k1")).get()!.lastError).toMatch(/does not exist.*Settings → Tracker/);
    await applySetup(c, linear, { id: REPO, key: REPO, name: REPO }, {});            // Settings → Tracker → create the missing statuses and labels
    db.update(linearOutbox).set({ status: "pending", attempts: 0 }).where(eq(linearOutbox.idempotencyKey, "k1")).run();
    expect(await flushOutbox({ db, client: c, linear, logger: quiet })).toMatchObject({ sent: 1, failed: 0 });
    expect([...i.labels].sort()).toEqual(["factory:blocked", "factory:enabled", "status: In progress"]);
    // an interrupted attempt that already posted the comment must not post it twice
    db.update(linearOutbox).set({ status: "pending" }).where(eq(linearOutbox.idempotencyKey, "k3")).run();
    const before = gh.repo(REPO).comments.get(1)!.length;
    await flushOutbox({ db, client: { ...c, createComment: async () => { throw new LinearApiError("timeout after the write", true); } }, linear, logger: quiet });
    expect(gh.repo(REPO).comments.get(1)!.length).toBe(before);
    expect(db.select().from(linearOutbox).where(eq(linearOutbox.idempotencyKey, "k3")).get()!.status).toBe("done");
    // finishing the ticket closes it
    enqueueOutbox(db, job.id, `${REPO}#1`, { kind: "set_state", stateKey: "done" }, "k5");
    await flushOutbox({ db, client: c, linear, logger: quiet });
    expect(i.state).toBe("closed");
  });
});

describe("choosing and mapping GitHub Issues through the dashboard API", () => {
  const HOST = { host: "127.0.0.1:4780" }, UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1" };
  function setup() {
    const dir = fixtureConfigDir();
    updateTracker("github", dir);
    const config: LoadedConfig = loadConfig(dir);
    const { db } = openDb(":memory:");
    const gh = new FakeGhIssues(); gh.repo(REPO);
    const app = buildServer({ db, logger: quiet, config, port: 4780, controlToken: "t".repeat(64), jira: { store: memoryStore(), port: 4780 }, githubIssues: { gh: gh.run } });
    const req = (method: "GET" | "PUT" | "POST", url: string, headers: Record<string, string>, body?: unknown) =>
      app.inject({ method, url, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, remoteAddress: "127.0.0.1", payload: body === undefined ? undefined : JSON.stringify(body) });
    return { db, dir, config, req, gh };
  }
  it("shows who GitHub says we are, and the current names", async () => {
    const s = setup();
    expect((await s.req("GET", "/api/github-issues/whoami", HOST)).json()).toMatchObject({ name: "factory-bot" });
    expect((await s.req("GET", "/api/github-issues/mapping", HOST)).json()).toMatchObject({ statusPrefix: "status: ", statuses: { done: "Done" }, labels: { enabled: "factory:enabled" } });
    expect((await s.req("GET", "/api/github-issues/status", HOST)).json()).toMatchObject({ tracker: "github" });
  });
  it("saves a renamed mapping to the config (needs the UI token) and applies it to the running service", async () => {
    const s = setup();
    const body = { statusPrefix: "wf: ", statuses: { ...NAMES.statuses, done: "Shipped" }, labels: NAMES.labels };
    expect((await s.req("PUT", "/api/github-issues/mapping", HOST, body)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await s.req("PUT", "/api/github-issues/mapping", UI, body)).statusCode).toBe(200);
    expect(s.config.githubIssues.statusPrefix).toBe("wf: "); expect(s.config.linear.statuses.done).toBe("Shipped");
    expect((await s.req("PUT", "/api/github-issues/mapping", UI, { statusPrefix: "" })).statusCode).toBe(400);
  });
  it("switches to GitHub from another tracker, not while jobs are active; and the Linear key route refuses", async () => {
    const s = setup();
    expect((await s.req("PUT", "/api/settings/tracker", UI, { tracker: "linear" })).statusCode).toBe(200);
    expect((await s.req("PUT", "/api/settings/tracker", UI, { tracker: "github" })).statusCode).toBe(200);
    expect(s.config.factory.tracker).toBe("github");
    s.db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    enqueue(s.db, { projectId: "p", externalId: "x", externalKey: "web-app-1" });
    expect((await s.req("PUT", "/api/settings/tracker", UI, { tracker: "jira" })).statusCode).toBe(409);
  });
});
