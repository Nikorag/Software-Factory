import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { carryRepoFiles, parseRepoFile, refreshRepoFile } from "../src/config/repo-file.js";
import { makeRepo } from "./helpers/git-fixture.js";
import { SKILL_MAX_BYTES } from "../src/config/skills.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { BUNDLED_CONFIG_DIR, ConfigError, loadConfig } from "../src/config/load.js";
import { applyGlobal, applyProjects, globalSettingsOf, removeProject, seedHomeConfig, updateGlobalSettings, upsertProject } from "../src/config/store.js";
import { eq } from "drizzle-orm";
import { enqueue } from "../src/core/jobs.js";
import { openDb } from "../src/db/client.js";
import { jobs } from "../src/db/schema.js";
import { buildServer } from "../src/server/app.js";
import { TaskManager } from "../src/service/tasks.js";
import { saveSecret } from "../src/service/secrets.js";
import type { ProjectActions } from "../src/service/actions.js";
import { fixtureConfigDir } from "./helpers/config.js";

const tmpDir = () => mkdtempSync(join(tmpdir(), "factory-settings-"));
const app1 = { id: "my-app", name: "My App", defaultBranch: "main", autonomy: "supervised", enabled: true, github: { account: "me", repo: "me/my-app" }, linear: { teamKey: "ENG", projectName: "My App" }, commands: { install: "npm ci", test: "npm test" } };

describe("the shipped defaults", () => {
  it("are generic: no projects, nothing personal", () => {
    const c = loadConfig(BUNDLED_CONFIG_DIR);
    expect(c.projects.projects).toEqual([]);
    expect(readFileSync(join(BUNDLED_CONFIG_DIR, "projects.yaml"), "utf8")).not.toMatch(/Zonto|Nikorag|Jamie/);
  });
});

describe("config store (what the settings UI writes)", () => {
  it("seeds a user config dir from the defaults, then adds, edits and removes a project", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    const c1 = upsertProject(app1, dir);
    expect(c1.projects.projects.map((p) => p.id)).toEqual(["my-app"]);
    expect(c1.projects.projects[0]!.commands.test).toBe("npm test");
    const c2 = upsertProject({ ...app1, commands: { test: "make test" } }, dir); // edit in place, not a duplicate
    expect(c2.projects.projects).toHaveLength(1);
    expect(c2.projects.projects[0]!.commands).toEqual({ test: "make test" });
    expect(loadConfig(dir).projects.projects[0]!.commands.test).toBe("make test"); // really on disk
    expect(removeProject("my-app", dir).projects.projects).toEqual([]);
    expect(() => removeProject("my-app", dir)).toThrow(/no such project/);
  });
  it("persists the optional visual command through the store", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    const c = upsertProject({ ...app1, commands: { test: "npm test", visual: "pnpm exec playwright test" } }, dir);
    expect(c.projects.projects[0]!.commands.visual).toBe("pnpm exec playwright test");
    expect(loadConfig(dir).projects.projects[0]!.commands).toEqual({ test: "npm test", visual: "pnpm exec playwright test" });
  });
  it("writes a readable block list, not one long flow line", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    upsertProject(app1, dir);
    upsertProject({ ...app1, id: "second", name: "Second", github: { repo: "me/second" }, linear: { teamKey: "ENG", projectName: "Second" } }, dir);
    const text = readFileSync(join(dir, "projects.yaml"), "utf8");
    expect(text).toMatch(/^projects:\n {2}- id: my-app\n/m);
    expect(text).not.toMatch(/^projects:\s*\[/m);
    expect(loadConfig(dir).projects.projects.map((p) => p.id)).toEqual(["my-app", "second"]);
  });
  it("keeps the comments of a hand-edited file", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    writeFileSync(join(dir, "projects.yaml"), "# my own note\nprojects: []\n");
    upsertProject(app1, dir);
    expect(readFileSync(join(dir, "projects.yaml"), "utf8")).toContain("# my own note");
  });
  it("refuses a change that would make the whole config invalid, leaving the file untouched", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    upsertProject(app1, dir);
    const before = readFileSync(join(dir, "projects.yaml"), "utf8");
    expect(() => upsertProject({ ...app1, id: "other", name: "Other" }, dir)).toThrow(/same Linear target|same repository/); // two projects, one Linear project
    expect(() => upsertProject({ ...app1, id: "Bad Id" }, dir)).toThrow();
    expect(() => upsertProject({ ...app1, id: "x", github: {}, linear: undefined }, dir)).toThrow(/GitHub repo/);
    expect(readFileSync(join(dir, "projects.yaml"), "utf8")).toBe(before);
  });
  it("applies a change to the config object a running service already holds", () => {
    const dir = fixtureConfigDir();
    const live = loadConfig(dir), held = live.projects.projects;
    applyProjects(live, upsertProject({ ...app1, linear: { teamKey: "ENG", projectName: "Mine" } }, dir));
    expect(held.some((p) => p.id === "my-app")).toBe(true); // same array: engine, scheduler and server all see it
  });
});

