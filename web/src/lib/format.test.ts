import { describe, expect, it } from "vitest";
import { stageLabel, stageText } from "./format";

describe("friendly stage names", () => {
  it("uses the flow chart's name for a stage, so the internal id never reaches a person", () => {
    expect(stageLabel("LOCAL_MODEL_REVIEW")).toBe("Independent review");
    expect(stageLabel("REMEDIATION")).toBe("Fix findings");
    expect(stageLabel("LINEAR_COMPLETION")).toBe("Complete");
  });
  it("names the held and finished states, and falls back to a readable form for an unknown id", () => {
    expect(stageLabel("NEEDS_ATTENTION")).toBe("Needs attention");
    expect(stageLabel("SOME_NEW_STAGE")).toBe("Some new stage");
  });
  it("rewrites stage ids inside a message and leaves everything else alone", () => {
    expect(stageText("LOCAL_MODEL_REVIEW -> REMEDIATION (attempt 2)")).toBe("Independent review -> Fix findings (attempt 2)");
    expect(stageText("remediation attempts exhausted (3): 2 blocking finding(s)")).toBe("remediation attempts exhausted (3): 2 blocking finding(s)");
    expect(stageText(null)).toBeNull();
    expect(stageText(undefined)).toBeUndefined();
  });
});
