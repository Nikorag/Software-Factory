import { describe, expect, it } from "vitest";
import { contextPercent, contextWindow, prettyModel, resultPreview, shortPath, tokensShort } from "./session";

describe("session view helpers", () => {
  it("names models the way a person would", () => {
    expect(prettyModel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(prettyModel("claude-sonnet-5-5[1m]")).toBe("Sonnet 5.5 (1M)");
    expect(prettyModel("haiku")).toBe("Haiku");
    expect(prettyModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(prettyModel("some-local-model")).toBe("some-local-model");
    expect(prettyModel(null)).toBe("Claude");
  });
  it("estimates the context window: 200k, or 1M when the model id says so", () => {
    expect(contextWindow("claude-opus-5-5")).toBe(200_000);
    expect(contextWindow("claude-opus-5-5[1m]")).toBe(1_000_000);
    expect(contextPercent(50_000, "opus")).toBe(25);
    expect(contextPercent(900_000, "opus")).toBe(100); // clamped
    expect(contextPercent(100_000, "opus[1m]")).toBe(10);
  });
  it("shortens token counts and paths", () => {
    expect(tokensShort(842)).toBe("842");
    expect(tokensShort(84_213)).toBe("84k");
    expect(tokensShort(1_250_000)).toBe("1.3M");
    expect(shortPath("/Users/jamie/projects/app")).toBe("~/projects/app");
    expect(shortPath("/Users/jamie/.software-factory/workspaces/zonto-hub/JAM-419/specs/deep")).toBe("~/…/specs/deep");
    expect(shortPath(null)).toBe("");
  });
  it("previews a tool result as its first line and how many more there are", () => {
    expect(resultPreview("a\nb\nc\n")).toEqual({ first: "a", more: 2 });
    expect(resultPreview("only")).toEqual({ first: "only", more: 0 });
    expect(resultPreview("")).toEqual({ first: "", more: 0 });
  });
});