describe("saving the Linear key", () => {
  it("writes to the keychain via `security` and never to disk", () => {
    const calls: string[][] = [];
    saveSecret({ keychainService: "svc", keychainAccount: "me" }, "lin_api_x", { run: (_f, a) => { calls.push(a); return ""; } });
    expect(calls[0]).toEqual(["add-generic-password", "-U", "-a", "me", "-s", "svc", "-w", "lin_api_x"]);
  });
});

const HOST = { host: "127.0.0.1:4780" };
const UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1" };

function server() {
  const dir = fixtureConfigDir();
  const config = loadConfig(dir);
  const { db } = openDb(":memory:");
  const ran: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const actions = Object.fromEntries((["sync", "validate", "check", "onboard", "onboard-pr"] as const).map((k) => [k, async (p: { id: string }, log: (l: string) => void) => { ran.push(`${k}:${p.id}`); log(`did ${k}`); if (k === "check") await gate; return k !== "validate"; }])) as unknown as ProjectActions;
  const saved: string[] = [];
  const app = buildServer({
    db, logger: pino({ level: "silent" }), config, dataDir: tmpDir(), port: 4780, controlToken: "t".repeat(64),
    settings: { tasks: new TaskManager(), actions, linear: () => { throw new Error("no linear in this test"); }, linearKeyPresent: () => false, saveLinearKey: async (k) => { saved.push(k); return { name: "Me" }; } },
  });
  return { app, db, dir, config, ran, saved, release };
}
const send = (app: ReturnType<typeof server>["app"], method: "PUT" | "POST" | "DELETE" | "GET", url: string, headers: Record<string, string>, body?: unknown) =>
  app.inject({ method, url, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, remoteAddress: "127.0.0.1", payload: body === undefined ? undefined : JSON.stringify(body) });

