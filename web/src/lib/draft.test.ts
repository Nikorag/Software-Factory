import { describe, expect, it } from "vitest";
import { customDefinition, defaultDefinition, META, stage } from "../test-fixtures";
import { describeGate, gateSummary } from "./describe";
import { atField, availableHandlers, changeType, defaultRouteOf, gateSize, gateTypesFor, insertStage, issueCounts, issuesForStage, joinField, lockedHandlers, moveStage, newGate, newStage, parseField, parseValue, removeStage, sameDef, uniqueId, updateGateAt, updateStage, workflowIssues } from "./draft";
import type { Gate, Issue, WorkflowDef } from "./workflows";

const base = (): WorkflowDef => ({ schemaVersion: 1, limits: {}, stages: [stage("ELIGIBILITY_CHECK", { type: "factory", handler: "ELIGIBILITY_CHECK" }), stage("ANALYSIS")] });

describe("stage ids and new stages", () => {
  it("makes unique, valid ids from names, never a built-in or reserved one", () => {
    expect(uniqueId("Docs check", [])).toBe("DOCS_CHECK");
    expect(uniqueId("Docs check", ["DOCS_CHECK"])).toBe("DOCS_CHECK_2");
    expect(uniqueId("Implementation", [], ["IMPLEMENTATION"])).toBe("IMPLEMENTATION_2");
    expect(uniqueId("completed", [])).toBe("COMPLETED_2");
    expect(uniqueId("123 go", [])).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    expect(uniqueId("", [])).toBe("STEP");
    expect(uniqueId("x".repeat(100), []).length).toBeLessThanOrEqual(48);
  });
  it("starts a stage from the type's defaults in the meta, with a copy of them (editing it never edits the meta)", () => {
    const a = newStage(META, base(), "review", { name: "Security look" });
    expect(a).toMatchObject({ id: "SECURITY_LOOK", type: "review", config: { role: "qa-reviewer", blocking: ["blocker", "major"] }, prompt: { template: "Review {{ticket.identifier}}" }, successGate: { type: "all" } });
    (a.config.blocking as string[]).push("minor");
    expect(META.stageTypes.find((t) => t.type === "review")!.defaultConfig.blocking).toEqual(["blocker", "major"]);
    expect(newStage(META, base(), "check")).toMatchObject({ id: "COMMAND_CHECK", config: { command: "test" }, successGate: { type: "exit_code_zero" } });
    expect(newStage(META, base(), "conditional").config).toMatchObject({ then: "COMPLETED", else: "COMPLETED" });
  });
  it("a factory stage takes its id, name and side-effect flag from the handler, and only unused handlers are offered", () => {
    const f = newStage(META, base(), "factory", { handler: "MERGING" });
    expect(f).toMatchObject({ id: "MERGING", handler: "MERGING", name: "Awaiting your merge", mutating: true });
    expect(() => newStage(META, base(), "factory", { handler: "NOPE" })).toThrow();
    const free = availableHandlers(META, base()).map((h) => h.handler);
    expect(free).not.toContain("ELIGIBILITY_CHECK"); expect(free).toContain("MERGING");
  });
});

