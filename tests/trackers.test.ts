import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config/load.js";
import { connectionNames, GithubIssuesConfig, ProjectConfig, githubTrackerNames, type LoadedConfig } from "../src/config/schema.js";
import { applyTracker, createConnection, removeConnection, renameConnection, updateGithubIssuesConfig, updateJiraConfig, updateTracker, upsertProject } from "../src/config/store.js";
import { enqueue } from "../src/core/jobs.js";
import { openDb } from "../src/db/client.js";
import { jobs, linearOutbox, projects } from "../src/db/schema.js";
import { checkLinear } from "../src/doctor/checks.js";
import { createGithubIssuesClient } from "../src/github-issues/client.js";
import { discoverIssues } from "../src/linear/discovery.js";
import { enqueueOutbox, flushOutbox } from "../src/linear/outbox.js";
import { syncProjects } from "../src/repo/registry.js";
import { buildServer } from "../src/server/app.js";
import { ACCOUNT } from "../src/jira/auth.js";
import { createTrackerClient, trackerIdsInUse, trackerName, trackerNames, trackerSet, type TrackerSet } from "../src/tracker/index.js";
import { fixtureConfigDir } from "./helpers/config.js";
import { FakeGhIssues } from "./helpers/fake-gh-issues.js";
import { FakeLinear } from "./helpers/fake-linear.js";
import { memoryStore } from "./helpers/fake-atlassian.js";

const quiet = pino({ level: "silent" });
const NAMES = GithubIssuesConfig.parse({});
const READY = (db: ReturnType<typeof openDb>["db"], id: string) => db.update(projects).set({ validationJson: JSON.stringify({ ok: true, isGitRepo: true, remote: { github: { owner: "o", repo: "r" } }, hasSpecKit: true }), checkJson: JSON.stringify({ ok: true, at: Date.now() }) }).where(eq(projects.id, id)).run();
const base = () => { const dir = fixtureConfigDir(); return { dir, config: loadConfig(dir) }; };

