import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeOutput } from "../src/agents/claude.js";
import { parseLine, readConversation } from "../src/agents/transcript.js";
import { redactSecrets } from "../src/implement/secrets.js";
import { tmp } from "./helpers/git-fixture.js";

const J = (o: unknown) => JSON.stringify(o);
// Shapes captured from `claude -p --output-format stream-json --verbose` (2.1.332)
const STREAM = [
  J({ type: "system", subtype: "init", model: "claude-haiku-5-5", tools: ["Read", "Bash"], session_id: "s1" }),
  J({ type: "assistant", message: { content: [{ type: "text", text: "Let me run the tests." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }),
  J({ type: "rate_limit_event", rate_limit_info: {} }),
  J({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "12 passed" }], is_error: false }] } }),
  J({ type: "result", subtype: "success", is_error: false, result: "All good", session_id: "s1", total_cost_usd: 0.01, num_turns: 2, structured_output: { ok: true } }),
].join("\n") + "\n";

describe("streaming output from Claude Code", () => {
  it("still yields the result (and structured output) from a stream of events", () => {
    const r = parseClaudeOutput({ stdout: STREAM, stderr: "", exitCode: 0, durationMs: 5 });
    expect(r).toMatchObject({ ok: true, text: "All good", sessionId: "s1", numTurns: 2, structured: { ok: true } });
  });
  it("still understands a single JSON document (the previous format)", () => {
    const r = parseClaudeOutput({ stdout: J({ type: "result", subtype: "success", is_error: false, result: "x", session_id: "s" }), stderr: "", exitCode: 0, durationMs: 1 });
    expect(r.ok).toBe(true);
  });
  it("reports a failure when the stream ends without a result (crash, kill)", () => {
    const r = parseClaudeOutput({ stdout: STREAM.split("\n").slice(0, 3).join("\n"), stderr: "boom", exitCode: 1, durationMs: 1 });
    expect(r.ok).toBe(false);
  });
});

describe("conversation turns", () => {
  it("reports the size of each model call's prompt (input plus cached tokens) so the status bar can show context use", () => {
    const line = J({ type: "assistant", message: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 5 } } });
    expect(parseLine(line)).toEqual([{ kind: "text", text: "hi" }, { kind: "usage", tokens: 42_010 }]);
    expect(parseLine(J({ type: "assistant", message: { content: [{ type: "text", text: "no usage" }] } })).map((t) => t.kind)).toEqual(["text"]);
  });
  it("turns events into prompt, text, tool call, tool result and outcome, dropping noise", () => {
    const turns = [J({ type: "factory_prompt", text: "Do the thing" }), ...STREAM.trim().split("\n")].flatMap(parseLine);
    expect(turns.map((t) => t.kind)).toEqual(["prompt", "session", "text", "tool", "tool_result", "result"]); // rate_limit_event dropped
    expect(turns.find((t) => t.kind === "tool")).toMatchObject({ name: "Bash", input: "npm test" });
    expect(turns.find((t) => t.kind === "tool_result")).toMatchObject({ id: "t1", text: "12 passed", error: false });
    expect(turns.find((t) => t.kind === "session")).toMatchObject({ model: "claude-haiku-5-5", tools: 2 });
  });
  it("redacts anything that looks like a credential, and clips very long output", () => {
    const secret = "ghp_" + "a".repeat(36);
    const [t] = parseLine(J({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: `TOKEN=${secret} ${"y".repeat(9000)}` }] } }));
    expect(t!.kind).toBe("tool_result");
    const text = (t as { text: string }).text;
    expect(text).toContain("[redacted:github-token]"); expect(text).not.toContain(secret);
    expect(text.length).toBeLessThan(4200);
    expect(redactSecrets("key sk-ant-" + "b".repeat(30))).toContain("[redacted:anthropic-key]");
    expect(redactSecrets("password = \"example-placeholder-value\"")).toContain("example"); // documentation placeholders are left alone
  });
  it("keeps stderr and unparseable lines as plain text turns", () => {
    expect(parseLine("[stderr] warning: x")).toEqual([{ kind: "stderr", text: "warning: x" }]);
    expect(parseLine("not json")).toEqual([{ kind: "raw", text: "not json" }]);
    expect(parseLine("")).toEqual([]);
  });
});

