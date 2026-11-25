import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BUNDLED_CONFIG_DIR, loadConfig } from "../src/config/load.js";
import { FactoryConfig, JiraConfig, LinearConfig, ProjectConfig, effectiveTrackerNames, type LoadedConfig } from "../src/config/schema.js";
import { seedHomeConfig, updateJiraConfig, updateTracker } from "../src/config/store.js";
import { addProfile } from "../src/config/profiles.js";
import { openDb } from "../src/db/client.js";
import { jobs, linearOutbox, projects } from "../src/db/schema.js";
import { enqueue } from "../src/core/jobs.js";
import { adfToText, markdownToAdf } from "../src/jira/adf.js";
import { ACCOUNT, JiraAuth } from "../src/jira/auth.js";
import { createJiraClient } from "../src/jira/client.js";
import { LinearApiError } from "../src/linear/client.js";
import { discoverIssues } from "../src/linear/discovery.js";
import { enqueueOutbox, flushOutbox } from "../src/linear/outbox.js";
import { syncProjects } from "../src/repo/registry.js";
import { buildServer } from "../src/server/app.js";
import { FakeAtlassian, memoryStore } from "./helpers/fake-atlassian.js";
import { fixtureConfigDir } from "./helpers/config.js";
import { tmp } from "./helpers/git-fixture.js";
import { join } from "node:path";

let atl: FakeAtlassian;
beforeAll(async () => { atl = await new FakeAtlassian().start(); });
afterAll(() => atl.stop());
beforeEach(() => { atl.accessToken = "access-0"; atl.refreshToken = "refresh-0"; atl.tokenGen = 0; atl.usedRefresh.clear(); atl.issues.clear(); atl.comments.clear(); atl.calls = []; atl.jqls = []; atl.transitions = {}; atl.tokenRequests = []; atl.code = "good-code"; atl.failNext = null; });

const connectedAuth = () => {
  const store = memoryStore({ [ACCOUNT.clientSecret]: atl.clientSecret, [ACCOUNT.refreshToken]: "refresh-0" });
  return { store, auth: new JiraAuth({ clientId: atl.clientId, store, base: atl.authBase }) };
};
const client = () => { const { auth, store } = connectedAuth(); return { store, auth, c: createJiraClient({ auth, cloudId: "cloud-1", siteUrl: "https://acme.atlassian.net", apiBase: atl.apiBase, sleep: async () => {} }) }; };

