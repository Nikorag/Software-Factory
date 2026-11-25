import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FactoryConfig, LinearConfig, ProjectConfig, WorkflowsConfig } from "../src/config/schema.js";
import { openDb, type DbHandle } from "../src/db/client.js";
import { decisions, jobs, linearOutbox, projects } from "../src/db/schema.js";
import { Engine, type HandlerRegistry } from "../src/core/engine.js";
import { enqueue, getJob, retryJob } from "../src/core/jobs.js";
import { simulatedHandlers } from "../src/core/simulation.js";
import { LinearApiError } from "../src/linear/client.js";
import { discoverIssues } from "../src/linear/discovery.js";
import { evaluateEligibility } from "../src/linear/eligibility.js";
import { flushOutbox, uuidFromKey, FACTORY_MARKER } from "../src/linear/outbox.js";
import { createLinearReporter, statusForStage } from "../src/linear/reporter.js";
import { syncProjects, validateProjects } from "../src/repo/registry.js";
import { makeRepo, sh } from "./helpers/git-fixture.js";
import { FakeLinear } from "./helpers/fake-linear.js";

const logger = pino({ level: "silent" });
const linear = LinearConfig.parse({});
const proj = (over: Record<string, unknown> = {}) => ProjectConfig.parse({ id: "p", name: "P", repository: "/x", linear: { teamKey: "ENG" }, ...over });

describe("eligibility", () => {
  const fake = new FakeLinear();
  const issue = (o = {}) => fake.addIssue(o);
  const ok = { projectRunnable: true };
  it("accepts an opted-in issue in the pickup status", () => {
    expect(evaluateEligibility(issue(), proj(), linear, ok)).toMatchObject({ eligible: true, workflow: "feature", autonomous: false });
  });
  it("requires the enabled label, the pickup status, and no blocked label", () => {
    expect(evaluateEligibility(issue({ labels: [] }), proj(), linear, ok).reasons[0]).toMatch(/missing label/);
    expect(evaluateEligibility(issue({ state: "Backlog" }), proj(), linear, ok).eligible).toBe(false);
    expect(evaluateEligibility(issue({ labels: ["factory:enabled", "factory:blocked"] }), proj(), linear, ok).eligible).toBe(false);
  });
  it("needs both the issue label and project autonomy:full for autonomous", () => {
    const labelled = issue({ labels: ["factory:enabled", "factory:autonomous"] });
    expect(evaluateEligibility(labelled, proj({ autonomy: "full" }), linear, ok).autonomous).toBe(true);
    expect(evaluateEligibility(labelled, proj({ autonomy: "supervised" }), linear, ok).autonomous).toBe(false);
    expect(evaluateEligibility(issue(), proj({ autonomy: "full" }), linear, ok).autonomous).toBe(false);
  });
  it("rejects disabled/off/unvalidated projects, prior jobs, and conflicting type labels", () => {
    expect(evaluateEligibility(issue(), proj({ autonomy: "off" }), linear, ok).eligible).toBe(false);
    expect(evaluateEligibility(issue(), proj(), linear, { projectRunnable: false }).eligible).toBe(false);
    expect(evaluateEligibility(issue(), proj(), linear, { ...ok, existingJobStatus: "done" }).eligible).toBe(false);
    expect(evaluateEligibility(issue(), proj(), linear, { ...ok, existingJobStatus: "cancelled" }).eligible).toBe(true);
    expect(evaluateEligibility(issue({ labels: ["factory:enabled", "factory:bugfix", "factory:feature"] }), proj(), linear, ok).reasons.join()).toMatch(/conflicting/);
  });
  it("derives the workflow from the type label", () => {
    expect(evaluateEligibility(issue({ labels: ["factory:enabled", "factory:bugfix"] }), proj(), linear, ok).workflow).toBe("bugfix");
  });
});

