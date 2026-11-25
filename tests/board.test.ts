import pino from "pino";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { LinearConfig, ProjectConfig, FactoryConfig, type LoadedConfig } from "../src/config/schema.js";
import { loadConfig } from "../src/config/load.js";
import { openDb } from "../src/db/client.js";
import { jobs, projects } from "../src/db/schema.js";
import { enqueue } from "../src/core/jobs.js";
import { discoverIssues } from "../src/linear/discovery.js";
import { evaluateEligibility } from "../src/linear/eligibility.js";
import { buildServer } from "../src/server/app.js";
import { parseSearch } from "../src/server/board-routes.js";
import { syncProjects } from "../src/repo/registry.js";
import { FakeLinear } from "./helpers/fake-linear.js";
import { fixtureConfigDir } from "./helpers/config.js";

const logger = pino({ level: "silent" });
const proj = (o: Record<string, unknown> = {}) => ProjectConfig.parse({ id: "a", name: "A", repository: "/x/a", linear: { teamKey: "ENG", projectName: "Alpha" }, commands: { test: "t" }, ...o });
const READY = (db: ReturnType<typeof openDb>["db"], id: string) => db.update(projects).set({ validationJson: JSON.stringify({ ok: true, isGitRepo: true, remote: { github: { owner: "o", repo: "r" } }, hasSpecKit: true }), checkJson: JSON.stringify({ ok: true, at: Date.now() }) }).where(eq(projects.id, id)).run();

describe("search box", () => {
  it("understands a number, a ticket key, or words", () => {
    expect(parseSearch("418")).toEqual({ number: 418 });
    expect(parseSearch("#418")).toEqual({ number: 418 });
    expect(parseSearch("jam-418")).toEqual({ teamKey: "JAM", number: 418 });
    expect(parseSearch("login page")).toEqual({ title: "login page" });
    expect(parseSearch("   ")).toBeNull();
    expect(parseSearch("x".repeat(300))!.title!.length).toBe(100);
  });
});

describe("manual pickup", () => {
  it("a manually started ticket needs no label or status, but a finished one is refused", () => {
    const f = new FakeLinear(), linear = LinearConfig.parse({});
    const backlog = f.addIssue({ state: "Backlog", labels: [] });
    expect(evaluateEligibility(backlog, proj(), linear, { projectRunnable: true }).eligible).toBe(false);                    // automatic: needs label + status
    expect(evaluateEligibility(backlog, proj(), linear, { projectRunnable: true, manual: true }).eligible).toBe(true);       // manual: you chose it
    expect(evaluateEligibility(f.addIssue({ state: "Done", labels: [] }), proj(), linear, { projectRunnable: true, manual: true }).reasons[0]).toMatch(/already Done/);
    expect(evaluateEligibility(backlog, proj(), linear, { projectRunnable: false, manual: true }).eligible).toBe(false);     // still needs a validated project
    expect(evaluateEligibility(backlog, proj({ autonomy: "off" }), linear, { projectRunnable: true, manual: true }).eligible).toBe(false);
  });
  it("discovery leaves manual-mode projects alone, whether set globally or per project", async () => {
    const run = async (projectsList: ProjectConfig[], pickupMode: "automatic" | "manual") => {
      const { db } = openDb(":memory:"); syncProjects(db, projectsList); for (const p of projectsList) READY(db, p.id);
      const f = new FakeLinear(); f.addIssue({ key: "ENG-1", project: "Alpha" });
      return (await discoverIssues({ db, client: f, linear: LinearConfig.parse({}), projects: projectsList, logger, pickupMode })).enqueued.length;
    };
    expect(await run([proj()], "automatic")).toBe(1);
    expect(await run([proj()], "manual")).toBe(0);                                                    // profile-wide manual
    expect(await run([proj({ overrides: { pickupMode: "manual" } })], "automatic")).toBe(0);          // this project manual
    expect(await run([proj({ overrides: { pickupMode: "automatic" } })], "manual")).toBe(1);          // this project automatic despite a manual profile
  });
});