describe("editing the draft", () => {
  it("inserts after a stage, or at the end", () => {
    const d = base(), s = stage("NEW");
    expect(insertStage(d, s, "ELIGIBILITY_CHECK").stages.map((x) => x.id)).toEqual(["ELIGIBILITY_CHECK", "NEW", "ANALYSIS"]);
    expect(insertStage(d, s).stages.map((x) => x.id)).toEqual(["ELIGIBILITY_CHECK", "ANALYSIS", "NEW"]);
    expect(d.stages).toHaveLength(2); // never mutates
  });
  it("moves a stage up or down and stops at the ends", () => {
    const d = customDefinition();
    expect(moveStage(d, "TRIAGE", -1).stages[0]!.id).toBe("TRIAGE");
    expect(moveStage(d, "ELIGIBILITY_CHECK", -1)).toBe(d);
    expect(moveStage(d, "FIXUP", 1)).toBe(d);
  });
  it("removing a stage removes every reference to it, so the draft never points at nothing", () => {
    const d = removeStage(customDefinition(), "FIXUP");
    expect(d.stages.find((s) => s.id === "REVIEW")!.onFailure).toEqual([]);
    const w = removeStage(customDefinition(), "WRITE_DOCS");
    expect(w.stages.find((s) => s.id === "DOCS_CHECK")!.config.then).toBe("COMPLETED");
    const t = removeStage(customDefinition(), "REVIEW");
    expect(t.stages.find((s) => s.id === "WRITE_DOCS")!.next).toBeUndefined();
    const r = removeStage({ ...base(), stages: [...base().stages, stage("LATE", { requires: ["ANALYSIS"] })] }, "ANALYSIS");
    expect(r.stages.find((s) => s.id === "LATE")!.requires).toEqual([]);
  });
  it("updates one stage by patch or function, leaving the others alone", () => {
    const d = base();
    expect(updateStage(d, "ANALYSIS", { name: "X" }).stages[1]!.name).toBe("X");
    expect(updateStage(d, "ANALYSIS", (s) => ({ ...s, required: false })).stages[1]!.required).toBe(false);
    expect(updateStage(d, "ANALYSIS", { name: "X" }).stages[0]).toBe(d.stages[0]);
  });
  it("changing a custom stage's type resets what belongs to the type, keeps the rest, and never touches a factory stage", () => {
    const a = { ...newStage(META, base(), "agent", { name: "Look" }), description: "keep me", model: { model: "haiku" } };
    const c = changeType(META, a, "check");
    expect(c).toMatchObject({ type: "check", description: "keep me", config: { command: "test" }, successGate: { type: "exit_code_zero" } });
    expect(c.prompt).toBeUndefined(); expect(c.model).toBeUndefined(); // a check uses no model
    const r = changeType(META, a, "review");
    expect(r.model).toEqual({ model: "haiku"}); expect(r.prompt?.template).toBe("Review {{ticket.identifier}}");
    const f = base().stages[0]!;
    expect(changeType(META, f, "agent")).toBe(f);
  });
  it("compares drafts by value", () => { expect(sameDef(base(), base())).toBe(true); expect(sameDef(base(), customDefinition())).toBe(false); });
});

describe("mandatory safety stages", () => {
  it("locks a safety stage only when the draft contains something it guards", () => {
    expect([...lockedHandlers(base(), META).keys()]).toEqual([]);
    const withMut: WorkflowDef = { ...base(), stages: [...base().stages, stage("PUSH", { mutating: true })] };
    expect([...lockedHandlers(withMut, META).keys()]).toEqual(["ELIGIBILITY_CHECK"]);
    const dflt = lockedHandlers(defaultDefinition(), META);
    expect([...dflt.keys()].sort()).toEqual(["ELIGIBILITY_CHECK", "LOCAL_MODEL_REVIEW"]);
    expect(dflt.get("ELIGIBILITY_CHECK")).toMatch(/live ticket/);
  });
});

describe("validation issues", () => {
  const issues: Issue[] = [
    { path: "stages.1.onFailure.0.target", message: 'no stage "X"', severity: "error" }, { path: "stages.1.name", message: "too short", severity: "error" },
    { path: "stages.2.retry", message: "warn", severity: "warning" }, { path: "stages", message: "loops", severity: "error" }, { path: "stages.10.id", message: "dup", severity: "error" },
  ];
  it("maps issues to a stage and field by path", () => {
    const i1 = issuesForStage(issues, 1);
    expect(i1.map((i) => i.field)).toEqual(["onFailure.0.target", "name"]);
    expect(atField(i1, "onFailure")).toHaveLength(1); expect(atField(i1, "onFailure.0.target")).toHaveLength(1); expect(atField(i1, "on")).toHaveLength(0);
    expect(issuesForStage(issues, 1).length).not.toBe(issuesForStage(issues, 10).length);
    expect(workflowIssues(issues).map((i) => i.path)).toEqual(["stages"]);
    expect(issueCounts(issues, 3)).toEqual([{ errors: 0, warnings: 0 }, { errors: 2, warnings: 0 }, { errors: 0, warnings: 1 }]);
  });
});