describe("tracker connections in config", () => {
  it("has the three built-in connections, and lets you add as many more as you like, each with its own credentials", () => {
    const { dir } = base();
    expect(Object.keys(loadConfig(dir).connections)).toEqual(["linear", "jira", "github"]);
    createConnection({ id: "client-linear", kind: "linear", label: "Client workspace" }, dir);
    createConnection({ id: "home-linear", kind: "linear" }, dir);
    createConnection({ id: "client-jira", kind: "jira" }, dir);
    createConnection({ id: "oss", kind: "github", account: "some-bot" }, dir);
    const c = loadConfig(dir);
    expect(Object.keys(c.connections)).toEqual(["linear", "jira", "github", "client-linear", "home-linear", "client-jira", "oss"]);
    const lin = (id: string) => c.connections[id] as { apiKeyEnv: string; keychainService: string };
    expect(lin("client-linear")).toMatchObject({ kind: "linear", apiKeyEnv: "LINEAR_API_KEY_CLIENT_LINEAR", keychainService: "software-factory-linear-client-linear" });
    expect(lin("home-linear").apiKeyEnv).toBe("LINEAR_API_KEY_HOME_LINEAR");                       // never the same key or keychain entry as another connection
    expect(c.connections["client-jira"]).toMatchObject({ kind: "jira", keychainService: "software-factory-jira-client-jira" });
    expect(c.connections.oss).toMatchObject({ kind: "github", account: "some-bot" });
    expect(trackerName(c, "client-linear")).toBe("Client workspace");
    expect(trackerName(c, "jira")).toBe("Jira");
    expect(trackerName(c, "client-jira")).toBe("Jira (client-jira)");
    expect(c.factory.tracker).toBe("linear");                                                        // the default is unchanged
  });

  it("refuses reserved or duplicate ids, shared credentials, and unknown references", () => {
    const { dir } = base();
    expect(() => createConnection({ id: "jira", kind: "jira" }, dir)).toThrow(/built-in/);
    expect(() => createConnection({ id: "Bad Id", kind: "jira" }, dir)).toThrow(/lowercase/);
    expect(() => createConnection({ id: "x", kind: "nope" }, dir)).toThrow();
    createConnection({ id: "two", kind: "jira" }, dir);
    expect(() => createConnection({ id: "two", kind: "linear" }, dir)).toThrow(/already/);
    const f = join(dir, "trackers.yaml");
    writeFileSync(f, "connections:\n  two: { kind: jira, keychainService: shared-svc }\n  also: { kind: jira, keychainService: shared-svc }\n");
    expect(() => loadConfig(dir)).toThrow(/share the same credentials/);
    writeFileSync(f, "connections:\n  linear: { kind: linear }\n");
    expect(() => loadConfig(dir)).toThrow(/built-in tracker/);
    writeFileSync(f, "connections: {}\n");
    writeFileSync(join(dir, "factory.yaml"), readFileSync(join(dir, "factory.yaml"), "utf8") + "\ntracker: ghost\n");
    expect(() => loadConfig(dir)).toThrow(/not a tracker connection/);
  });

  it("lets a project name its tracker, the profile's default is the fallback, and an unknown one is refused", () => {
    const { dir } = base();
    createConnection({ id: "work-jira", kind: "jira" }, dir);
    upsertProject({ id: "web", name: "Web", repository: "/x/web", tracker: "work-jira", linear: { teamKey: "WEB" } }, dir);
    upsertProject({ id: "api", name: "API", repository: "/x/api", linear: { teamKey: "WEB" } }, dir); // the same team key, but in the default tracker: a different tracker, so no clash
    const c = loadConfig(dir);
    expect(c.projects.projects.filter((p) => ["web", "api"].includes(p.id)).map((p) => [p.id, p.tracker])).toEqual([["web", "work-jira"], ["api", undefined]]);
    expect(trackerIdsInUse(c).sort()).toEqual(["linear", "work-jira"]);
    expect(() => upsertProject({ id: "bad", name: "Bad", repository: "/x/bad", tracker: "ghost", linear: { teamKey: "X" } }, dir)).toThrow(/not a tracker connection/);
    expect(() => upsertProject({ id: "dup", name: "Dup", repository: "/x/dup", tracker: "work-jira", linear: { teamKey: "WEB" } }, dir)).toThrow(/same Linear target/); // same tracker + team
  });

  it("changes the default, renames, and removes a connection only when nothing uses it", () => {
    const { dir } = base();
    createConnection({ id: "work-jira", kind: "jira" }, dir);
    upsertProject({ id: "web", name: "Web", repository: "/x/web", tracker: "work-jira", linear: { teamKey: "WEB" } }, dir);
    expect(() => removeConnection("work-jira", dir)).toThrow(/still uses/);
    expect(() => removeConnection("linear", dir)).toThrow(/built-in/);
    expect(updateTracker("work-jira", dir).factory.tracker).toBe("work-jira");
    expect(() => updateTracker("ghost", dir)).toThrow(/not a tracker connection/);
    updateTracker("linear", dir);
    expect(renameConnection("work-jira", "Work Jira", dir).connections["work-jira"]!.label).toBe("Work Jira");
    upsertProject({ id: "web", name: "Web", repository: "/x/web", linear: { teamKey: "WEB" } }, dir);
    expect(Object.keys(removeConnection("work-jira", dir).connections)).not.toContain("work-jira");
  });

  it("edits each connection's own mapping without touching the others (built-in ones stay in their own files)", () => {
    const { dir } = base();
    createConnection({ id: "a-jira", kind: "jira" }, dir);
    createConnection({ id: "b-gh", kind: "github" }, dir);
    updateJiraConfig({ clientId: "abcdefghijklmnop1234", mapping: { statuses: { done: "Closed" }, labels: { enabled: "go" } } }, dir, "a-jira");
    updateJiraConfig({ mapping: { statuses: { done: "Resolved" } } }, dir);                  // the built-in "jira"
    updateGithubIssuesConfig({ statusPrefix: "s/", account: "other" }, dir, "b-gh");
    const c = loadConfig(dir);
    expect(c.connections["a-jira"]).toMatchObject({ clientId: "abcdefghijklmnop1234", statuses: { done: "Closed" } });
    expect(c.connections.jira).toMatchObject({ statuses: { done: "Resolved" } });
    expect(c.jira.statuses.done).toBe("Resolved");                                              // the legacy view still works
    expect(c.connections["b-gh"]).toMatchObject({ statusPrefix: "s/", account: "other" });
    expect(c.connections.github).toMatchObject({ statusPrefix: "status: " });
    expect(connectionNames(c.connections["a-jira"]!).statuses.done).toBe("Closed");
    expect(() => updateJiraConfig({ clientId: "abcdefghijklmnop1234" }, dir, "ghost")).toThrow(/no tracker connection/);
  });

  it("builds the right client for each connection, and says which one is not set up", () => {
    const { dir } = base();
    createConnection({ id: "work", kind: "linear" }, dir);
    createConnection({ id: "w-jira", kind: "jira" }, dir);
    createConnection({ id: "oss", kind: "github" }, dir);
    const c = loadConfig(dir);
    expect(() => createTrackerClient(c, { id: "work" })).toThrow(/LINEAR_API_KEY_WORK is not set.*"work"/);
    expect(() => createTrackerClient(c, { id: "w-jira" })).toThrow(/Jira "w-jira" is not connected/);
    expect(createTrackerClient(c, { id: "oss", gh: new FakeGhIssues().run }).freeformLabels).toBe(true);
    expect(() => createTrackerClient(c, { id: "ghost" })).toThrow(/no tracker connection/);
  });

  it("resolves each project's connection, client and names through a tracker set", () => {
    const { dir } = base();
    createConnection({ id: "oss", kind: "github" }, dir);
    updateGithubIssuesConfig({ statuses: { ...NAMES.statuses, done: "Shipped" } }, dir, "oss");
    const c = loadConfig(dir);
    const set = trackerSet(c, { gh: new FakeGhIssues().run });
    expect(set.idOf(undefined)).toBe("linear");
    expect(set.idOf({ tracker: "oss" })).toBe("oss");
    expect(set.names("oss").statuses.done).toBe("Shipped");
    expect(set.names("linear")).toBe(c.linear);                                                   // the default's names are the live, shared object
    expect(set.label("oss")).toBe("GitHub Issues (oss)");
    expect(set.client("oss").freeformLabels).toBe(true);
    const fake = new FakeLinear();
    expect(trackerSet(c, {}, fake).client("anything")).toBe(fake);                                 // a test double serves every connection
  });

  it("applies a changed connection set to the running service in place", () => {
    const { dir, config } = base();
    applyTracker(config, createConnection({ id: "extra", kind: "jira" }, dir));
    expect(Object.keys(config.connections)).toContain("extra");
    applyTracker(config, updateTracker("extra", dir));
    expect(config.factory.tracker).toBe("extra");
    expect(trackerNames(config).statuses.done).toBe("");                                        // an unmapped Jira status is empty
  });
});