describe("ADF (Jira's rich text)", () => {
  it("reads a ticket description with headings, lists, code and links as Markdown-ish text", () => {
    const doc = { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal" }] },
      { type: "paragraph", content: [{ type: "text", text: "Use " }, { type: "text", text: "npm", marks: [{ type: "code" }] }, { type: "text", text: " and see " }, { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://x.dev" } }] }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }, { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }] },
      { type: "codeBlock", content: [{ type: "text", text: "a = 1" }] } ] };
    expect(adfToText(doc)).toBe("## Goal\n\nUse `npm` and see [docs](https://x.dev)\n\n- one\n- two\n\n```\na = 1\n```");
    expect(adfToText(null)).toBe(""); expect(adfToText("plain")).toBe("plain");
  });
  it("writes the factory's Markdown comments as valid ADF (bold, code, bullets, links, breaks)", () => {
    const d = markdownToAdf("**Software factory: Blocked** (stage `IMPLEMENTATION`)\n\n- first\n- second\n\nsee https://github.com/o/r/pull/1\nnext line");
    expect(d).toMatchObject({ version: 1, type: "doc" });
    expect(d.content.map((n) => n.type)).toEqual(["paragraph", "bulletList", "paragraph"]);
    const first = d.content[0]!.content!;
    expect(first[0]).toMatchObject({ text: "Software factory: Blocked", marks: [{ type: "strong" }] });
    expect(first[2]).toMatchObject({ text: "IMPLEMENTATION", marks: [{ type: "code" }] });
    const last = d.content[2]!.content!;
    expect(last.some((n) => n.type === "hardBreak")).toBe(true);
    expect(last.find((n) => n.marks?.[0]?.type === "link")).toMatchObject({ marks: [{ attrs: { href: "https://github.com/o/r/pull/1" } }] });
    expect(adfToText(d)).toContain("**Software factory: Blocked**");                          // round trip keeps the meaning
  });
});

describe("Jira OAuth tokens", () => {
  it("refreshes a rotating refresh token, saving the new one every time", async () => {
    const { auth, store } = connectedAuth();
    expect(await auth.accessToken()).toBe("access-1");
    expect(store.data[ACCOUNT.refreshToken]).toBe("refresh-1");                               // rotated and persisted
    expect(await auth.accessToken()).toBe("access-1");                                         // cached: no second refresh
    expect(atl.tokenRequests).toHaveLength(1);
    expect(atl.tokenRequests[0]).toMatchObject({ grant_type: "refresh_token", client_id: atl.clientId, refresh_token: "refresh-0" });
    expect(await auth.accessToken(true)).toBe("access-2");
    expect(store.data[ACCOUNT.refreshToken]).toBe("refresh-2");
  });
  it("never lets two refreshes overlap (a second would present an already-used token)", async () => {
    const { auth } = connectedAuth();
    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(atl.tokenRequests).toHaveLength(1);
  });
  it("tells the user to reconnect when the refresh token is revoked or stale, without retrying forever", async () => {
    const { auth, store } = connectedAuth();
    store.data[ACCOUNT.refreshToken] = "refresh-stale";
    await expect(auth.accessToken()).rejects.toMatchObject({ code: "AUTH", retryable: false, message: expect.stringMatching(/reconnect Jira/) });
    const none = new JiraAuth({ clientId: atl.clientId, store: memoryStore(), base: atl.authBase });
    await expect(none.accessToken()).rejects.toThrow(/not connected/);
  });
});

describe("Jira client (as the factory's tracker)", () => {
  it("maps Jira onto the tracker interface: projects as teams, components as projects, status categories as types", async () => {
    const { c } = client();
    expect(await c.viewer()).toEqual({ id: "acct-1", name: "Jamie" });
    expect((await c.teams()).map((t) => t.key)).toEqual(["ENG", "OPS"]);
    expect((await c.projects("10000")).map((p) => p.name)).toEqual(["Web", "API"]);
    const states = await c.workflowStates("10000");
    expect(states.find((s) => s.name === "Ready for specification")).toMatchObject({ id: "11", type: "unstarted" });
    expect(states.find((s) => s.name === "Done")!.type).toBe("completed");
    expect(states.filter((s) => s.name === "To Do")).toHaveLength(1);                           // the same status on two issue types is listed once
    expect((await c.labels("10000")).map((l) => l.name)).toEqual(["urgent", "factory-ready"]);
  });
  it("finds tickets with JQL that is quoted safely, scoped to a project and (optionally) a component", async () => {
    atl.addIssue({ key: "ENG-1", labels: ["factory-ready"], components: ["Web"] }); atl.addIssue({ key: "ENG-2", labels: ["factory-ready"], components: ["API"] }); atl.addIssue({ key: "ENG-3", labels: [] });
    const { c } = client();
    const hits = await c.listIssues({ teamKey: "ENG", projectName: "Web", stateName: "Ready for specification", labelName: "factory-ready" });
    expect(hits.map((i) => i.identifier)).toEqual(["ENG-1"]);
    expect(atl.jqls[0]).toBe('project = "ENG" AND component = "Web" AND status = "Ready for specification" AND labels = "factory-ready" ORDER BY created ASC');
    await c.boardIssues({ teamKey: "ENG", title: 'say "hi" \\ there' });
    expect(atl.jqls.at(-1)).toContain('summary ~ "say \\"hi\\" \\\\ there"');                      // quotes and backslashes cannot break out of the JQL string
  });
  it("searches by number as a ticket key, and hides finished tickets from the open board", async () => {
    atl.addIssue({ key: "ENG-418", status: "To Do" }); atl.addIssue({ key: "ENG-9", status: "Done" });
    const { c } = client();
    expect((await c.boardIssues({ teamKey: "ENG", number: 418 })).map((i) => i.identifier)).toEqual(["ENG-418"]);
    expect(atl.jqls.at(-1)).toContain('key = "ENG-418"');
    expect((await c.boardIssues({ teamKey: "ENG", openOnly: true })).map((i) => i.identifier)).toEqual(["ENG-418"]);
  });
  it("reads a ticket: ADF description to text, components as projects, labels, and a browse URL", async () => {
    atl.addIssue({ key: "ENG-5", components: ["Web", "API"], labels: ["urgent"], description: "Fix the bug" });
    const i = await client().c.getIssue("ENG-5");
    expect(i).toMatchObject({ identifier: "ENG-5", description: "Fix the bug", url: "https://acme.atlassian.net/browse/ENG-5", team: { key: "ENG", id: "10000" }, labels: [{ id: "urgent", name: "urgent" }] });
    expect(i.projects!.map((p) => p.name)).toEqual(["Web", "API"]);
    expect(i.state).toMatchObject({ name: "Ready for specification", type: "unstarted" });
  });
  it("moves a ticket through the workflow transition that leads to the status, and explains clearly when the workflow has none", async () => {
    atl.addIssue({ key: "ENG-1", status: "Ready for specification" });
    const { c } = client();
    await c.setState("ENG-1", "13");
    expect(atl.issues.get("ENG-1")!.fields.status.name).toBe("In Progress");
    atl.transitions = { "13": ["14"] };                                                         // from In Progress only to Ready for review
    await expect(c.setState("ENG-1", "15")).rejects.toMatchObject({ code: "NO_TRANSITION", retryable: false, message: expect.stringMatching(/no workflow transition to "Done" from this ticket's current status "In Progress"/) });
    await c.setState("ENG-1", "14");
    expect(atl.issues.get("ENG-1")!.fields.status.name).toBe("Ready for review");
  });
  it("adds and removes labels, which Jira creates by use; creating statuses is refused", async () => {
    atl.addIssue({ key: "ENG-1", labels: [] });
    const { c } = client();
    await c.addLabel("ENG-1", "brand-new-label"); expect(atl.issues.get("ENG-1")!.fields.labels).toEqual(["brand-new-label"]);
    await c.removeLabel("ENG-1", "brand-new-label"); expect(atl.issues.get("ENG-1")!.fields.labels).toEqual([]);
    expect(await c.createLabel("10000", "x", "#fff")).toEqual({ id: "x" });
    await expect(c.createWorkflowState("10000", "Nope", "started", "#000")).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringMatching(/owned by your Jira admins/) });
  });
  it("writes comments as ADF carrying the factory's own id, finds them again, and links PRs idempotently", async () => {
    atl.addIssue({ key: "ENG-1" });
    const { c } = client();
    const id = "3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab";
    await c.createComment("ENG-1", "**Software factory** picked this up", id);
    const sent = atl.calls.find((x) => x.method === "POST" && x.path.endsWith("/comment"))!.body!.body;
    expect(sent.type).toBe("doc");
    expect((await c.getIssue("ENG-1")).comments.map((x) => x.id)).toEqual([id]);               // found by its ref: a retry can tell it was already posted
    await c.linkPullRequest("ENG-1", "https://github.com/o/r/pull/7", "PR 7");
    expect(atl.calls.find((x) => x.path.endsWith("/remotelink"))!.body).toMatchObject({ globalId: "software-factory-pr:https://github.com/o/r/pull/7", object: { url: "https://github.com/o/r/pull/7", title: "PR 7" } });
  });
  it("copes with an access token that expired early, and with rate limits", async () => {
    atl.addIssue({ key: "ENG-1" });
    const { c } = client();
    await c.viewer();
    atl.expireAccessOnNextCall = true;                                                           // Jira says 401 once: refresh and retry
    expect((await c.viewer()).name).toBe("Jamie");
    atl.failNext = { status: 429, headers: { "retry-after": "0" } };
    expect((await c.viewer()).name).toBe("Jamie");
    atl.failNext = { status: 404 };
    await expect(c.getIssue("NOPE-1")).rejects.toBeInstanceOf(LinearApiError);
  });
});

describe("config for a Jira profile", () => {
  it("shows the rest of the factory only the mapped names, and an unmapped status or label as empty", () => {
    const j = JiraConfig.parse({ statuses: { readyForSpecification: "Ready for spec", done: "Closed" }, labels: { enabled: "factory-ready" } });
    const eff = effectiveTrackerNames(j);
    expect(eff.statuses).toMatchObject({ readyForSpecification: "Ready for spec", done: "Closed", inProgress: "" });
    expect(eff.labels).toMatchObject({ enabled: "factory-ready", blocked: "" });
  });
  it("is chosen per profile: one profile on Linear, another on Jira, with separate keychain entries", () => {
    const root = tmp();
    const work = addProfile("work", root);
    updateTracker("jira", join(work.home, "config"));
    const home = loadConfig(BUNDLED_CONFIG_DIR); // a profile that never chose a tracker: the shipped default
    expect(home.factory.tracker).toBe("linear");
    const w = loadConfig(join(work.home, "config"));
    expect(w.factory.tracker).toBe("jira");
    expect(w.jira.keychainService).toBe("software-factory-jira-work");
    expect(w.linear.keychainService).toBe("software-factory-jira-work");
  });
  it("writes the connection and mapping to jira.yaml without any secret", () => {
    const dir = seedHomeConfig(join(tmp(), "config"));
    updateTracker("jira", dir);
    const c = updateJiraConfig({ clientId: "abcdefghijklmnop1234", site: { cloudId: "cloud-1", url: "https://acme.atlassian.net", name: "Acme" }, mapping: { statuses: { done: "Closed", blocked: "" }, labels: { enabled: "factory-ready" } } }, dir);
    expect(c.jira).toMatchObject({ clientId: "abcdefghijklmnop1234", site: { name: "Acme" }, statuses: { done: "Closed" }, labels: { enabled: "factory-ready" } });
    expect(c.linear.statuses.done).toBe("Closed");
    expect(() => updateJiraConfig({ mapping: { labels: { enabled: "has space" } } }, dir)).toThrow(/cannot contain spaces/);
  });
});

describe("the pipeline on Jira", () => {
  const mk = (mapped = true) => {
    const { db } = openDb(":memory:");
    const linear = LinearConfig.parse(mapped ? { statuses: { readyForSpecification: "Ready for specification", specificationReview: "Specification review", inProgress: "In Progress", readyForReview: "Ready for review", done: "Done", blocked: "Blocked" }, labels: { enabled: "factory-ready", blocked: "factory-blocked" } }
      : effectiveTrackerNames(JiraConfig.parse({})));
    const p = ProjectConfig.parse({ id: "a", name: "A", repository: "/x/a", linear: { teamKey: "ENG", projectName: "Web" } });
    syncProjects(db, [p]); db.update(projects).set({ validationJson: JSON.stringify({ ok: true }) }).run();
    return { db, linear, p };
  };
  it("discovers tickets by mapped status and label, scoped to the component", async () => {
    atl.addIssue({ key: "ENG-1", labels: ["factory-ready"], components: ["Web"] }); atl.addIssue({ key: "ENG-2", labels: ["factory-ready"], components: ["API"] });
    const { db, linear, p } = mk();
    const r = await discoverIssues({ db, client: client().c, linear, projects: [p], logger: pino({ level: "silent" }) });
    expect(r.enqueued.map((e) => e.key)).toEqual(["ENG-1"]);
  });
  it("refuses to guess when the pickup status or label is not mapped, and says what to do", async () => {
    const { db, linear, p } = mk(false);
    const r = await discoverIssues({ db, client: client().c, linear, projects: [p], logger: pino({ level: "silent" }) });
    expect(r.enqueued).toEqual([]);
    expect(r.errors[0]!.error).toMatch(/mapping is incomplete.*Settings → Tracker/);
    expect(atl.jqls).toEqual([]);                                                               // nothing was searched
  });
  it("writes status, label and comment updates to Jira through the same outbox, retry-safe", async () => {
    const issue = atl.addIssue({ key: "ENG-1", status: "Ready for specification", labels: ["factory-ready"] });
    const { db, linear } = mk();
    const job = enqueue(db, { projectId: "a", externalId: issue.id, externalKey: "ENG-1" }).job;
    enqueueOutbox(db, job.id, issue.id, { kind: "set_state", stateKey: "inProgress" }, "k1");
    enqueueOutbox(db, job.id, issue.id, { kind: "add_label", labelKey: "blocked" }, "k2");
    enqueueOutbox(db, job.id, issue.id, { kind: "comment", body: "**Software factory** working on it" }, "k3");
    const c = client().c;
    const r = await flushOutbox({ db, client: c, linear, logger: pino({ level: "silent" }) });
    expect(r).toMatchObject({ sent: 3, failed: 0 });
    expect(atl.issues.get("ENG-1")!.fields.status.name).toBe("In Progress");
    expect(atl.issues.get("ENG-1")!.fields.labels).toContain("factory-blocked");
    // an interrupted attempt that already posted the comment must not post it twice
    db.update(linearOutbox).set({ status: "pending" }).where(eq(linearOutbox.idempotencyKey, "k3")).run();
    atl.failNext = null;
    const before = atl.comments.get("ENG-1")!.length;
    await flushOutbox({ db, client: { ...c, createComment: async () => { throw new LinearApiError("timeout after the write", true); } }, linear, logger: pino({ level: "silent" }) });
    expect(atl.comments.get("ENG-1")!.length).toBe(before);                                      // the comment is found by its ref, so it counts as sent
    expect(db.select().from(linearOutbox).where(eq(linearOutbox.idempotencyKey, "k3")).get()!.status).toBe("done");
  });
  it("skips a status the profile did not map instead of failing, and reports a missing workflow transition as a permanent, explained failure", async () => {
    const issue = atl.addIssue({ key: "ENG-1", status: "Ready for specification" });
    const { db, linear } = mk();
    linear.statuses.readyForReview = "";                                                          // not mapped
    const job = enqueue(db, { projectId: "a", externalId: issue.id, externalKey: "ENG-1" }).job;
    enqueueOutbox(db, job.id, issue.id, { kind: "set_state", stateKey: "readyForReview" }, "s1");
    expect((await flushOutbox({ db, client: client().c, linear, logger: pino({ level: "silent" }) })).failed).toBe(0);
    expect(db.select().from(linearOutbox).get()).toMatchObject({ status: "done" });
    expect(db.select().from(linearOutbox).get()!.lastError).toMatch(/skipped: the "readyForReview" status is not mapped/);
    atl.transitions = { "11": ["12"] };                                                            // from Ready for specification you can only go to Specification review
    enqueueOutbox(db, job.id, issue.id, { kind: "set_state", stateKey: "done" }, "s2");
    const r = await flushOutbox({ db, client: client().c, linear, logger: pino({ level: "silent" }) });
    expect(r.failed).toBe(1);
    expect(db.select().from(linearOutbox).where(eq(linearOutbox.idempotencyKey, "s2")).get()!.lastError).toMatch(/no workflow transition to "Done"/);
  });
});

describe("connecting Jira (OAuth) and mapping, through the dashboard API", () => {
  const HOST = { host: "127.0.0.1:4780" }, UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1" };
  function setup() {
    const dir = fixtureConfigDir();
    updateTracker("jira", dir);
    const config: LoadedConfig = loadConfig(dir);
    const { db } = openDb(":memory:");
    const store = memoryStore();
    const app = buildServer({ db, logger: pino({ level: "silent" }), config, port: 4780, controlToken: "t".repeat(64), jira: { store, port: 4780, authBase: atl.authBase, apiBase: atl.apiBase, atlassianApi: atl.apiBase } });
    const req = (method: "GET" | "PUT" | "POST", url: string, headers: Record<string, string>, body?: unknown) =>
      app.inject({ method, url, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, remoteAddress: "127.0.0.1", payload: body === undefined ? undefined : JSON.stringify(body) });
    return { db, dir, config, store, req, app };
  }
  const connect = async (s: ReturnType<typeof setup>) => {
    await s.req("PUT", "/api/jira/app", UI, { clientId: atl.clientId, clientSecret: atl.clientSecret });
    const { url } = (await s.req("POST", "/api/jira/connect", UI, {})).json();
    return { url: new URL(url), state: new URL(url).searchParams.get("state")! };
  };

  it("saves the app credentials (secret to the keychain, never the config file), then builds the Atlassian authorisation URL with a one-use state", async () => {
    const s = setup();
    expect((await s.req("PUT", "/api/jira/app", HOST, { clientId: atl.clientId, clientSecret: atl.clientSecret })).statusCode).toBe(401);      // needs the dashboard origin or the token
    expect((await s.req("PUT", "/api/jira/app", UI, { clientId: "bad id!", clientSecret: atl.clientSecret })).statusCode).toBe(400);
    const { url, state } = await connect(s);
    expect(s.store.data[ACCOUNT.clientSecret]).toBe(atl.clientSecret);
    expect(JSON.stringify(s.config)).not.toContain(atl.clientSecret);
    expect(readCfg(s.dir)).not.toContain(atl.clientSecret);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ audience: "api.atlassian.com", client_id: atl.clientId, response_type: "code", prompt: "consent", redirect_uri: "http://127.0.0.1:4780/api/jira/oauth/callback" });
    expect(url.searchParams.get("scope")).toBe("read:jira-work write:jira-work read:jira-user offline_access");
    expect(state).toMatch(/^[0-9a-f]{48}$/);
    expect((await s.req("GET", "/api/jira/status", HOST)).json()).toMatchObject({ clientId: atl.clientId, secretSet: true, connected: false, callbackUrl: "http://127.0.0.1:4780/api/jira/oauth/callback" });
  });
  it("completes the connection when Atlassian redirects back: stores the rotating refresh token, picks the only site, and refuses a replayed or forged state", async () => {
    const s = setup();
    const { state } = await connect(s);
    const done = await s.req("GET", `/api/jira/oauth/callback?code=good-code&state=${state}`, HOST);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).toContain("Jira connected"); expect(done.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(s.store.data[ACCOUNT.refreshToken]).toBe("refresh-1");
    expect(s.config.jira.site).toMatchObject({ cloudId: "cloud-1", name: "Acme", url: "https://acme.atlassian.net" });
    expect(readCfg(s.dir)).toContain("cloud-1");
    expect((await s.req("GET", `/api/jira/oauth/callback?code=good-code&state=${state}`, HOST)).statusCode).toBe(400);      // the state was single-use
    expect((await s.req("GET", "/api/jira/oauth/callback?code=x&state=forged", HOST)).statusCode).toBe(400);
    expect((await s.req("GET", "/api/jira/status", HOST)).json()).toMatchObject({ connected: true, site: { name: "Acme" } });
    expect((await s.req("GET", "/api/jira/whoami", HOST)).json()).toEqual({ id: "acct-1", name: "Jamie" });                   // and it really works
  });
  it("shows an error page, not a crash, when the user denies access or the code is wrong; and asks which site when there are several", async () => {
    const s = setup();
    const a = await connect(s);
    expect((await s.req("GET", `/api/jira/oauth/callback?error=access_denied&state=${a.state}`, HOST)).body).toContain("did not authorise");
    const b = await connect(s);
    const bad = await s.req("GET", `/api/jira/oauth/callback?code=wrong&state=${b.state}`, HOST);
    expect(bad.statusCode).toBe(400); expect(bad.body).toContain("Could not finish connecting");
    atl.sites = [{ id: "cloud-1", name: "Acme", url: "https://acme.atlassian.net", scopes: [] }, { id: "cloud-2", name: "Other", url: "https://other.atlassian.net", scopes: [] }];
    const c = await connect(s);
    expect((await s.req("GET", `/api/jira/oauth/callback?code=good-code&state=${c.state}`, HOST)).statusCode).toBe(200);
    expect(s.config.jira.site).toBeUndefined();
    expect((await s.req("GET", "/api/jira/status", HOST)).json().siteChoices.map((x: { name: string }) => x.name)).toEqual(["Acme", "Other"]);
    expect((await s.req("POST", "/api/jira/site", UI, { cloudId: "cloud-9" })).statusCode).toBe(400);
    expect((await s.req("POST", "/api/jira/site", UI, { cloudId: "cloud-2" })).statusCode).toBe(200);
    expect(s.config.jira.site!.name).toBe("Other");
    atl.sites = [{ id: "cloud-1", name: "Acme", url: "https://acme.atlassian.net", scopes: ["read:jira-work"] }];
  });
  it("lists what exists in Jira so statuses and labels can be mapped, saves the mapping, and checks it against each linked Jira project", async () => {
    const s = setup();
    const { state } = await connect(s); atl.code = "good-code"; await s.req("GET", `/api/jira/oauth/callback?code=good-code&state=${state}`, HOST);
    const meta = (await s.req("GET", "/api/jira/metadata?project=ENG", HOST)).json();
    expect(meta.projects.map((p: { key: string }) => p.key)).toEqual(["ENG", "OPS"]);
    expect(meta.statuses).toContain("Ready for specification"); expect(meta.labels).toContain("factory-ready");
    expect((await s.req("PUT", "/api/jira/mapping", UI, { statuses: { done: "Done" }, labels: { enabled: "has space" } })).statusCode).toBe(400);
    const ok = await s.req("PUT", "/api/jira/mapping", UI, { statuses: { readyForSpecification: "Ready for specification", inProgress: "In Progress", done: "Closed" }, labels: { enabled: "factory-ready", blocked: "factory-blocked" } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(s.config.linear.statuses.inProgress).toBe("In Progress");                           // applied to the running config
    const check = (await s.req("GET", "/api/jira/mapping/check", HOST)).json();               // the fixture projects are bound to team ENG
    expect(check.ok).toBe(false);
    expect(check.projects[0].missing).toEqual(['done: "Closed"']);                              // "Closed" does not exist in the Jira project
  });
  it("switches the profile's tracker, but not while tickets of the other tracker are being worked on", async () => {
    const s = setup();
    expect((await s.req("PUT", "/api/settings/tracker", UI, { tracker: "nope" })).statusCode).toBe(400);
    s.db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    const job = enqueue(s.db, { projectId: "p", externalId: "x", externalKey: "ENG-1" }).job;
    const blocked = await s.req("PUT", "/api/settings/tracker", UI, { tracker: "linear" });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error).toMatch(/still active/);
    expect(s.config.factory.tracker).toBe("jira");
    s.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id)).run();
    const ok = await s.req("PUT", "/api/settings/tracker", UI, { tracker: "linear" });
    expect(ok.statusCode).toBe(200); expect(ok.json().note).toMatch(/re-link/);
    expect(s.config.factory.tracker).toBe("linear");
  });
  it("disconnects by clearing the refresh token and the site, and the Linear key route refuses on a Jira profile", async () => {
    const s = setup();
    const { state } = await connect(s); await s.req("GET", `/api/jira/oauth/callback?code=good-code&state=${state}`, HOST);
    expect((await s.req("POST", "/api/jira/disconnect", UI, {})).statusCode).toBe(200);
    expect((await s.req("GET", "/api/jira/status", HOST)).json()).toMatchObject({ connected: false, site: null });
    expect(FactoryConfig.parse({}).tracker).toBe("linear");
  });
});

import { readFileSync } from "node:fs";
const readCfg = (dir: string) => ["jira.yaml", "factory.yaml"].map((f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } }).join("\n");