describe("discovery", () => {
  let h: DbHandle; let fake: FakeLinear; let repo: string;
  const run = async (projects = [proj()], dryRun = false) => discoverIssues({ db: h.db, client: fake, linear, projects, logger, dryRun });
  beforeEach(async () => {
    h = openDb(":memory:"); fake = new FakeLinear();
    const m = makeRepo(); repo = m.repo; sh(repo, "remote", "set-url", "origin", "git@github.com:a/b.git");
    const p = proj({ repository: repo });
    syncProjects(h.db, [p]);
    await validateProjects(h.db, [p], { gh: async (path) => ({ status: /branches/.test(path) ? 404 : 200, body: {} }) });
  });
  const P = () => proj({ repository: repo });

  describe("onboarding gate (what the service turns on)", () => {
    const gated = (projects = [proj({ repository: repo, commands: { test: "npm test" } })]) => discoverIssues({ db: h.db, client: fake, linear, projects, logger, requireOnboarding: true });
    it("skips tickets of a project whose onboarding is incomplete, saying exactly what is left", async () => {
      fake.addIssue({ key: "ENG-1" });
      const r = await gated();                                   // validated, but Spec Kit is not on the default branch and checks never ran
      expect(r.enqueued).toEqual([]);
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped[0]!.reasons[0]).toMatch(/not onboarded yet.*spec kit set up on the default branch.*commands verified.*Settings > Projects/);
      expect(h.db.select().from(jobs).all()).toEqual([]);       // no job was created, so nothing waits in a blocked state
    });
    it("picks the ticket up on the next poll once onboarding is complete", async () => {
      fake.addIssue({ key: "ENG-1" });
      const p = proj({ repository: repo, commands: { test: "npm test" }, linear: { teamKey: "ENG" } });
      await gated([p]);
      const row = h.db.select().from(projects).where(eq(projects.id, "p")).get()!;
      const report = JSON.parse(row.validationJson!);
      h.db.update(projects).set({ validationJson: JSON.stringify({ ...report, hasSpecKit: true }), checkJson: JSON.stringify({ ok: true, at: Date.now() }) }).where(eq(projects.id, "p")).run();
      const r = await gated([p]);
      expect(r.enqueued.map((e) => e.key)).toEqual(["ENG-1"]);
    });
    it("a failed command check keeps the project skipped", async () => {
      fake.addIssue({ key: "ENG-1" });
      const p = proj({ repository: repo, commands: { test: "npm test" }, linear: { teamKey: "ENG" } });
      const row = h.db.select().from(projects).where(eq(projects.id, "p")).get()!;
      h.db.update(projects).set({ validationJson: JSON.stringify({ ...JSON.parse(row.validationJson!), hasSpecKit: true }), checkJson: JSON.stringify({ ok: false, at: Date.now() }) }).where(eq(projects.id, "p")).run();
      expect((await gated([p])).enqueued).toEqual([]);
    });
    it("without the gate (tests, dry runs of the old behaviour) nothing changes", async () => {
      fake.addIssue({ key: "ENG-1" });
      expect((await run([P()])).enqueued).toHaveLength(1);
    });
  });

  it("creates one job per eligible issue and is idempotent across polls", async () => {
    fake.addIssue({ key: "ENG-1" }); fake.addIssue({ key: "ENG-2", labels: [] });
    const a = await run([P()]);
    expect(a.enqueued.map((e) => e.key)).toEqual(["ENG-1"]);
    expect(a.skipped.map((s) => s.key)).toEqual([]); // ENG-2 never matched the server-side label filter
    const b = await run([P()]);
    expect(b.enqueued).toEqual([]);
    expect(h.db.select().from(jobs).all()).toHaveLength(1);
  });
  it("queues a pickup comment (once) and records the decision", async () => {
    fake.addIssue({ key: "ENG-1" });
    await run([P()]); await run([P()]);
    expect(h.db.select().from(linearOutbox).all().filter((o) => o.kind === "comment")).toHaveLength(1);
    expect(h.db.select().from(decisions).all().some((d) => d.kind === "discovery.accept")).toBe(true);
  });
  it("never re-runs an issue whose job already finished, even if it is still in the pickup status", async () => {
    fake.addIssue({ key: "ENG-1" });
    const { enqueued } = await run([P()]);
    h.db.update(jobs).set({ status: "done", stage: "COMPLETED" }).where(eq(jobs.id, enqueued[0]!.jobId)).run();
    expect((await run([P()])).enqueued).toEqual([]);
  });
  it("does not accept issues for an unvalidated project", async () => {
    fake.addIssue({ key: "ENG-1" });
    h.db.update((await import("../src/db/schema.js")).projects).set({ validationJson: null }).run();
    const r = await run([P()]);
    expect(r.enqueued).toEqual([]);
    expect(r.skipped[0]!.reasons.join()).toMatch(/not passed validation/);
  });
  it("routes by most specific binding and refuses ambiguous mappings", async () => {
    fake.addIssue({ key: "ENG-1", project: "proj-a" }); fake.addIssue({ key: "ENG-2", project: "proj-b" });
    const teamWide = P();
    const scoped = proj({ id: "q", repository: repo, linear: { teamKey: "ENG", projectId: "proj-a" } });
    syncProjects(h.db, [teamWide, scoped]);
    await validateProjects(h.db, [scoped], { gh: async (path) => ({ status: /branches/.test(path) ? 404 : 200, body: {} }) });
    const r = await run([teamWide, scoped]);
    expect(Object.fromEntries(r.enqueued.map((e) => [e.key, e.projectId]))).toEqual({ "ENG-1": "q", "ENG-2": "p" });
    fake.addIssue({ key: "ENG-3", project: "proj-a" });
    const twin = proj({ id: "r", repository: repo, linear: { teamKey: "ENG", projectId: "proj-a" } });
    syncProjects(h.db, [twin]);
    const r2 = await run([scoped, twin]);
    expect(r2.skipped.some((s) => s.key === "ENG-3" && /ambiguous/.test(s.reasons[0]!))).toBe(true);
  });
  it("binds each Linear project (by name) to its own repo, and never crosses them", async () => {
    fake.addIssue({ key: "JAM-1", team: "JAM", project: "Alpha" }); fake.addIssue({ key: "JAM-2", team: "JAM", project: "Beta" }); fake.addIssue({ key: "JAM-3", team: "JAM", project: "Gamma" });
    const mkp = (id: string, name: string) => proj({ id, repository: repo, linear: { teamKey: "JAM", projectName: name } });
    const [a, b] = [mkp("alpha", "Alpha"), mkp("beta", "Beta")];
    syncProjects(h.db, [a, b]);
    await validateProjects(h.db, [a, b], { gh: async (path) => ({ status: /branches/.test(path) ? 404 : 200, body: {} }) });
    const r = await run([a, b]);
    expect(Object.fromEntries(r.enqueued.map((e) => [e.key, e.projectId]))).toEqual({ "JAM-1": "alpha", "JAM-2": "beta" }); // Gamma is unmapped: ignored
  });
  it("one failing project does not stop discovery for the others", async () => {
    fake.addIssue({ key: "ENG-1" });
    fake.failOn("listIssues", new LinearApiError("boom", false), 1);
    const other = proj({ id: "q", repository: repo });
    syncProjects(h.db, [other]);
    const r = await run([other, P()]);
    expect(r.errors).toHaveLength(1);
    expect(r.enqueued.map((e) => e.key)).toEqual(["ENG-1"]);
  });
  it("carries dry-run onto the job and queues no Linear writes", async () => {
    fake.addIssue({ key: "ENG-1" });
    const r = await run([P()], true);
    expect(h.db.select().from(jobs).get()?.dryRun).toBe(true);
    expect(r.enqueued).toHaveLength(1);
    expect(h.db.select().from(linearOutbox).all()).toHaveLength(0);
  });
});

