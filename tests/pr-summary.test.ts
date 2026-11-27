import { describe, expect, it } from "vitest";
import { prSummary } from "../src/delivery/handlers.js";

describe("prSummary", () => {
  it("uses the implementation summary when present", () => {
    expect(prSummary({ summary: "  Todos can have due dates.  ", title: "T", commits: ["a"] })).toBe("## Summary\nTodos can have due dates.");
  });
  it("falls back to the ticket title and commit subjects", () => {
    const s = prSummary({ summary: undefined, title: "Due dates", commits: ["Add field", "", "Show badge"] });
    expect(s).toBe("## Summary\nImplements: Due dates. Commits: Add field; Show badge.");
  });
  it("never produces an empty heading", () => {
    expect(prSummary({ summary: "   ", title: " ", commits: ["", " "] })).toBe("");
    expect(prSummary({ summary: "", title: "X" })).toContain("Implements: X.");
  });
});
