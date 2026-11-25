import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { BUNDLED_CONFIG_DIR, loadConfig } from "../src/config/load.js";
import { applyProjects, removeProject, seedHomeConfig, upsertProject } from "../src/config/store.js";
import { openDb } from "../src/db/client.js";
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
  return { app, dir, config, ran, saved, release };
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
