import pino from "pino";
import { describe, expect, it } from "vitest";
import { fixtureConfig } from "./helpers/config.js";
import { openDb } from "../src/db/client.js";
import { blockedRemoteBody, classifyRemote, RULES, validateRemotePath } from "../src/hub/remote-policy.js";
import { buildServer } from "../src/server/app.js";
import { TaskManager } from "../src/service/tasks.js";

/** A server with EVERY optional route group registered, so the full route table is visible. */
export function fullServer() {
  const { db } = openDb(":memory:");
  const store = { get: () => undefined, set: () => undefined, delete: () => undefined } as never;
  return buildServer({
    db, logger: pino({ level: "silent" }), config: fixtureConfig(), dataDir: "/tmp/none", port: 4780, controlToken: "t", shutdown: () => undefined,
    updates: { status: async () => ({}) as never, refresh: async () => ({}) as never },
    settings: { tasks: new TaskManager(), actions: {} as never, linear: () => ({}) as never, saveLinearKey: async () => ({ name: "x" }), linearKeyPresent: () => false },
    bitbucket: { store }, jira: { store, port: 4780 } as never,
    profiles: { current: "default", list: () => [], add: () => ({}) as never, remove: () => undefined, start: async () => ({ started: true }), isUp: async () => false } as never,
  });
}