describe("settings API", () => {
  it("adds a project from the dashboard, live, and it shows up in the projects list", async () => {
    const s = server();
    const { id: _id, ...body } = app1; void _id;
    const r = await send(s.app, "PUT", "/api/settings/projects/my-app", UI, { ...body, linear: { teamKey: "ENG", projectName: "Mine" } });
    expect(r.statusCode, r.body).toBe(200);
    const list = (await send(s.app, "GET", "/api/projects", HOST)).json().projects as { id: string; commands: { test?: string }; githubAccount: string }[];
    expect(list.find((p) => p.id === "my-app")).toMatchObject({ commands: { test: "npm test" }, githubAccount: "me" });
    expect(loadConfig(s.dir).projects.projects.some((p) => p.id === "my-app")).toBe(true);
    expect((await send(s.app, "DELETE", "/api/settings/projects/my-app", UI)).statusCode).toBe(200);
    expect((await send(s.app, "GET", "/api/projects", HOST)).json().projects.some((p: { id: string }) => p.id === "my-app")).toBe(false);
  });
  it("refuses to remove a project while it has active jobs (they would fail with orphaned worktrees), and allows it after", async () => {
    const s = server();
    const { id: _id, ...body } = app1; void _id;
    expect((await send(s.app, "PUT", "/api/settings/projects/my-app", UI, { ...body, linear: { teamKey: "ENG", projectName: "Mine" } })).statusCode).toBe(200);
    const { job } = enqueue(s.db, { projectId: "my-app", externalId: "i1", externalKey: "ENG-1" });
    const r = await send(s.app, "DELETE", "/api/settings/projects/my-app", UI);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/1 active job/);
    expect(loadConfig(s.dir).projects.projects.some((p) => p.id === "my-app")).toBe(true); // untouched
    s.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id)).run();
    expect((await send(s.app, "DELETE", "/api/settings/projects/my-app", UI)).statusCode).toBe(200);
  });
  it("needs the dashboard origin or the token, and rejects invalid input with a readable error", async () => {
    const s = server();
    expect((await send(s.app, "PUT", "/api/settings/projects/x", HOST, app1)).statusCode).toBe(401);
    expect((await send(s.app, "PUT", "/api/settings/projects/x", { ...UI, "sec-fetch-site": "cross-site" }, app1)).statusCode).toBe(401);
    const bad = await send(s.app, "PUT", "/api/settings/projects/x", UI, { name: "", github: { repo: "not a repo" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/name|repo/);
  });
  it("runs project actions in the background, one at a time per project, and reports progress", async () => {
    const s = server();
    const first = await send(s.app, "POST", "/api/projects/example-game/actions/check", UI, {});
    expect(first.statusCode).toBe(200);
    expect((await send(s.app, "POST", "/api/projects/example-game/actions/sync", UI, {})).statusCode).toBe(409); // already running for this project
    expect((await send(s.app, "POST", "/api/projects/example-app/actions/sync", UI, {})).statusCode).toBe(200);   // another project is fine
    const id = first.json().taskId as string;
    expect((await send(s.app, "GET", `/api/tasks/${id}`, HOST)).json()).toMatchObject({ status: "running", lines: ["did check"] });
    s.release();
    await new Promise((r) => setTimeout(r, 50));
    expect((await send(s.app, "GET", `/api/tasks/${id}`, HOST)).json().status).toBe("ok");
    expect((await send(s.app, "POST", "/api/projects/nope/actions/sync", UI, {})).statusCode).toBe(404);
    expect((await send(s.app, "POST", "/api/projects/example-app/actions/rm-rf", UI, {})).statusCode).toBe(404);
  });
  it("rejects anything that is not a Linear key before contacting Linear or storing it", async () => {
    const s = server();
    for (const key of ["", "hunter2", "lin_api_short", "sk-ant-" + "a".repeat(40)]) expect((await send(s.app, "POST", "/api/setup/linear-key", UI, { key })).statusCode).toBe(400);
    expect(s.saved).toEqual([]);
  });
});