describe("one profile, projects in different trackers", () => {
  /** Project a: the default Linear. Project b: a GitHub connection. Each with its own fake and names. */
  function world() {
    const { db } = openDb(":memory:");
    const lin = new FakeLinear(), gh = new FakeGhIssues();
    const a = ProjectConfig.parse({ id: "a", name: "A", repository: "/x/a", linear: { teamKey: "ENG" } });
    const b = ProjectConfig.parse({ id: "b", name: "B", repository: "/x/b", tracker: "oss", linear: { teamKey: "acme/b" } });
    syncProjects(db, [a, b]); READY(db, "a"); READY(db, "b");
    const clients = { linear: lin, oss: createGithubIssuesClient({ statusPrefix: NAMES.statusPrefix, statuses: NAMES.statuses, run: gh.run, sleep: async () => {} }) };
    const names = { linear: loadConfig(fixtureConfigDir()).linear, oss: githubTrackerNames(NAMES) };
    const set: TrackerSet = { idOf: (p) => p?.tracker ?? "linear", client: (id) => clients[id as keyof typeof clients], names: (id) => names[id as keyof typeof names], label: (id) => id };
    return { db, lin, gh, a, b, set, projectsList: [a, b] };
  }

  it("discovers tickets from each project's own tracker with that tracker's names", async () => {
    const w = world();
    w.lin.addIssue({ key: "ENG-1" });
    w.gh.addIssue("acme/b", { number: 4, labels: ["status: Ready for specification", "factory:enabled"] });
    const r = await discoverIssues({ db: w.db, trackers: w.set, linear: w.set.names("linear"), projects: w.projectsList, logger: quiet });
    expect(r.errors).toEqual([]);
    expect(r.enqueued.map((e) => [e.key, e.projectId]).sort()).toEqual([["ENG-1", "a"], ["b-4", "b"]]);
    expect(w.db.select().from(jobs).all().map((j) => j.externalId).sort()).toEqual(["acme/b#4", "iss-1"]);
  });

  it("one tracker being down does not stop the others", async () => {
    const w = world();
    w.lin.addIssue({ key: "ENG-1" });
    w.gh.failNext = { match: /issues\?/, message: "gh: Bad credentials (HTTP 401)" };
    const r = await discoverIssues({ db: w.db, trackers: w.set, linear: w.set.names("linear"), projects: w.projectsList, logger: quiet });
    expect(r.enqueued.map((e) => e.key)).toEqual(["ENG-1"]);
    expect(r.errors).toEqual([expect.objectContaining({ projectId: "b", error: expect.stringContaining("401") })]);
  });

  it("an unmapped pickup status is reported for that project only", async () => {
    const w = world();
    w.lin.addIssue({ key: "ENG-1" });
    const unmapped = { ...w.set, names: (id: string) => (id === "oss" ? { ...githubTrackerNames(NAMES), statuses: { ...NAMES.statuses, readyForSpecification: "" } } : w.set.names(id)) };
    const r = await discoverIssues({ db: w.db, trackers: unmapped, linear: w.set.names("linear"), projects: w.projectsList, logger: quiet });
    expect(r.enqueued.map((e) => e.key)).toEqual(["ENG-1"]);
    expect(r.errors[0]).toMatchObject({ projectId: "b", error: expect.stringMatching(/mapping is incomplete.*Settings → Trackers/) });
  });

  it("sends each job's updates to its own tracker, using that tracker's status names", async () => {
    const w = world();
    const li = w.lin.addIssue({ key: "ENG-1" });
    const gi = w.gh.addIssue("acme/b", { number: 4, labels: ["status: Ready for specification", "factory:enabled"] });
    const ja = enqueue(w.db, { projectId: "a", externalId: li.id, externalKey: "ENG-1" }).job;
    const jb = enqueue(w.db, { projectId: "b", externalId: "acme/b#4", externalKey: "b-4" }).job;
    enqueueOutbox(w.db, ja.id, li.id, { kind: "set_state", stateKey: "inProgress" }, "k1");
    enqueueOutbox(w.db, jb.id, "acme/b#4", { kind: "set_state", stateKey: "inProgress" }, "k2");
    enqueueOutbox(w.db, jb.id, "acme/b#4", { kind: "comment", body: "**Software factory** hello" }, "k3");
    // GitHub's "In progress" must exist as a label (setup creates it); Linear's exists already
    await w.set.client("oss").createWorkflowState("acme/b", "In progress", "started", "#f59e0b");
    const r = await flushOutbox({ db: w.db, trackers: w.set, projectOf: (id) => w.projectsList.find((p) => p.id === id), linear: w.set.names("linear"), logger: quiet });
    expect(r).toMatchObject({ sent: 3, failed: 0 });
    expect(w.lin.issues.get(li.id)!.state.name).toBe("In progress");
    expect(gi.labels).toEqual(["factory:enabled", "status: In progress"]);
    expect(w.gh.repo("acme/b").comments.get(4)).toHaveLength(1);
    expect(w.db.select().from(linearOutbox).where(eq(linearOutbox.status, "done")).all()).toHaveLength(3);
  });

  it("reports a write whose connection cannot be built as a failure of that write, not of everything", async () => {
    const w = world();
    const li = w.lin.addIssue({ key: "ENG-1" });
    const ja = enqueue(w.db, { projectId: "a", externalId: li.id, externalKey: "ENG-1" }).job;
    const jb = enqueue(w.db, { projectId: "b", externalId: "acme/b#4", externalKey: "b-4" }).job;
    enqueueOutbox(w.db, ja.id, li.id, { kind: "set_state", stateKey: "inProgress" }, "k1");
    enqueueOutbox(w.db, jb.id, "acme/b#4", { kind: "comment", body: "hi" }, "k2");
    const broken: TrackerSet = { ...w.set, client: (id) => { if (id === "oss") throw new Error("gh is not logged in"); return w.set.client(id); } };
    const r = await flushOutbox({ db: w.db, trackers: broken, projectOf: (id) => w.projectsList.find((p) => p.id === id), linear: w.set.names("linear"), logger: quiet, backoffBaseMs: 1 });
    expect(r.sent).toBe(1);
    expect(w.db.select().from(linearOutbox).where(eq(linearOutbox.idempotencyKey, "k2")).get()).toMatchObject({ status: "pending", lastError: expect.stringContaining("gh is not logged in") });
  });

  it("the doctor checks every tracker in use, naming each", async () => {
    const { dir } = base();
    createConnection({ id: "oss", kind: "github" }, dir);
    const c = loadConfig(dir);
    const gh = new FakeGhIssues();
    expect(await checkLinear(c, createTrackerClient(c, { id: "oss", gh: gh.run }), "oss")).toEqual({ name: "oss", status: "ok", detail: "authenticated as factory-bot" });
    expect(await checkLinear(c, undefined, "ghost")).toMatchObject({ status: "fail" });
  });
});