describe("remote access policy covers every route", () => {
  const routes = [...new Set(fullServer().registeredRoutes.filter((r) => r.method !== "HEAD").map((r) => `${r.method} ${r.url}`))].sort();

  it("registers a meaningful number of routes (the enumeration works)", () => { expect(routes.length).toBeGreaterThan(60); });

  it("every registered route has an explicit rule: a new route cannot silently become remotely reachable", () => {
    const ruled = new Set(RULES.map((r) => `${r.method} ${r.pattern}`));
    expect(routes.filter((r) => !ruled.has(r))).toEqual([]);
  });

  it("every rule matches a real route (no stale entries hiding a typo)", () => {
    const real = new Set(routes);
    expect(RULES.map((r) => `${r.method} ${r.pattern}`).filter((r) => !real.has(r))).toEqual([]);
  });

  it("no duplicate rules", () => {
    const keys = RULES.map((r) => `${r.method} ${r.pattern}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a concrete URL for each route resolves to that route's own rule", () => {
    const concrete = (p: string) => p.replace(/:(\w+)\(([^)|]+)[^)]*\)/g, "$2").replace(/:\w+/g, "abc123");
    for (const r of RULES) expect(classifyRemote(r.method, concrete(r.pattern))).toMatchObject({ route: r.pattern, allowed: r.effect === "allow" });
  });
});

describe("remote access policy decisions", () => {
  const ok = (m: string, p: string) => classifyRemote(m, p).allowed;

  it("allows the everyday dashboard features", () => {
    for (const [m, p] of [["GET", "/api/overview"], ["GET", "/api/jobs"], ["GET", "/api/jobs/j1"], ["GET", "/api/jobs/j1/invocations/3/log"], ["GET", "/api/jobs/j1/invocations/3/conversation"],
      ["GET", "/api/board"], ["POST", "/api/board/start"], ["POST", "/api/jobs/j1/cancel"], ["POST", "/api/jobs/j1/retry"], ["POST", "/api/jobs/j1/answer"], ["DELETE", "/api/jobs/j1"],
      ["POST", "/api/control/pause"], ["POST", "/api/control/resume"], ["POST", "/api/control/stop"], ["POST", "/api/control/clear-stop"],
      ["GET", "/api/trackers"], ["POST", "/api/trackers"], ["PUT", "/api/trackers/jira-2"], ["DELETE", "/api/trackers/jira-2"], ["GET", "/api/github-issues/mapping"], ["PUT", "/api/github-issues/mapping"], ["PUT", "/api/settings/tracker"],
      ["PUT", "/api/settings/global"], ["POST", "/api/projects/web/actions/sync"], ["GET", "/api/settings/global"]]) expect(ok(m!, p!), `${m} ${p}`).toBe(true);
  });

  it("blocks anything that handles a secret", () => {
    for (const [m, p] of [["POST", "/api/setup/linear-key"], ["PUT", "/api/bitbucket/credentials/main"], ["DELETE", "/api/bitbucket/credentials/main"], ["POST", "/api/bitbucket/credentials/main/test"],
      ["PUT", "/api/jira/app"], ["POST", "/api/jira/connect"], ["POST", "/api/jira/disconnect"], ["POST", "/api/jira/site"], ["GET", "/api/jira/oauth/callback"]]) expect(ok(m!, p!), `${m} ${p}`).toBe(false);
  });

  it("blocks stopping the process, profiles, project settings writes and the local dashboard files", () => {
    for (const [m, p] of [["POST", "/api/control/shutdown"], ["POST", "/api/profiles"], ["DELETE", "/api/profiles/work"], ["PUT", "/api/settings/projects/web"], ["DELETE", "/api/settings/projects/web"],
      ["GET", "/"], ["GET", "/assets/index.js"], ["GET", "/health"]]) expect(ok(m!, p!), `${m} ${p}`).toBe(false);
  });

  it("denies anything unclassified, including near-misses", () => {
    for (const [m, p] of [["GET", "/api/nope"], ["POST", "/api/jobs"], ["GET", "/api/jobs/j1/extra/deep/path"], ["PATCH", "/api/jobs/j1"], ["POST", "/api/control/shutdown/"], ["POST", "/api/control/pause/x"], ["OPTIONS", "/api/jobs"], ["POST", "/api/workflows/w1/delete"]])
      expect(ok(m!, p!), `${m} ${p}`).toBe(false);
  });

  it("the most specific rule wins", () => {
    expect(classifyRemote("PUT", "/api/trackers/jira-2")).toMatchObject({ allowed: true, route: "/api/trackers/:id" });
    expect(classifyRemote("DELETE", "/api/jobs/j1")).toMatchObject({ allowed: true, route: "/api/jobs/:id" });
    expect(classifyRemote("POST", "/api/setup/linear-key")).toMatchObject({ allowed: false, route: "/api/setup/linear-key" });
  });

  it("HEAD is treated as GET and reports whether a call mutates", () => {
    expect(classifyRemote("HEAD", "/api/jobs")).toMatchObject({ allowed: true, mutating: false });
    expect(classifyRemote("POST", "/api/control/pause")).toMatchObject({ allowed: true, mutating: true });
  });
});

describe("remote path validation", () => {
  const good = ["/api/jobs", "/api/jobs?status=running&page=2", "/api/jobs/abc-123/invocations/4/log?tail=200", "/api/trackers/jira-2.eu_1"];
  const bad = ["", "api/jobs", "/", "/health", "/apix", "//api/jobs", "/api//jobs", "/api/../health", "/api/jobs/..", "/api/./jobs", "http://evil.example/api/jobs", "https://x/api/jobs",
    "/api/jobs%2f..%2fhealth", "/api/%2e%2e/health", "/api/jobs/%5c", "/api/jobs\\x", "/api/jobs\n", "/api/jobs\u0000", "/api/jobs x", "/api/jobs#frag", "/api/%zz", "/api/" + "a".repeat(2100)];
  for (const p of good) it(`accepts ${p}`, () => expect(validateRemotePath(p)).not.toBeNull());
  for (const p of bad) it(`rejects ${JSON.stringify(p).slice(0, 50)}`, () => expect(validateRemotePath(p)).toBeNull());
  it("rejects non-strings", () => { for (const v of [undefined, null, 5, {}, ["/api/jobs"]]) expect(validateRemotePath(v)).toBeNull(); });
});

describe("skills are not settable remotely", () => {
  const body = (o: unknown) => Buffer.from(JSON.stringify(o));
  it("refuses a global settings body that carries skills, and allows one that does not", () => {
    expect(blockedRemoteBody("PUT", "/api/settings/global", body({ maxConcurrentJobs: 1, skills: [] }))).toMatch(/skills/);
    expect(blockedRemoteBody("PUT", "/api/settings/global", body({ maxConcurrentJobs: 1 }))).toBeNull();
    expect(blockedRemoteBody("PUT", "/api/settings/tracker", body({ skills: [] }))).toBeNull();
    expect(blockedRemoteBody("PUT", "/api/settings/global", undefined)).toBeNull();
  });
  it("project settings (which can carry skills) stay blocked remotely", () => {
    expect(classifyRemote("PUT", "/api/settings/projects/x").allowed).toBe(false);
  });
});