describe("workflow settings (global) and per-project overrides", () => {
  const route = (model: string, provider = "anthropic") => ({ provider, model });
  const global = (o: object = {}) => ({ maxConcurrentJobs: 2, maxRemediationAttempts: 5, routes: { classification: route("haiku"), specification: route("sonnet"), implementation: route("opus"), independent_review: route("haiku"), final_review: route("default") }, ...o });

  it("writes concurrency, fix-cycle limit and a model per task, keeping comments, and the config reloads with them", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    const c = updateGlobalSettings(global(), dir);
    expect(c.factory).toMatchObject({ maxConcurrentJobs: 2, maxRemediationAttempts: 5 });
    expect(c.models.routes.implementation).toEqual({ provider: "anthropic", model: "opus" });
    expect(readFileSync(join(dir, "models.yaml"), "utf8")).toContain("# Model routing."); // the shipped comments survive
    expect(loadConfig(dir).models.routes.specification.model).toBe("sonnet");               // really on disk
  });
  it("switches the profile's planning mode on disk and live, keeping the rest of factory.yaml", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    const live = loadConfig(dir);
    expect(live.factory.workflow.planning_mode).toBe("haiku_prompt");
    applyGlobal(live, updateGlobalSettings(global({ planningMode: "speckit" }), dir));
    expect(live.factory.workflow.planning_mode).toBe("speckit");
    expect(loadConfig(dir).factory.workflow).toMatchObject({ planning_mode: "speckit", max_conflict_resolutions: 3 });
    expect(readFileSync(join(dir, "factory.yaml"), "utf8")).toContain("# Factory-wide settings");
  });
  it("refuses values outside the limits, or a local model for a stage that needs file tools, and writes nothing", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    const before = readFileSync(join(dir, "factory.yaml"), "utf8") + readFileSync(join(dir, "models.yaml"), "utf8");
    expect(() => updateGlobalSettings(global({ maxConcurrentJobs: 0 }), dir)).toThrow();
    expect(() => updateGlobalSettings(global({ maxConcurrentJobs: 9 }), dir)).toThrow();
    expect(() => updateGlobalSettings(global({ maxRemediationAttempts: 11 }), dir)).toThrow();
    expect(() => updateGlobalSettings(global({ routes: { ...global().routes, implementation: route("x", "local") } }), dir)).toThrow(/must use provider `anthropic`/);
    expect(readFileSync(join(dir, "factory.yaml"), "utf8") + readFileSync(join(dir, "models.yaml"), "utf8")).toBe(before);
  });
  it("saves the number of implementation passes, live, and rejects values outside 1-10", () => {
    const dir = fixtureConfigDir();
    const live = loadConfig(dir);
    expect(live.factory.maxImplementationPasses).toBe(3);                                         // the default
    applyGlobal(live, updateGlobalSettings(global({ maxImplementationPasses: 8 }), dir));
    expect(live.factory.maxImplementationPasses).toBe(8);
    expect(loadConfig(dir).factory.maxImplementationPasses).toBe(8);                               // really on disk
    expect(globalSettingsOf(live).maxImplementationPasses).toBe(8);
    expect(() => updateGlobalSettings(global({ maxImplementationPasses: 0 }), dir)).toThrow();
    expect(() => updateGlobalSettings(global({ maxImplementationPasses: 11 }), dir)).toThrow();
    const c = upsertProject({ ...app1, overrides: { maxImplementationPasses: 6 } }, seedHomeConfig(join(tmpDir(), "config")));
    expect(c.projects.projects[0]!.overrides!.maxImplementationPasses).toBe(6);
  });
  it("applies to the config object a running engine and router already hold", () => {
    const dir = fixtureConfigDir();
    const live = loadConfig(dir), routes = live.models.routes;
    applyGlobal(live, updateGlobalSettings(global(), dir));
    expect(live.factory.maxConcurrentJobs).toBe(2);
    expect(routes.implementation.model).toBe("opus"); // same object the router holds
  });
  it("stores a project's overrides, and writes no overrides block at all when there are none", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    const c = upsertProject({ ...app1, overrides: { maxConcurrentJobs: 2, maxRemediationAttempts: 1, models: { implementation: route("opus") } } }, dir);
    expect(c.projects.projects[0]!.overrides).toEqual({ maxConcurrentJobs: 2, maxRemediationAttempts: 1, models: { implementation: { provider: "anthropic", model: "opus" } } });
    upsertProject({ ...app1, overrides: { models: {} } }, dir); // cleared in the editor
    expect(readFileSync(join(dir, "projects.yaml"), "utf8")).not.toContain("overrides");
    expect(loadConfig(dir).projects.projects[0]!.overrides).toBeUndefined();
  });
  it("rejects a bad project override", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    expect(() => upsertProject({ ...app1, overrides: { maxConcurrentJobs: 99 } }, dir)).toThrow();
    expect(() => upsertProject({ ...app1, overrides: { models: { specification: route("m", "local") } } }, dir)).toThrow();
  });
  it("saves an independent reviewer endpoint (URL, model, key variable name), then clears it (skip), live and on disk", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    const live = loadConfig(dir);
    expect(live.models.routes.independent_review).toBeUndefined(); // the seeded default: none
    const ep = { provider: "local", model: "gpt-x", baseUrl: "https://api.example.test/v1", apiKeyEnv: "REVIEW_KEY" };
    applyGlobal(live, updateGlobalSettings(global({ routes: { ...global().routes, independent_review: ep } }), dir));
    expect(live.models.routes.independent_review).toEqual(ep);
    expect(readFileSync(join(dir, "models.yaml"), "utf8")).toContain("REVIEW_KEY");
    expect(readFileSync(join(dir, "models.yaml"), "utf8")).not.toMatch(/sk-/);
    applyGlobal(live, updateGlobalSettings(global({ routes: { ...global().routes, independent_review: null } }), dir));
    expect(live.models.routes.independent_review).toBeUndefined();
    expect(loadConfig(dir).models.routes.independent_review).toBeUndefined();
    expect(readFileSync(join(dir, "models.yaml"), "utf8")).toContain("# Model routing."); // comments kept
  });
  it("refuses an invalid reviewer URL or key variable name and writes nothing", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    const before = readFileSync(join(dir, "factory.yaml"), "utf8") + readFileSync(join(dir, "models.yaml"), "utf8");
    for (const bad of [{ provider: "local", model: "m", baseUrl: "not a url" }, { provider: "local", model: "m", baseUrl: "https://x.test/v1", apiKeyEnv: "has space" }, { provider: "anthropic", model: "haiku", baseUrl: "https://x.test/v1" }]) {
      expect(() => updateGlobalSettings(global({ maxConcurrentJobs: 4, routes: { ...global().routes, independent_review: bad } }), dir)).toThrow();
    }
    expect(readFileSync(join(dir, "factory.yaml"), "utf8") + readFileSync(join(dir, "models.yaml"), "utf8")).toBe(before);
  });
  it("saves a project override that clears the reviewer (null = skip for this project), and refuses an invalid one", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    const c = upsertProject({ ...app1, overrides: { models: { independent_review: null } } }, dir);
    expect(c.projects.projects[0]!.overrides).toEqual({ models: { independent_review: null } });
    expect(loadConfig(dir).projects.projects[0]!.overrides?.models?.independent_review).toBeNull();
    const before = readFileSync(join(dir, "projects.yaml"), "utf8");
    expect(() => upsertProject({ ...app1, overrides: { models: { independent_review: { provider: "local", model: "m", baseUrl: "nope" } } } }, dir)).toThrow();
    expect(readFileSync(join(dir, "projects.yaml"), "utf8")).toBe(before);
  });
  it("is served and saved through the API, live, from the dashboard", async () => {
    const s = server();
    const r0 = await send(s.app, "GET", "/api/settings/global", HOST);
    expect(r0.json()).toMatchObject({ maxConcurrentJobs: 1, maxRemediationAttempts: 3 });
    expect((await send(s.app, "PUT", "/api/settings/global", HOST, global())).statusCode).toBe(401);          // needs the dashboard origin or the token
    const ok = await send(s.app, "PUT", "/api/settings/global", UI, global());
    expect(ok.statusCode, ok.body).toBe(200);
    expect(s.config.factory.maxConcurrentJobs).toBe(2);                                                         // applied to the live config
    expect(globalSettingsOf(loadConfig(s.dir)).routes.implementation.model).toBe("opus");
    expect((await send(s.app, "PUT", "/api/settings/global", UI, global({ maxConcurrentJobs: 50 }))).statusCode).toBe(400);
  });
});