describe("stage -> status mapping", () => {
  it("maps stage groups to configured statuses", () => {
    expect(statusForStage("SPECIFICATION_REVIEW")).toBe("specificationReview");
    expect(statusForStage("IMPLEMENTATION")).toBe("inProgress");
    expect(statusForStage("REMEDIATION")).toBe("inProgress");
    expect(statusForStage("CI_VALIDATION")).toBe("readyForReview");
    expect(statusForStage("MERGING")).toBe("readyForReview"); // PR-only: waiting for a human
    expect(statusForStage("COMPLETED")).toBe("done");
    expect(statusForStage("FAILED")).toBe("blocked");
    expect(statusForStage("DISCOVERED")).toBeUndefined();
  });
});

describe("outbox + reporter end to end", () => {
  let h: DbHandle; let fake: FakeLinear;
  const cfg = { factory: FactoryConfig.parse({}), workflows: WorkflowsConfig.parse({ defaults: { timeoutSeconds: 5, maxRetries: 0 } }) };
  const mk = (handlers: HandlerRegistry, extra = {}) => new Engine({ db: h.db, logger, config: cfg, handlers, backoffBaseMs: 0, heartbeatMs: 10, observer: createLinearReporter(h.db), ...extra });
  const flush = () => flushOutbox({ db: h.db, client: fake, linear, logger, backoffBaseMs: 0 });
  const newJob = (dryRun = false) => {
    h.db.insert((require_projects())).values({ id: "p", configJson: "{}" }).onConflictDoNothing().run();
    const issue = fake.addIssue({ key: "ENG-1" });
    return enqueue(h.db, { projectId: "p", externalId: issue.id, externalKey: "ENG-1", dryRun }).job;
  };
  beforeEach(() => { h = openDb(":memory:"); fake = new FakeLinear(); });

  it("drives the issue through the configured statuses to Done", async () => {
    const job = newJob();
    await mk(simulatedHandlers()).tick();
    await flush();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
    expect(fake.issues.get(job.externalId)!.state.name).toBe("Done");
    const states = fake.calls.filter((c) => c.startsWith("setState")).map((c) => c.split(":")[2]);
    expect(states).toEqual(["Done"]); // flushed once at the end: intermediate states coalesce into the final truth
    expect(h.db.select().from(linearOutbox).all().every((o) => o.status === "done")).toBe(true);
  });
  it("records each distinct status transition in order when flushed as it goes", async () => {
    const job = newJob();
    const tracked: HandlerRegistry = Object.fromEntries(Object.entries(simulatedHandlers()).map(([k, fn]) => [k, async (c: never) => { await flush(); return fn!(c); }]));
    await mk(tracked).tick();
    await flush();
    const states = fake.calls.filter((c) => c.startsWith("setState")).map((c) => c.split(":")[2]);
    expect(states).toEqual(["Specification review", "In progress", "Ready for review", "Done"]);
    expect(fake.issues.get(job.externalId)!.state.name).toBe("Done");
  });
  it("blocks the issue with a label and an explanatory comment, and unblocks on retry", async () => {
    const job = newJob();
    await mk({ ...simulatedHandlers(), REQUIREMENTS_ANALYSIS: async () => ({ kind: "needs_attention", reason: "ticket is ambiguous: which database?" }) }).tick();
    await flush();
    const issue = fake.issues.get(job.externalId)!;
    expect(issue.state.name).toBe("Blocked");
    expect(issue.labels.map((l) => l.name)).toContain("factory:blocked");
    expect(issue.comments.at(-1)!.body).toContain("which database?");
    expect(issue.comments.at(-1)!.body).toContain(FACTORY_MARKER);
    retryJob(h.db, job.id, "human");
    await mk(simulatedHandlers()).tick();
    await flush();
    expect(fake.issues.get(job.externalId)!.labels.map((l) => l.name)).not.toContain("factory:blocked");
    expect(fake.issues.get(job.externalId)!.state.name).toBe("Done");
  });
  it("survives Linear outages: writes stay pending, order is preserved, nothing is lost or duplicated", async () => {
    const job = newJob();
    fake.failOn("getIssue", new LinearApiError("Linear server error", true, 503), 2);
    await mk(simulatedHandlers()).tick();
    expect((await flush()).pending).toBeGreaterThan(0);
    expect(fake.issues.get(job.externalId)!.state.name).toBe("Ready for specification");
    await flush(); // second injected failure
    const r = await flush();
    expect(r.failed).toBe(0);
    expect(fake.issues.get(job.externalId)!.state.name).toBe("Done");
  });
  it("does not duplicate a comment whose first attempt succeeded but looked like a failure", async () => {
    const job = newJob();
    fake.failOn("createComment", new LinearApiError("socket hang up", true), 1, true /* stored before failing */);
    await mk({ ...simulatedHandlers(), REQUIREMENTS_ANALYSIS: async () => ({ kind: "blocked", reason: "needs info" }) }).tick();
    await flush();
    await flush();
    expect(fake.issues.get(job.externalId)!.comments.filter((c) => c.body.includes("needs info"))).toHaveLength(1);
  });
  it("marks a write failed (and moves on) when configuration names something Linear lacks", async () => {
    const job = newJob();
    const bad = LinearConfig.parse({ statuses: { done: "Shipped" } });
    await mk(simulatedHandlers()).tick();
    const r = await flushOutbox({ db: h.db, client: fake, linear: bad, logger, backoffBaseMs: 0 });
    expect(r.failed).toBe(1);
    expect(h.db.select().from(linearOutbox).where(eq(linearOutbox.status, "failed")).get()?.lastError).toMatch(/Shipped.*does not exist/);
    expect(h.db.select().from(decisions).all().some((d) => d.kind === "linear.write_failed")).toBe(true);
    void job;
  });
  it("dry-run jobs queue nothing and record what would have been sent", async () => {
    newJob(true);
    await mk(simulatedHandlers()).tick();
    expect(h.db.select().from(linearOutbox).all()).toHaveLength(0);
    expect(h.db.select().from(decisions).all().filter((d) => d.decision.startsWith("would send to Linear")).length).toBeGreaterThan(0);
    expect(fake.calls).toEqual([]);
  });
  it("uses stable comment ids derived from the idempotency key", () => {
    expect(uuidFromKey("a")).toBe(uuidFromKey("a"));
    expect(uuidFromKey("a")).not.toBe(uuidFromKey("b"));
    expect(uuidFromKey("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("an observer failure never breaks orchestration", async () => {
    const job = newJob();
    const e = new Engine({ db: h.db, logger, config: cfg, handlers: simulatedHandlers(), observer: { onStage() { throw new Error("reporter bug"); } } });
    await e.tick();
    expect(getJob(h.db, job.id)!.stage).toBe("COMPLETED");
  });
});

import { projects as projectsTable } from "../src/db/schema.js";
function require_projects() { return projectsTable; }
