import pino from "pino";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FactoryConfig, ProjectConfig, WorkflowsConfig, type StageName } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { jobs, projects } from "../src/db/schema.js";
import { Engine, type HandlerRegistry } from "../src/core/engine.js";
import { enqueue, getJob } from "../src/core/jobs.js";
import { simulatedHandlers } from "../src/core/simulation.js";
import { ModelRouter } from "../src/agents/router.js";
import { ModelsConfig } from "../src/config/schema.js";

const proj = (id: string, overrides?: object) => ProjectConfig.parse({ id, name: id, repository: `/x/${id}`, overrides });

function setup(max: number, projs: ReturnType<typeof proj>[], handlerFor: (stage: StageName) => HandlerRegistry[StageName]) {
  const h = openDb(":memory:");
  for (const p of projs) h.db.insert(projects).values({ id: p.id, configJson: "{}" }).run();
  const base = simulatedHandlers();
  const handlers = { ...base, IMPLEMENTATION: handlerFor("IMPLEMENTATION") } as HandlerRegistry;
  const engine = new Engine({
    db: h.db, logger: pino({ level: "silent" }), handlers, backoffBaseMs: 0, heartbeatMs: 20,
    config: { factory: FactoryConfig.parse({ maxConcurrentJobs: max }), workflows: WorkflowsConfig.parse({ defaults: { timeoutSeconds: 10, maxRetries: 0 } }), projects: { projects: projs } },
  });
  const add = (project: string, ext: string) => enqueue(h.db, { projectId: project, externalId: ext, externalKey: ext.toUpperCase() }).job;
  return { h, engine, add };
}

/** An IMPLEMENTATION handler that records how many run at once, and holds until released. */
function gate() {
  let current = 0, peak = 0;
  const waiters: (() => void)[] = [];
  const handler: HandlerRegistry[StageName] = async () => { current++; peak = Math.max(peak, current); await new Promise<void>((r) => waiters.push(r)); current--; return { kind: "ok", output: {} }; };
  return { handler, peak: () => peak, running: () => current, releaseAll: () => { while (waiters.length) waiters.shift()!(); } };
}
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); expect(f()).toBe(true); };

describe("job concurrency", () => {
  it("runs jobs from different projects in parallel, up to the global limit", async () => {
    const g = gate();
    const { engine, add } = setup(2, [proj("a"), proj("b"), proj("c")], () => g.handler);
    add("a", "j1"); add("b", "j2"); add("c", "j3");
    expect(engine.start()).toBe(2);                   // the global limit
    await until(() => g.running() === 2);
    expect(engine.start()).toBe(0);                   // full: the third waits
    g.releaseAll();
    await new Promise((r) => setTimeout(r, 50)); g.releaseAll();
    await engine.idle();
    expect(g.peak()).toBe(2);
  });
  it("by default runs only one job per project at a time, even when the global limit is higher (they share a clone)", async () => {
    const g = gate();
    const { engine, add, h } = setup(4, [proj("a")], () => g.handler);
    add("a", "j1"); add("a", "j2");
    expect(engine.start()).toBe(1);
    await until(() => g.running() === 1);
    expect(engine.start()).toBe(0);
    expect(h.db.select().from(jobs).where(eq(jobs.status, "queued")).all()).toHaveLength(1);
    g.releaseAll();
    await engine.idle();
    // the second one runs once the first has finished
    const t = engine.tick(); await until(() => g.running() === 1); g.releaseAll(); await t;
    expect(g.peak()).toBe(1);
  });
  it("a project can opt in to more than one at a time", async () => {
    const g = gate();
    const { engine, add } = setup(4, [proj("a", { maxConcurrentJobs: 2 })], () => g.handler);
    add("a", "j1"); add("a", "j2"); add("a", "j3");
    expect(engine.start()).toBe(2);
    await until(() => g.running() === 2);
    g.releaseAll(); await new Promise((r) => setTimeout(r, 50)); g.releaseAll(); await engine.idle();
    expect(g.peak()).toBe(2);
  });
  it("one project's cap never starves another project", async () => {
    const g = gate();
    const { engine, add } = setup(2, [proj("a"), proj("b")], () => g.handler);
    add("a", "j1"); add("a", "j2"); add("b", "j3");   // j2 is blocked by a's cap, but j3 (project b) still runs
    expect(engine.start()).toBe(2);
    await until(() => g.running() === 2);
    g.releaseAll(); await new Promise((r) => setTimeout(r, 50)); g.releaseAll(); await engine.idle();
  });
  it("tick() still runs everything to completion (what `factory work` relies on)", async () => {
    const { engine, add, h } = setup(1, [proj("a")], () => async () => ({ kind: "ok", output: {} }));
    const j = add("a", "j1");
    expect(await engine.tick()).toBe(1);
    expect(getJob(h.db, j.id)!.status).toBe("done");
  });
  it("does not start anything while paused", () => {
    const g = gate();
    const { engine, add, h } = setup(2, [proj("a")], () => g.handler);
    add("a", "j1");
    h.db.run(`update factory_state set paused = 1 where id = 1`);
    expect(engine.start()).toBe(0);
  });
});