describe("hub API (local only; never touches the network or keychain in these cases)", () => {
  it("reports not connected, and refuses bad input before contacting anything", async () => {
    const s = server();
    const st = await send(s.app, "GET", "/api/hub", HOST);
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ enabled: false, remoteAccess: false });
    const bad = await send(s.app, "POST", "/api/hub/connect", UI, { url: "https://hub.example.com", key: "not-a-key" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/sfh_/);
    expect((await send(s.app, "POST", "/api/hub/connect", UI, { url: "http://hub.example.com", key: "x" })).statusCode).toBe(400);
    expect((await send(s.app, "PUT", "/api/hub/remote-access", UI, { on: true })).statusCode).toBe(409); // not connected yet
  });
  it("requires the UI header for changes", async () => {
    const s = server();
    expect((await send(s.app, "POST", "/api/hub/disconnect", HOST)).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("saving a project from the form keeps fields the form does not edit", () => {
  it("keeps agentBashAllow and allowLoopback set by hand", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    upsertProject(app1, dir);
    const file = join(dir, "projects.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^ {4}commands:/m, "    allowLoopback: true\n    agentBashAllow:\n      - godot --headless\n    commands:"));
    const c = upsertProject({ ...app1, name: "Renamed" }, dir);
    expect(c.projects.projects[0]!).toMatchObject({ name: "Renamed", allowLoopback: true, agentBashAllow: ["godot --headless"] });
  });
});

describe("agentBashAny opt-in", () => {
  it("defaults to false and survives a save from the form", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    expect(upsertProject(app1, dir).projects.projects[0]!.agentBashAny).toBe(false);
    const file = join(dir, "projects.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^ {4}commands:/m, "    agentBashAny: true\n    commands:"));
    expect(upsertProject({ ...app1, name: "Renamed" }, dir).projects.projects[0]!).toMatchObject({ name: "Renamed", agentBashAny: true });
    expect(upsertProject({ ...app1, agentBashAny: false }, dir).projects.projects[0]!.agentBashAny).toBe(false);
    expect(upsertProject({ ...app1, agentBashAny: true }, dir).projects.projects[0]!.agentBashAny).toBe(true);
  });
});

describe("skills (projects.yaml and the profile settings)", () => {
  const skillDir = () => { const d = tmpDir(); mkdirSync(join(d, "folder-skill")); writeFileSync(join(d, "folder-skill", "SKILL.md"), "---\nname: x\n---\nUse tabs.\n"); writeFileSync(join(d, "one.md"), "Be brief."); return d; };

  it("round-trips project skills through projects.yaml, keeps them when the form omits them, and clears them with []", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config")), sk = skillDir();
    const skills = [{ name: "one", path: join(sk, "one.md") }, { name: "folder-skill", path: join(sk, "folder-skill") }];
    expect(upsertProject({ ...app1, skills }, dir).projects.projects[0]!.skills).toEqual(skills);
    expect(upsertProject({ ...app1, name: "Renamed" }, dir).projects.projects[0]!.skills).toEqual(skills);
    expect(upsertProject({ ...app1, skills: [] }, dir).projects.projects[0]!.skills).toEqual([]);
  });

  it("never writes repo-file skills into projects.yaml, and keeps them across a save", async () => {
    const dir = seedHomeConfig(join(tmpDir(), "config")), sk = skillDir();
    const { repo } = makeRepo({ "README.md": "hi\n", "s/repo-only/SKILL.md": "REPO BODY", ".software-factory.yml": "id: my-app\nskills: [{ name: repo-only, path: s/repo-only }]\n" });
    const own = [{ name: "one", path: join(sk, "one.md") }];
    const live = upsertProject({ ...app1, skills: own }, dir);
    live.projects.projects[0]!.repository = repo;
    expect(await refreshRepoFile(live.projects.projects[0]!)).toEqual({ status: "applied" });
    expect(live.projects.projects[0]!.repoSkills?.map((s) => s.name)).toEqual(["repo-only"]);

    const fresh = upsertProject({ ...app1, name: "Renamed", skills: own }, dir); // an unrelated edit through the editor payload
    const text = readFileSync(join(dir, "projects.yaml"), "utf8");
    expect(text).not.toMatch(/repoSkills|repo-only|REPO BODY/);
    expect(fresh.projects.projects[0]!.skills).toEqual(own);
    expect(fresh.projects.projects[0]!.repoSkills).toBeUndefined();
    fresh.projects.projects[0]!.repository = repo;
    carryRepoFiles(live.projects.projects, fresh.projects.projects);
    expect(fresh.projects.projects[0]!.repoSkills?.map((s) => s.name)).toEqual(["repo-only"]);
    expect(fresh.projects.projects[0]!.skills).toEqual(own);
  });

  it("rejects a bad name, a missing path, an oversize file and a duplicate with a ConfigError", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config")), sk = skillDir();
    writeFileSync(join(sk, "big.md"), "x".repeat(SKILL_MAX_BYTES + 1));
    const bad = (skills: { name: string; path: string }[], msg: RegExp) => { expect(() => upsertProject({ ...app1, skills }, dir)).toThrow(ConfigError); expect(() => upsertProject({ ...app1, skills }, dir)).toThrow(msg); };
    bad([{ name: "Bad Name", path: join(sk, "one.md") }], /skill name/);
    bad([{ name: "gone", path: join(sk, "nope.md") }], /does not exist/);
    bad([{ name: "big", path: join(sk, "big.md") }], /larger than/);
    bad([{ name: "a", path: join(sk, "one.md") }, { name: "a", path: join(sk, "one.md") }], /twice/);
    bad([{ name: "rel", path: "one.md" }], /absolute/);
  });

  it("round-trips profile skills through updateGlobalSettings", () => {
    const dir = seedHomeConfig(join(tmpDir(), "config")), sk = skillDir();
    const base = globalSettingsOf(loadConfig(dir));
    const skills = [{ name: "one", path: join(sk, "one.md") }];
    expect(globalSettingsOf(updateGlobalSettings({ ...base, skills }, dir)).skills).toEqual(skills);
    expect(globalSettingsOf(updateGlobalSettings({ ...base, skills: undefined }, dir)).skills).toEqual(skills); // absent keeps
    expect(() => updateGlobalSettings({ ...base, skills: [{ name: "x", path: join(sk, "nope") }] }, dir)).toThrow(ConfigError);
    expect(globalSettingsOf(updateGlobalSettings({ ...base, skills: [] }, dir)).skills).toEqual([]);
  });

  it("is exposed and accepted by /api/projects and /api/settings/global", async () => {
    const s = server(), sk = skillDir();
    const skills = [{ name: "one", path: join(sk, "one.md") }];
    const { id: _id, ...body } = app1; void _id;
    expect((await send(s.app, "PUT", "/api/settings/projects/my-app", UI, { ...body, skills })).statusCode).toBe(200);
    const list = (await send(s.app, "GET", "/api/projects", HOST)).json().projects as { id: string; skills: unknown }[];
    expect(list.find((p) => p.id === "my-app")?.skills).toEqual(skills);
    const g = (await send(s.app, "GET", "/api/settings/global", HOST)).json();
    const r = await send(s.app, "PUT", "/api/settings/global", UI, { ...g, skills });
    expect(r.statusCode, r.body).toBe(200);
    expect((await send(s.app, "GET", "/api/settings/global", HOST)).json().skills).toEqual(skills);
    expect(s.config.factory.skills).toEqual(skills); // applied live
    const bad = await send(s.app, "PUT", "/api/settings/global", UI, { ...g, skills: [{ name: "x", path: "/no/such/file" }] });
    expect(bad.statusCode).toBe(400);
  });

  it("cannot be set from the repository's .software-factory.yml", () => {
    expect(() => parseRepoFile("id: p\nskills:\n  - name: a\n    path: /tmp/a.md\n", "p")).toThrow(ConfigError);
  });
});

describe("advanced factory settings", () => {
  it("writes the safety keys into factory.yaml, keeps comments, and refuses a bad value", async () => {
    const { updateAdvancedSettings, advancedSettingsOf } = await import("../src/config/store.js");
    const dir = seedHomeConfig(join(tmpDir(), "config"));
    const before = advancedSettingsOf(loadConfig(dir));
    const next = { ...before, agentAccess: "unrestricted" as const, dryRun: true, sandboxRequired: false, logRetentionDays: 7, protectedPaths: [".env", ".git/**"] };
    const c = updateAdvancedSettings(next, dir);
    expect(advancedSettingsOf(c)).toMatchObject({ agentAccess: "unrestricted", dryRun: true, sandboxRequired: false, logRetentionDays: 7, protectedPaths: [".env", ".git/**"] });
    expect(() => updateAdvancedSettings({ ...next, commandTimeoutSeconds: 1 }, dir)).toThrow();
  });
});