describe("conditions, values and gates", () => {
  it("round-trips a condition's field", () => {
    for (const f of ["job.remediationAttempts", "output.verdict", "outputs.TRIAGE.docs.only"]) expect(joinField(parseField(f))).toBe(f);
    expect(parseField("outputs.TRIAGE.a.b")).toMatchObject({ kind: "outputs", stage: "TRIAGE", path: "a.b" });
  });
  it("reads typed values: numbers, booleans, text", () => {
    expect(parseValue("5")).toBe(5); expect(parseValue("true")).toBe(true); expect(parseValue("false")).toBe(false); expect(parseValue("abc")).toBe("abc"); expect(parseValue("")).toBe(""); expect(parseValue(" ")).toBe(" ");
  });
  it("offers only the gate types that make sense for a stage type", () => {
    const all = META.gateTypes;
    expect(gateTypesFor("agent", all)).not.toContain("verdict_approved"); expect(gateTypesFor("agent", all)).not.toContain("exit_code_zero");
    expect(gateTypesFor("review", all)).toContain("verdict_approved"); expect(gateTypesFor("review", all)).not.toContain("tests_passed");
    expect(gateTypesFor("check", all)).toContain("tests_passed"); expect(gateTypesFor("check", all)).not.toContain("no_blocking_findings");
  });
  it("edits a nested gate by path, adding and removing nodes, and counts size like the backend", () => {
    let g: Gate = { type: "all", of: [{ type: "result_ok" }, { type: "any", of: [{ type: "exit_code_zero" }, { type: "tests_passed" }] }] };
    expect(gateSize(g)).toEqual({ depth: 3, nodes: 5 });
    g = updateGateAt(g, [1, 0], newGate("artifact_exists"));
    expect(((g as { of: Gate[] }).of[1] as { of: Gate[] }).of[0]).toEqual({ type: "artifact_exists", path: "" });
    g = updateGateAt(g, [1, 1], null);
    expect(gateSize(g).nodes).toBe(4);
    g = updateGateAt(g, [0], null);
    expect((g as { of: Gate[] }).of).toHaveLength(1);
    expect(updateGateAt(g, [], { type: "result_ok" })).toEqual({ type: "result_ok" });
  });
  it("says in plain language what must be true", () => {
    expect(gateSummary({ type: "result_ok" })).toBe("the stage itself reported success");
    expect(describeGate({ type: "all", of: [{ type: "verdict_approved" }, { type: "no_blocking_findings", severities: ["blocker"] }] })).toEqual(["Every one of these must be true:", "- the reviewer's verdict is “approve”", "- the review has no blocker findings"]);
    expect(describeGate({ type: "any", of: [{ type: "all", of: [{ type: "exit_code_zero" }, { type: "fields_present", fields: ["a", "b"] }] }, { type: "condition", condition: { field: "job.dryRun", op: "truthy" } }] })).toEqual([
      "At least one of these must be true:", "- all of:", "  - the command exited with code 0", "  - the output has a, b", "- the job's dryRun is set / not empty",
    ]);
    expect(describeGate({ type: "all", of: [{ type: "artifact_exists", path: "x.md" }] })).toEqual(["the file x.md exists in the job's worktree"]);
  });
});

describe("the default model route", () => {
  it("names the route a stage uses unless it sets its own", () => {
    expect(defaultRouteOf(stage("A", { config: { role: "security-reviewer" } }), META)).toEqual({ task: "final_review", provider: "anthropic", model: "opus" });
    expect(defaultRouteOf(stage("B", { type: "factory", handler: "IMPLEMENTATION" }), META)).toMatchObject({ task: "implementation" });
    expect(defaultRouteOf(stage("C", { type: "check" }), META)).toBeNull();
    expect(defaultRouteOf(stage("D", { type: "factory", handler: "MERGING" }), META)).toBeNull();
  });
});