describe("fix-cycle limit", () => {
  it("uses the project's own limit when it has one, else the global one", () => {
    const { engine } = setup(1, [proj("a", { maxRemediationAttempts: 1 }), proj("b")], () => async () => ({ kind: "ok", output: {} }));
    expect(engine.remediationCap({ projectId: "a" })).toBe(1);
    expect(engine.remediationCap({ projectId: "b" })).toBe(3);
  });
  it("stops a job for a human when ITS project's cap is exceeded", async () => {
    const h = openDb(":memory:"); h.db.insert(projects).values({ id: "a", configJson: "{}" }).run();
    const base = simulatedHandlers();
    const reg = { ...base, AUTOMATED_TESTING: async () => ({ kind: "remediate", reason: "tests failing" }) } as HandlerRegistry;
    const engine = new Engine({ db: h.db, logger: pino({ level: "silent" }), handlers: reg, backoffBaseMs: 0, heartbeatMs: 20,
      config: { factory: FactoryConfig.parse({ maxRemediationAttempts: 3 }), workflows: WorkflowsConfig.parse({ defaults: { timeoutSeconds: 10, maxRetries: 0 } }), projects: { projects: [proj("a", { maxRemediationAttempts: 1 })] } } });
    const j = enqueue(h.db, { projectId: "a", externalId: "e", externalKey: "E" }).job;
    await engine.tick();
    expect(getJob(h.db, j.id)).toMatchObject({ stage: "NEEDS_ATTENTION" });
    expect(getJob(h.db, j.id)!.lastError).toContain("remediation attempts exhausted (1)");
  });
});

describe("per-project models", () => {
  const routes = ModelsConfig.parse({ routes: { classification: { provider: "anthropic", model: "haiku" }, specification: { provider: "anthropic", model: "default" }, implementation: { provider: "anthropic", model: "default" }, independent_review: { provider: "anthropic", model: "haiku" }, final_review: { provider: "anthropic", model: "default" } } });
  const router = new ModelRouter(routes, { anthropic: {} as never, local: {} as never }, (id) => (id === "careful" ? { implementation: { provider: "anthropic", model: "opus" }, independent_review: { provider: "anthropic", model: "sonnet" } } : undefined));
  it("uses the project's model for the tasks it overrides, the global one for the rest", () => {
    expect(router.route("implementation", "careful").model).toBe("opus");
    expect(router.route("independent_review", "careful").model).toBe("sonnet");
    expect(router.route("specification", "careful").model).toBe("default");   // not overridden
    expect(router.route("implementation", "other").model).toBe("default");    // a different project
    expect(router.route("implementation").model).toBe("default");             // no project (e.g. onboarding)
  });
  it("refuses a project override that would give specification or implementation a local model", () => {
    expect(() => proj("x", { models: { implementation: { provider: "local", model: "m" } } })).toThrow(/must use provider `anthropic`/);
  });
});
