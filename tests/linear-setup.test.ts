import { describe, expect, it } from "vitest";
import { LinearConfig } from "../src/config/schema.js";
import { auditTeam } from "../src/linear/check.js";
import { applySetup, planSetup } from "../src/linear/setup.js";
import { LinearApiError } from "../src/linear/client.js";
import { FakeLinear } from "./helpers/fake-linear.js";

const team = { id: "team-1", key: "JAM", name: "Zonto Games" };
const cfg = LinearConfig.parse({});
/** The real JAM workspace: only "In progress" and "Done" among the factory's statuses, and none of its labels. */
const jam = () => {
  const f = new FakeLinear();
  f.states = f.states.filter((s) => ["Backlog", "In progress", "Done"].includes(s.name));
  f.labelDefs = [{ id: "bug", name: "Bug" }];
  return f;
};

describe("planSetup", () => {
  it("plans exactly the 4 required statuses and 2 required labels for JAM, and nothing optional", async () => {
    const plan = planSetup(await auditTeam(jam(), cfg, team));
    expect(plan.map((a) => `${a.kind}:${a.name}`).sort()).toEqual([
      "label:factory:blocked", "label:factory:enabled",
      "status:Blocked", "status:Ready for review", "status:Ready for specification", "status:Specification review",
    ].sort());
  });
  it("adds the optional ones only on request", async () => {
    const plan = planSetup(await auditTeam(jam(), cfg, team), { includeOptional: true });
    expect(plan).toHaveLength(4 + 2 + 3 + 4);
    expect(plan.map((a) => a.name)).toEqual(expect.arrayContaining(["factory:autonomous", "factory:bugfix", "Changes requested"]));
  });
  it("gives sensible Linear state types: pickup is unstarted, working states started, done completed", async () => {
    const types = Object.fromEntries(planSetup(await auditTeam(jam(), cfg, team), { includeOptional: true }).flatMap((a) => (a.kind === "status" ? [[a.name, a.type]] : [])));
    expect(types).toMatchObject({ "Ready for specification": "unstarted", "Specification review": "started", Blocked: "started" });
    for (const t of Object.values(types)) expect(["unstarted", "started", "completed"]).toContain(t);
  });
});

describe("applySetup", () => {
  it("creates only what is missing and then the audit passes", async () => {
    const f = jam();
    const r = await applySetup(f, cfg, team);
    expect(r.failed).toEqual([]);
    expect(r.created).toHaveLength(6);
    expect((await auditTeam(f, cfg, team)).ok).toBe(true);
    expect(f.calls.filter((c) => c.startsWith("createState:Done") || c.startsWith("createState:In progress"))).toEqual([]); // never touches existing
  });
  it("is idempotent: a second run creates nothing", async () => {
    const f = jam();
    await applySetup(f, cfg, team);
    f.calls.length = 0;
    const again = await applySetup(f, cfg, team);
    expect(again).toEqual({ created: [], failed: [] });
    expect(f.calls.filter((c) => c.startsWith("create"))).toEqual([]);
  });
  it("matches existing names case-insensitively and never duplicates them", async () => {
    const f = jam();
    f.states.push({ id: "x", name: "BLOCKED", type: "started" });
    f.labelDefs.push({ id: "y", name: "Factory:Enabled" });
    const r = await applySetup(f, cfg, team);
    expect(r.created.join()).not.toMatch(/"Blocked"|factory:enabled/);
    expect(r.created).toHaveLength(4);
  });
  it("reports a failure, carries on with the rest, and a retry finishes the job", async () => {
    const f = jam();
    f.failOn("createWorkflowState", new LinearApiError("forbidden", false), 1);
    const r = await applySetup(f, cfg, team);
    expect(r.failed).toHaveLength(1);
    expect(r.created).toHaveLength(5);
    expect((await applySetup(f, cfg, team)).created).toHaveLength(1);
    expect((await auditTeam(f, cfg, team)).ok).toBe(true);
  });
});