describe("following a run's log", () => {
  const setup = () => { const dataDir = tmp(); mkdirSync(join(dataDir, "logs", "agents", "j"), { recursive: true }); return { dataDir, file: join(dataDir, "logs", "agents", "j", "1.log") }; };
  it("returns only complete lines and resumes from the offset", () => {
    const { dataDir, file } = setup();
    const lines = STREAM.trim().split("\n");
    writeFileSync(file, lines.slice(0, 2).join("\n") + "\n" + lines[2]!.slice(0, 10)); // last line half-written
    const a = readConversation(dataDir, file, 0)!;
    expect(a.turns.map((t) => t.kind)).toEqual(["session", "text", "tool"]);
    appendFileSync(file, lines[2]!.slice(10) + "\n" + lines.slice(3).join("\n") + "\n");
    const b = readConversation(dataDir, file, a.offset)!;
    expect(b.turns.map((t) => t.kind)).toEqual(["tool_result", "result"]); // nothing repeated, nothing lost
    expect(readConversation(dataDir, file, b.offset)!.turns).toEqual([]);
  });
  it("refuses paths outside the logs directory, including symlink escapes", () => {
    const { dataDir, file } = setup();
    writeFileSync(file, "x\n");
    writeFileSync(join(dataDir, "secret.txt"), "top secret\n");
    symlinkSync(join(dataDir, "secret.txt"), join(dataDir, "logs", "link.log"));
    expect(readConversation(dataDir, join(dataDir, "secret.txt"), 0)).toBeNull();
    expect(readConversation(dataDir, join(dataDir, "logs", "link.log"), 0)).toBeNull();
    expect(readConversation(dataDir, join(dataDir, "logs", "..", "secret.txt"), 0)).toBeNull();
  });
  it("never stalls on a line longer than the read window: skips it with a note and carries on after it", () => {
    const { dataDir, file } = setup();
    const lines = STREAM.trim().split("\n");
    const huge = J({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "z".repeat(5000) }] } });
    writeFileSync(file, `${lines[0]}\n${huge}\n${lines[1]}\n`);
    const max = 1000; // smaller than the huge line
    const a = readConversation(dataDir, file, 0, max)!;
    expect(a.turns.map((t) => t.kind)).toEqual(["session"]);
    expect(a.more).toBe(true);
    let offset = a.offset, notes = 0, rest: string[] = [];
    for (let i = 0; i < 20 && offset < a.size; i++) { // every call makes progress, and at most `max` bytes are read
      const r = readConversation(dataDir, file, offset, max)!;
      expect(r.offset).toBeGreaterThan(offset);
      offset = r.offset;
      notes += r.turns.filter((t) => t.kind === "raw" && /too long to show/.test(t.text)).length;
      rest = [...rest, ...r.turns.filter((t) => t.kind !== "raw").map((t) => t.kind)];
      expect(r.turns.some((t) => t.kind === "raw" && /^z+/.test(t.text))).toBe(false); // no fragments of the skipped line
    }
    expect(offset).toBe(a.size);
    expect(notes).toBe(1);
    expect(rest).toEqual(["text", "tool"]); // the line after the huge one is read normally
  });
  it("waits for a long line that is still being written instead of skipping it", () => {
    const { dataDir, file } = setup();
    writeFileSync(file, `${J({ type: "factory_prompt", text: "hi" })}\n{"type":"assistant"`);
    const a = readConversation(dataDir, file, 0)!;
    expect(a).toMatchObject({ more: false });
    expect(readConversation(dataDir, file, a.offset)!).toMatchObject({ turns: [], offset: a.offset, more: false });
  });
});

