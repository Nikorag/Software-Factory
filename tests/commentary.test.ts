import { describe, expect, it } from "vitest";
import { COMMENTARY_MAX, commentaryOf, noteCommentary, withCommentary } from "../src/agents/commentary.js";

describe("commentaryOf", () => {
  it("prefers the agent's own summary over its text", () => {
    expect(commentaryOf({ text: "chatter" }, { summary: "Added the field" })).toBe("Added the field");
  });
  it("falls back to the reply text", () => {
    expect(commentaryOf({ text: "Changed X." }, { other: 1 })).toBe("Changed X.");
  });
  it("collapses whitespace", () => {
    expect(commentaryOf({ text: "  Changed X.\n\n  Added   tests\tfor Y.\n" })).toBe("Changed X. Added tests for Y.");
  });
  it("clips to a fixed length", () => {
    const c = commentaryOf({ text: "word ".repeat(500) })!;
    expect(c.length).toBeLessThanOrEqual(COMMENTARY_MAX);
    expect(c.endsWith("…")).toBe(true);
  });
  it("redacts credential-shaped text", () => {
    const key = `sk-ant-${"a1B2c3D4".repeat(4)}`;
    const c = commentaryOf({ text: `Used key ${key} to call the API` })!;
    expect(c).not.toContain(key);
    expect(c).toContain("[redacted:");
  });
  it("gives nothing for empty input or a raw JSON reply", () => {
    expect(commentaryOf({ text: "" })).toBeUndefined();
    expect(commentaryOf({ text: " \n " }, { summary: "  " })).toBeUndefined();
    expect(commentaryOf({ text: '{"a":1}' })).toBeUndefined();
  });
  it("stays valid JSON when stored", () => {
    const c = commentaryOf({ text: 'He said "hi"\\ and left' })!;
    expect(JSON.parse(JSON.stringify({ commentary: c })).commentary).toBe(c);
  });
});

describe("withCommentary", () => {
  const ctx = { executionId: 9001 };
  type R = { kind: string; output?: unknown };
  type H = (c: { executionId: number }) => Promise<R>;
  const wrap = <K extends string>(hs: Record<K, () => Promise<R>>): Record<K, H> => withCommentary(hs as Record<K, H>);
  it("adds noted commentary first to a successful object output", async () => {
    const h = wrap({ A: async () => { noteCommentary(9001, "Did it."); return { kind: "ok", output: { files: 2 } }; } });
    const r = await h.A(ctx);
    expect(r.output).toEqual({ commentary: "Did it.", files: 2 });
    expect(Object.keys(r.output as object)[0]).toBe("commentary");
  });
  it("leaves non-ok results, outputs without commentary, and non-object outputs alone", async () => {
    const h = wrap({
      A: async () => { noteCommentary(9001, "x"); return { kind: "remediate", output: { findings: [] } }; },
      B: async () => ({ kind: "ok", output: { files: 1 } }),
      C: async () => { noteCommentary(9001, "x"); return { kind: "ok" }; },
    });
    expect((await h.A(ctx)).output).toEqual({ findings: [] });
    expect((await h.B(ctx)).output).toEqual({ files: 1 });
    expect((await h.C(ctx)).output).toBeUndefined();
  });
});
