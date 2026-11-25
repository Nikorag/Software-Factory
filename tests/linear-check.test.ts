import { describe, expect, it } from "vitest";
import { LinearConfig } from "../src/config/schema.js";
import { auditTeam, REQUIRED_LABELS, REQUIRED_STATUSES } from "../src/linear/check.js";
import { FakeLinear } from "./helpers/fake-linear.js";

const team = { id: "team-1", key: "JAM", name: "Zonto Games" };
const cfg = LinearConfig.parse({});

describe("auditTeam", () => {
  it("passes when everything exists", async () => {
    const a = await auditTeam(new FakeLinear(), cfg, team);
    expect(a).toMatchObject({ ok: true, statuses: [], labels: [] });
  });
  it("reproduces the real JAM situation: only 'In progress' and 'Done' exist, no factory labels", async () => {
    const f = new FakeLinear();
    f.states = f.states.filter((s) => ["Backlog", "Todo", "In progress", "Done", "Canceled"].includes(s.name) || s.name === "In progress" || s.name === "Done");
    f.labelDefs = [{ id: "x", name: "Bug" }];
    const a = await auditTeam(f, cfg, team);
    const reqMissing = [...a.statuses, ...a.labels].filter((g) => g.required).map((g) => g.name).sort();
    expect(reqMissing).toEqual(["Blocked", "Merging", "Ready for review", "Ready for specification", "Specification review", "factory:blocked", "factory:enabled"].sort());
    expect(a.ok).toBe(false);
    expect(a.statuses.filter((g) => !g.required).map((g) => g.name).sort()).toEqual(["Changes requested", "Ready for development"]);
    expect(a.labels.filter((g) => !g.required).map((g) => g.name).sort()).toEqual(["factory:autonomous", "factory:bugfix", "factory:feature", "factory:maintenance"]);
    expect(a.existingStatuses).toEqual(expect.arrayContaining(["In progress", "Done"]));
  });
  it("is ok when only optional items are missing", async () => {
    const f = new FakeLinear();
    f.states = f.states.filter((s) => !["Ready for development", "Changes requested"].includes(s.name));
    f.labelDefs = f.labelDefs.filter((l) => ["factory:enabled", "factory:blocked"].includes(l.name));
    const a = await auditTeam(f, cfg, team);
    expect(a.ok).toBe(true);
    expect(a.statuses.concat(a.labels).every((g) => !g.required)).toBe(true);
  });
  it("matches names case-insensitively and honours renamed config", async () => {
    const f = new FakeLinear();
    const c = LinearConfig.parse({ statuses: { done: "shipped" } });
    f.states.find((s) => s.name === "Done")!.name = "Shipped";
    expect((await auditTeam(f, c, team)).statuses.map((g) => g.key)).not.toContain("done");
  });
  it("the 'required' sets are exactly what the reporter and discovery actually write", () => {
    expect(REQUIRED_STATUSES.sort()).toEqual(["blocked", "done", "inProgress", "merging", "readyForReview", "readyForSpecification", "specificationReview"]);
    expect(REQUIRED_LABELS.sort()).toEqual(["blocked", "enabled"]);
  });
});
