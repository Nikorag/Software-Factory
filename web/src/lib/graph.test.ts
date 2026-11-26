import { describe, expect, it } from "vitest";
import { customDefinition, defaultDefinition, stage } from "../test-fixtures";
import { compile, executionOrder, H, layoutDefinition, rawEdges, W } from "./graph";
import type { WorkflowDef } from "./workflows";

describe("execution order", () => {
  it("follows the success path, then fix steps only failures reach, then disabled stages", () => {
    const def = defaultDefinition();
    const o = executionOrder(def);
    expect(o.main[0]).toBe("DISCOVERED"); expect(o.main.at(-1)).toBe("LINEAR_COMPLETION");
    expect(o.main).not.toContain("REMEDIATION");
    expect(o.side).toEqual(["SPECIFICATION_REMEDIATION", "REMEDIATION"]);
    const d2: WorkflowDef = { ...def, stages: def.stages.map((s) => (s.id === "MERGE_VALIDATION" ? { ...s, enabled: false, required: false } : s)) };
    expect(executionOrder(d2).disabled).toEqual(["MERGE_VALIDATION"]);
    expect(executionOrder(d2).main).not.toContain("MERGE_VALIDATION");
  });
  it("walks both branches of a conditional", () => {
    const o = executionOrder(customDefinition());
    expect(o.main).toEqual(["ELIGIBILITY_CHECK", "TRIAGE", "DOCS_CHECK", "WRITE_DOCS", "REVIEW", "BUILD"]);
    expect(o.side).toEqual(["FIXUP"]);
  });
  it("passes over disabled stages like the engine does", () => {
    const def: WorkflowDef = { schemaVersion: 1, limits: {}, stages: [stage("A"), stage("B", { enabled: false, required: false }), stage("C")] };
    const c = compile(def);
    expect(c.next("A")).toBe("C"); expect(c.resolve("B")).toBe("C"); expect(c.entry).toBe("A");
    expect(executionOrder(def).main).toEqual(["A", "C"]);
  });
});

describe("draft to edges", () => {
  it("draws success edges from next/order, branches from a conditional, and failure routes as loop edges", () => {
    const edges = rawEdges(customDefinition());
    const find = (a: string, b: string) => edges.find((e) => e.from === a && e.to === b);
    expect(find("TRIAGE", "DOCS_CHECK")).toMatchObject({ kind: "flow" });
    expect(find("DOCS_CHECK", "WRITE_DOCS")).toMatchObject({ kind: "flow", labels: ["then"] });
    expect(find("DOCS_CHECK", "BUILD")).toMatchObject({ kind: "flow", labels: ["else"] });
    expect(find("WRITE_DOCS", "REVIEW")).toMatchObject({ kind: "flow" }); // explicit next
    expect(find("REVIEW", "FIXUP")).toMatchObject({ kind: "loop", labels: ["findings"] });
    expect(find("FIXUP", "REVIEW")).toMatchObject({ kind: "flow" });
    expect(find("REVIEW", "COMPLETED")).toBeTruthy();
  });
  it("draws no edges for disabled stages, and re-points routes past them", () => {
    const def: WorkflowDef = { schemaVersion: 1, limits: {}, stages: [stage("A", { next: "B" }), stage("B", { enabled: false, required: false }), stage("C")] };
    const e = rawEdges(def);
    expect(e.map((x) => `${x.from}>${x.to}`)).toEqual(["A>C", "C>COMPLETED"]);
  });
  it("merges a failure route that duplicates a success edge into the success edge", () => {
    const def: WorkflowDef = { schemaVersion: 1, limits: {}, stages: [stage("A", { onFailure: [{ on: "gate", action: "goto", target: "B" }] }), stage("B")] };
    expect(rawEdges(def).filter((e) => e.from === "A" && e.to === "B")).toEqual([{ from: "A", to: "B", kind: "flow", labels: ["gate"] }]);
  });
});

describe("layout", () => {
  it("lays any number of stages out in rows of six with an end node, inside the drawing", () => {
    for (const count of [1, 2, 6, 7, 13, 40]) {
      const def: WorkflowDef = { schemaVersion: 1, limits: {}, stages: Array.from({ length: count }, (_, i) => stage(`S${i}`)) };
      const g = layoutDefinition(def);
      expect(g.nodes.length).toBe(count + 1);
      expect(Math.max(...g.nodes.map((n) => n.col))).toBeLessThan(6);
      for (const nd of g.nodes) { expect(nd.x).toBeGreaterThanOrEqual(0); expect(nd.x + W).toBeLessThanOrEqual(g.width); expect(nd.y + H).toBeLessThanOrEqual(g.height); }
      expect(new Set(g.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(g.nodes.length); // nothing overlaps
    }
  });
  it("puts the fix steps in their own band and gives every edge a path", () => {
    const g = layoutDefinition(defaultDefinition());
    expect(g.nodes.filter((n) => n.side).map((n) => n.id)).toEqual(["SPECIFICATION_REMEDIATION", "REMEDIATION"]);
    expect(g.bands.map((b) => b.title)).toEqual(["Fix and recovery steps"]);
    const side = g.byId.REMEDIATION!, main = g.byId.AUTOMATED_TESTING!;
    expect(side.y).toBeGreaterThan(main.y);
    expect(g.edges.length).toBe(rawEdges(defaultDefinition()).length);
    for (const e of g.edges) expect(e.d).toMatch(/^M-?\d+,-?\d+( L-?\d+,-?\d+)+$/);
    expect(g.edges.find((e) => e.id === "AUTOMATED_TESTING>REMEDIATION")).toMatchObject({ kind: "loop", label: "findings" });
    // the same definition always lays out the same way
    expect(layoutDefinition(defaultDefinition())).toEqual(g);
  });
  it("wraps the success path from the end of a row to the start of the next, and uses the stage names it is given", () => {
    const g = layoutDefinition(defaultDefinition(), { DISCOVERED: "Picked up" });
    expect(g.byId.DISCOVERED!.label).toBe("Picked up");
    const wrap = g.edges.find((e) => e.id === "SPECIFICATION_VALIDATION>IMPLEMENTATION_PREPARATION")!;
    expect(g.byId.SPECIFICATION_VALIDATION!.row).toBe(0); expect(g.byId.IMPLEMENTATION_PREPARATION!.row).toBe(1);
    expect(wrap.d.split(" L").length).toBeGreaterThanOrEqual(5);
  });
  it("keeps every route inside the drawing, for the built-in and a custom workflow", () => {
    for (const def of [defaultDefinition(), customDefinition()]) {
      const g = layoutDefinition(def);
      for (const e of g.edges) for (const pt of e.d.replace(/[ML]/g, " ").trim().split(/\s+/)) { const [x, y] = pt.split(",").map(Number); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(g.width); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(g.height); }
    }
  });
  it("shows disabled stages in a band of their own, dimmed", () => {
    const def: WorkflowDef = { schemaVersion: 1, limits: {}, stages: [stage("A"), stage("B", { enabled: false, required: false }), stage("C")] };
    const g = layoutDefinition(def);
    expect(g.byId.B).toMatchObject({ disabled: true, side: true });
    expect(g.bands.some((b) => b.title === "Disabled steps")).toBe(true);
  });
  it("handles a draft that points at a missing stage without throwing", () => {
    const def: WorkflowDef = { schemaVersion: 1, limits: {}, stages: [stage("A", { next: "GONE" }), stage("B")] };
    expect(() => layoutDefinition(def)).not.toThrow();
  });
});