describe("board API", () => {
  const HOST = { host: "127.0.0.1:4780" }, UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1" };
  function setup(ready = true) {
    const config: LoadedConfig = { ...loadConfig(fixtureConfigDir()), projects: { projects: [proj()] }, factory: FactoryConfig.parse({}) };
    const { db } = openDb(":memory:"); syncProjects(db, config.projects.projects); if (ready) READY(db, "a");
    const f = new FakeLinear();
    f.addIssue({ key: "ENG-418", state: "Backlog", labels: [], project: "Alpha" }); f.addIssue({ key: "ENG-7", state: "In progress", labels: [], project: "Alpha" });
    f.addIssue({ key: "ENG-9", state: "Done", labels: [], project: "Alpha" }); f.addIssue({ key: "ENG-20", state: "Backlog", labels: [], project: "Other" });
    const app = buildServer({ db, logger, config, port: 4780, controlToken: "t".repeat(64), settings: { tasks: {} as never, actions: {} as never, linear: () => f, linearKeyPresent: () => true, saveLinearKey: async () => ({ name: "x" }) } });
    const get = (url: string) => app.inject({ method: "GET", url, headers: HOST, remoteAddress: "127.0.0.1" });
    const post = (body: unknown, h: Record<string, string> = UI) => app.inject({ method: "POST", url: "/api/board/start", headers: { ...h, "content-type": "application/json" }, remoteAddress: "127.0.0.1", payload: JSON.stringify(body) });
    return { db, f, get, post };
  }
  it("lists open tickets of this profile's projects, grouped by status, and hides finished and foreign ones", async () => {
    const s = setup();
    const r = (await s.get("/api/board")).json();
    expect(r.items.map((i: { key: string }) => i.key)).toEqual(["ENG-418", "ENG-7"]);   // backlog before in progress; Done and the other Linear project are not shown
    expect(r.items[0]).toMatchObject({ projectId: "a", state: "Backlog", canStart: true, job: null });
  });
  it("finds a ticket by number, by key, or by title, including one that is finished", async () => {
    const s = setup();
    expect((await s.get("/api/board?q=418")).json().items.map((i: { key: string }) => i.key)).toEqual(["ENG-418"]);
    expect((await s.get("/api/board?q=eng-418")).json().items).toHaveLength(1);
    expect((await s.get("/api/board?q=JAM-418")).json().items).toEqual([]);                // a team this profile has no project for
    const done = (await s.get("/api/board?q=9")).json().items[0];
    expect(done).toMatchObject({ key: "ENG-9", canStart: false, reason: "already Done" });
    expect((await s.get("/api/board?q=Issue")).json().items.length).toBeGreaterThan(1);    // title match
  });
  it("says why a ticket cannot be started: project not onboarded, or already being worked on", async () => {
    const s = setup(false);
    expect((await s.get("/api/board")).json().items[0].reason).toMatch(/not passed validation|not onboarded/);
    const ready = setup();
    const id = ready.f.issues.values().next().value!.id;
    enqueue(ready.db, { projectId: "a", externalId: id, externalKey: "ENG-418" });
    const item = (await ready.get("/api/board")).json().items.find((i: { key: string }) => i.key === "ENG-418");
    expect(item).toMatchObject({ canStart: false, reason: "the factory is already working on it", job: { status: "queued" } });
  });
  it("starts a ticket: creates a manual job, records who started it, and refuses a second start", async () => {
    const s = setup();
    const id = s.f.issues.values().next().value!.id;
    const r = await s.post({ issueId: id });
    expect(r.statusCode, r.body).toBe(200);
    const job = s.db.select().from(jobs).where(eq(jobs.id, r.json().jobId)).get()!;
    expect(job).toMatchObject({ manual: true, projectId: "a", externalKey: "ENG-418", status: "queued", stage: "DISCOVERED" });
    expect((await s.post({ issueId: id })).statusCode).toBe(409);
  });
  it("refuses to start in a project that is not onboarded, a finished ticket, an unknown one, and any request without the dashboard origin or token", async () => {
    const s = setup(false);
    const first = s.f.issues.values().next().value!.id;
    expect((await s.post({ issueId: first })).statusCode).toBe(409);
    const ready = setup();
    const done = [...ready.f.issues.values()].find((i) => i.identifier === "ENG-9")!.id;
    expect((await ready.post({ issueId: done })).json().error).toMatch(/already Done/);
    expect((await ready.post({ issueId: "nope" })).statusCode).toBe(404);
    expect((await ready.post({ issueId: first }, HOST)).statusCode).toBe(401);
    expect((await ready.post({})).statusCode).toBe(400);
  });
});