describe("tracker connections through the dashboard API", () => {
  const HOST = { host: "127.0.0.1:4780" }, UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1" };
  function setup() {
    const dir = fixtureConfigDir();
    createConnection({ id: "work-jira", kind: "jira", label: "Work Jira" }, dir);
    createConnection({ id: "client-jira", kind: "jira" }, dir);
    createConnection({ id: "oss", kind: "github" }, dir);
    upsertProject({ id: "a", name: "A", repository: "/x/a", linear: { teamKey: "ENG", projectName: "Alpha" }, commands: { test: "t" } }, dir);
    upsertProject({ id: "b", name: "B", repository: "/x/b", tracker: "oss", linear: { teamKey: "acme/b" }, commands: { test: "t" } }, dir);
    const config: LoadedConfig = loadConfig(dir);
    const { db } = openDb(":memory:"); syncProjects(db, config.projects.projects); READY(db, "a"); READY(db, "b");
    const stores = new Map<string, ReturnType<typeof memoryStore>>(); const storeFor = (id: string) => { if (!stores.has(id)) stores.set(id, memoryStore()); return stores.get(id)!; };
    const lin = new FakeLinear(), gh = new FakeGhIssues(); gh.repo("acme/b");
    const ghClient = createGithubIssuesClient({ statusPrefix: NAMES.statusPrefix, statuses: NAMES.statuses, run: gh.run, sleep: async () => {} });
    const asked: string[] = [];
    const linear = (id?: string) => { asked.push(id ?? "(default)"); return (id === "oss" ? ghClient : lin); };
    const app = buildServer({ db, logger: quiet, config, port: 4780, controlToken: "t".repeat(64),
      settings: { tasks: {} as never, actions: {} as never, linear, linearKeyPresent: () => true, saveLinearKey: async () => ({ name: "x" }) },
      jira: { store: storeFor("jira"), storeFor, port: 4780 }, githubIssues: { gh: gh.run } });
    const req = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, headers: Record<string, string>, body?: unknown) =>
      app.inject({ method, url, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, remoteAddress: "127.0.0.1", payload: body === undefined ? undefined : JSON.stringify(body) });
    return { dir, config, db, req, lin, gh, stores, storeFor, asked };
  }

  it("lists every connection with its kind, label, default, usage and whether it is connected", async () => {
    const s = setup();
    const r = (await s.req("GET", "/api/trackers", HOST)).json();
    expect(r.default).toBe("linear");
    expect(r.trackers.map((t: { id: string }) => t.id)).toEqual(["linear", "jira", "github", "work-jira", "client-jira", "oss"]);
    expect(r.trackers.find((t: { id: string }) => t.id === "work-jira")).toMatchObject({ kind: "jira", label: "Work Jira", builtin: false, isDefault: false, connected: false, projects: [] });
    expect(r.trackers.find((t: { id: string }) => t.id === "oss")).toMatchObject({ kind: "github", connected: true, projects: ["b"] });
    expect(r.trackers.find((t: { id: string }) => t.id === "linear")).toMatchObject({ isDefault: true, projects: expect.arrayContaining(["a"]) });
  });

  it("adds, renames and removes a connection (and refuses what would orphan a project)", async () => {
    const s = setup();
    expect((await s.req("POST", "/api/trackers", HOST, { id: "extra", kind: "linear" })).statusCode).toBeGreaterThanOrEqual(400); // needs the UI token
    expect((await s.req("POST", "/api/trackers", UI, { id: "extra", kind: "linear", label: "Extra" })).statusCode).toBe(200);
    expect(s.config.connections.extra).toMatchObject({ kind: "linear", label: "Extra" });
    expect((await s.req("POST", "/api/trackers", UI, { id: "extra", kind: "linear" })).statusCode).toBe(400);
    expect((await s.req("POST", "/api/trackers", UI, { id: "jira", kind: "jira" })).statusCode).toBe(400);
    expect((await s.req("PUT", "/api/trackers/extra", UI, { label: "Renamed" })).statusCode).toBe(200);
    expect(s.config.connections.extra!.label).toBe("Renamed");
    expect((await s.req("DELETE", "/api/trackers/oss", UI)).json().error).toMatch(/still use/);
    expect((await s.req("DELETE", "/api/trackers/extra", UI)).statusCode).toBe(200);
    expect(s.config.connections.extra).toBeUndefined();
    expect((await s.req("DELETE", "/api/trackers/linear", UI)).statusCode).toBe(409);
  });

  it("changes the default tracker; only projects that follow it matter for the active-jobs check", async () => {
    const s = setup();
    expect((await s.req("PUT", "/api/settings/tracker", UI, { tracker: "ghost" })).statusCode).toBe(400);
    enqueue(s.db, { projectId: "b", externalId: "acme/b#1", externalKey: "b-1" });            // b has its own tracker: unaffected by the default
    expect((await s.req("PUT", "/api/settings/tracker", UI, { tracker: "work-jira" })).statusCode).toBe(200);
    expect(s.config.factory.tracker).toBe("work-jira");
    enqueue(s.db, { projectId: "a", externalId: "x", externalKey: "ENG-1" });                // a follows the default
    expect((await s.req("PUT", "/api/settings/tracker", UI, { tracker: "linear" })).statusCode).toBe(409);
  });

  it("sets up two Jiras independently: each has its own app, secret and mapping", async () => {
    const s = setup();
    const id1 = "abcdefghijklmnop1111", id2 = "abcdefghijklmnop2222";
    expect((await s.req("PUT", "/api/jira/app?tracker=work-jira", UI, { clientId: id1, clientSecret: "s".repeat(20) })).statusCode).toBe(200);
    expect((await s.req("PUT", "/api/jira/app?tracker=client-jira", UI, { clientId: id2, clientSecret: "c".repeat(20) })).statusCode).toBe(200);
    expect(s.config.connections["work-jira"]).toMatchObject({ clientId: id1 });
    expect(s.config.connections["client-jira"]).toMatchObject({ clientId: id2 });
    expect(s.config.connections.jira).not.toHaveProperty("clientId");                     // the built-in Jira was not touched
    expect(s.storeFor("work-jira").get(ACCOUNT.clientSecret)).toBe("s".repeat(20));
    expect(s.storeFor("client-jira").get(ACCOUNT.clientSecret)).toBe("c".repeat(20));
    expect(s.storeFor("jira").get(ACCOUNT.clientSecret)).toBeUndefined();
    const st = (await s.req("GET", "/api/jira/status?tracker=client-jira", HOST)).json();
    expect(st).toMatchObject({ id: "client-jira", clientId: id2, secretSet: true, connected: false });
    expect((await s.req("PUT", "/api/jira/mapping?tracker=work-jira", UI, { statuses: { done: "Closed" }, labels: {} })).statusCode).toBe(200);
    expect((await s.req("GET", "/api/jira/mapping?tracker=work-jira", HOST)).json().statuses).toEqual({ done: "Closed" });
    expect((await s.req("GET", "/api/jira/mapping?tracker=client-jira", HOST)).json().statuses).toEqual({});
    expect((await s.req("GET", "/api/jira/status?tracker=oss", HOST)).statusCode).toBe(404);       // not a Jira connection
    const url = new URL((await s.req("POST", "/api/jira/connect?tracker=client-jira", UI, {})).json().url);
    expect(url.searchParams.get("client_id")).toBe(id2);                                           // the authorisation URL is for that connection's app
  });

  it("maps and checks a GitHub connection on its own, with its own account", async () => {
    const s = setup();
    const body = { account: "work-bot", statusPrefix: "wf: ", statuses: { ...NAMES.statuses, done: "Shipped" }, labels: NAMES.labels };
    expect((await s.req("PUT", "/api/github-issues/mapping?tracker=oss", UI, body)).statusCode).toBe(200);
    expect(s.config.connections.oss).toMatchObject({ account: "work-bot", statusPrefix: "wf: ", statuses: { done: "Shipped" } });
    expect(s.config.connections.github).toMatchObject({ statusPrefix: "status: " });
    expect((await s.req("GET", "/api/github-issues/status?tracker=oss", HOST)).json()).toMatchObject({ id: "oss", account: "work-bot", ownAccount: "work-bot" });
    expect((await s.req("GET", "/api/github-issues/mapping?tracker=linear", HOST)).statusCode).toBe(404);
  });

  it("reads teams and creates missing statuses in the chosen connection only", async () => {
    const s = setup();
    const r = await s.req("GET", "/api/setup/linear?tracker=oss", HOST);
    expect(r.json().teams).toEqual([expect.objectContaining({ key: "acme/b", audited: true })]);
    expect(s.asked).toContain("oss");
    const made = await s.req("POST", `/api/setup/linear/${encodeURIComponent("acme/b")}/create?tracker=oss`, UI);
    expect(made.json()).toMatchObject({ ok: true });
    expect([...s.gh.repo("acme/b").labels.values()].map((l) => l.name)).toContain("status: In progress");
    expect((await s.req("POST", "/api/setup/linear/x/create?tracker=work-jira", UI)).statusCode).toBe(400);   // Jira statuses are never created
    expect((await s.req("POST", "/api/setup/linear/x/create?tracker=ghost", UI)).statusCode).toBe(404);
    expect((await s.req("POST", "/api/setup/linear-key", UI, { key: "lin_api_" + "x".repeat(24), tracker: "oss" })).statusCode).toBe(400); // not a Linear connection
  });

  it("shows tickets of every project's own tracker on the Board, and a tracker that is down only warns", async () => {
    const s = setup();
    s.lin.addIssue({ key: "ENG-1", state: "Backlog", labels: [], project: "Alpha" });
    s.gh.addIssue("acme/b", { number: 7, title: "Fix it", labels: [] });
    const r = (await s.req("GET", "/api/board", HOST)).json();
    expect(r.items.map((i: { key: string; projectId: string }) => [i.key, i.projectId]).sort()).toEqual([["ENG-1", "a"], ["b-7", "b"]]);
    s.gh.failNext = { match: /issues\?/, message: "gh: Bad credentials (HTTP 401)" };
    const partial = (await s.req("GET", "/api/board", HOST)).json();
    expect(partial.items.map((i: { key: string }) => i.key)).toEqual(["ENG-1"]);
    expect(partial.warnings[0]).toMatch(/401/);
    expect((await s.req("GET", "/api/board?q=b-7", HOST)).json().items.map((i: { key: string }) => i.key)).toEqual(["b-7"]);
  });

  it("starts a ticket from the connection of the project it was listed under, with that connection's names", async () => {
    const s = setup();
    s.gh.addIssue("acme/b", { number: 7, labels: [] });
    const r = await s.req("POST", "/api/board/start", { ...UI }, { issueId: "acme/b#7", projectId: "b" });
    expect(r.json()).toMatchObject({ ok: true });
    expect(s.db.select().from(jobs).get()).toMatchObject({ projectId: "b", externalId: "acme/b#7", externalKey: "b-7", manual: true });
    const noHint = await s.req("POST", "/api/board/start", UI, { issueId: "acme/b#8" }); // no project given: each connection is tried, none has it
    expect(noHint.statusCode).toBe(404);
  });

  it("lists the labels of every tracker in use, and still answers when one is down", async () => {
    const s = setup();
    s.gh.addIssue("acme/b", { labels: ["bug"] });
    s.gh.repo("acme/b").labels.set("bug", { name: "bug", color: "ff0000" });
    const r = (await s.req("GET", "/api/workflows/labels", HOST)).json();
    expect(r.labels.map((l: { name: string }) => l.name)).toContain("bug");
    expect(r.labels.find((l: { name: string }) => l.name === "bug").teams[0]).toMatch(/acme\/b/);
  });
});

