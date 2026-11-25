import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { parseGhAccounts } from "../src/github/accounts.js";
import { addProfile, listProfiles, removeProfile } from "../src/config/profiles.js";
import { loadConfig } from "../src/config/load.js";
import { applyGlobal, seedHomeConfig, updateGlobalSettings, upsertProject, globalSettingsOf } from "../src/config/store.js";
import { openDb } from "../src/db/client.js";
import { buildServer } from "../src/server/app.js";
import { tmp } from "./helpers/git-fixture.js";
import { fixtureConfigDir } from "./helpers/config.js";

const GH = `github.com
  ✓ Logged in to github.com account Nikorag (keyring)
  - Active account: true
  - Token: gho_************************************

  ✓ Logged in to github.com account jamiebartlett-kps (keyring)
  - Active account: false
`;
describe("gh accounts", () => {
  it("lists the logged-in logins and which is active, never a token", () => {
    expect(parseGhAccounts(GH)).toEqual([{ login: "Nikorag", active: true }, { login: "jamiebartlett-kps", active: false }]);
    expect(JSON.stringify(parseGhAccounts(GH))).not.toContain("gho_");
    expect(parseGhAccounts("You are not logged in")).toEqual([]);
  });
});

const GLOBAL = { maxConcurrentJobs: 1, maxRemediationAttempts: 3, routes: { classification: { provider: "anthropic", model: "haiku" }, specification: { provider: "anthropic", model: "default" }, implementation: { provider: "anthropic", model: "default" }, independent_review: { provider: "anthropic", model: "haiku" }, final_review: { provider: "anthropic", model: "default" } } };
const proj = { id: "a", name: "A", github: { repo: "me/a" }, linear: { teamKey: "ENG", projectName: "A" }, commands: { test: "t" } };
describe("a profile's default GitHub account", () => {
  it("is used by projects that do not name their own, and a project's own account wins", () => {
    const dir = seedHomeConfig(join(tmp(), "config"));
    updateGlobalSettings({ ...GLOBAL, githubAccount: "jamiebartlett-kps" }, dir);
    upsertProject(proj, dir);
    upsertProject({ ...proj, id: "b", name: "B", github: { repo: "me/b", account: "Nikorag" }, linear: { teamKey: "ENG", projectName: "B" } }, dir);
    const c = loadConfig(dir);
    expect(c.projects.projects.find((p) => p.id === "a")!.github.account).toBe("jamiebartlett-kps");
    expect(c.projects.projects.find((p) => p.id === "b")!.github.account).toBe("Nikorag");
  });
  it("changing it updates the running config, including the projects that follow it", () => {
    const dir = fixtureConfigDir();
    const live = loadConfig(dir);
    const ex = live.projects.projects.find((p) => p.id === "example-game")!;
    expect(ex.github.account).toBe("example-user");                                   // its own, from the fixture
    applyGlobal(live, updateGlobalSettings({ ...GLOBAL, githubAccount: "work-acct" }, dir));
    expect(live.factory.githubAccount).toBe("work-acct");
    expect(live.projects.projects.find((p) => p.id === "example-game")!.github.account).toBe("example-user"); // still its own
    expect(globalSettingsOf(live).githubAccount).toBe("work-acct");
  });
  it("rejects something that is not a GitHub login", () => {
    const dir = seedHomeConfig(join(tmp(), "config"));
    expect(() => updateGlobalSettings({ ...GLOBAL, githubAccount: "not a login!" }, dir)).toThrow();
  });
});

describe("profile API", () => {
  const HOST = { host: "127.0.0.1:4780" }, UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1" };
  function server() {
    const root = tmp(); mkdirSync(join(root, "config"), { recursive: true }); writeFileSync(join(root, "config", "factory.yaml"), "server: { port: 4780 }\n");
    const started: string[] = [], up = new Set<string>();
    const app = buildServer({ db: openDb(":memory:").db, logger: pino({ level: "silent" }), port: 4780, controlToken: "t".repeat(64), profiles: {
      current: "default", list: () => listProfiles(root), add: (n) => addProfile(n, root), remove: (n) => removeProfile(n, root),
      start: async (p) => { started.push(p.name); up.add(p.name); return { started: true }; }, isUp: async (p) => up.has(p.name),
    } });
    return { app, root, started, up };
  }
  const call = (app: ReturnType<typeof server>["app"], method: "GET" | "POST" | "DELETE", url: string, headers: Record<string, string>, body?: unknown) =>
    app.inject({ method, url, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, remoteAddress: "127.0.0.1", payload: body === undefined ? undefined : JSON.stringify(body) });

  it("lists profiles with which is current and which are running", async () => {
    const s = server();
    const r = (await call(s.app, "GET", "/api/profiles", HOST)).json();
    expect(r).toMatchObject({ current: "default", profiles: [{ name: "default", current: true, running: true }] });
  });
  it("creates a profile from the dashboard, starts it, and reports its URL", async () => {
    const s = server();
    const r = await call(s.app, "POST", "/api/profiles", UI, { name: "work" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().profile).toMatchObject({ name: "work", port: 4781, url: "http://127.0.0.1:4781/" });
    expect(s.started).toEqual(["work"]);
    expect(readFileSync(join(s.root, "profiles.json"), "utf8")).toContain('"work"');
    expect((await call(s.app, "GET", "/api/profiles", HOST)).json().profiles.map((p: { name: string; running: boolean }) => `${p.name}:${p.running}`)).toEqual(["default:true", "work:true"]);
  });
  it("needs the dashboard origin or the token, and rejects bad names", async () => {
    const s = server();
    expect((await call(s.app, "POST", "/api/profiles", HOST, { name: "work" })).statusCode).toBe(401);
    expect((await call(s.app, "POST", "/api/profiles", UI, { name: "../evil" })).statusCode).toBe(400);
  });
  it("will not remove the profile you are in, the default, or one that is running", async () => {
    const s = server();
    await call(s.app, "POST", "/api/profiles", UI, { name: "work" });
    expect((await call(s.app, "DELETE", "/api/profiles/default", UI)).statusCode).toBe(409);   // current
    expect((await call(s.app, "DELETE", "/api/profiles/work", UI)).statusCode).toBe(409);      // running
    s.up.delete("work");
    expect((await call(s.app, "DELETE", "/api/profiles/work", UI)).statusCode).toBe(200);
    expect(listProfiles(s.root).map((p) => p.name)).toEqual(["default"]);
  });
});
