import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { extractJson, LocalModelClient, stripReasoning } from "../src/agents/local.js";
import { ModelRouter } from "../src/agents/router.js";
import { AgentRunner } from "../src/agents/runner.js";
import type { Agent, AgentRequest, AgentResult } from "../src/agents/types.js";
import { ConfigError, loadConfig } from "../src/config/load.js";
import { ModelsConfig } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { agentInvocations, decisions, jobs, projects } from "../src/db/schema.js";
import { makeRepo, sh } from "./helpers/git-fixture.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

type Handler = (body: { model: string; messages: { role: string; content: string }[]; response_format?: unknown }, n: number) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;
let server: Server | undefined;
async function serve(handler: Handler, models = ["qwen-test"]) {
  let inflight = 0, maxInflight = 0, n = 0;
  server = createServer(async (rq: IncomingMessage, rs) => {
    if (rq.url === "/v1/models") { rs.end(JSON.stringify({ data: models.map((id) => ({ id })) })); return; }
    let raw = ""; for await (const c of rq) raw += c;
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    try { const r = await handler(JSON.parse(raw), ++n); rs.statusCode = r.status ?? 200; rs.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body)); }
    finally { inflight--; }
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, max: () => maxInflight };
}
afterEach(async () => { await new Promise((r) => (server ? server.close(r) : r(null))); server = undefined; });
const completion = (content: string) => ({ body: { choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 7 } } });
const rq = (o: Partial<AgentRequest> = {}): AgentRequest => ({ role: "qa-reviewer", profile: "read-only", prompt: "review", cwd: ".", model: "qwen-test", timeoutMs: 5000, ...o });
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

describe("reply parsing", () => {
  it("strips Qwen-style reasoning blocks", () => { expect(stripReasoning("<think>hmm\nlong</think>\n answer ")).toBe("answer"); });
  it.each([
    ['{"a":1}', { a: 1 }], ['```json\n{"a":2}\n```', { a: 2 }], ['Sure! Here you go: {"a":3} hope that helps', { a: 3 }],
    ['<think>{"x":0}</think>{"a":4}', { a: 4 }], ['{"s":"a } b"} trailing', { s: "a } b" }], ["[1,2]", [1, 2]],
  ])("extracts JSON from %j", (text, want) => expect(extractJson(text)).toEqual(want));
  it("throws when there is no JSON", () => { expect(() => extractJson("no json here")).toThrow(/no parseable JSON/); });
});

describe("LocalModelClient", () => {
  it("lists the models the server really has", async () => {
    const s = await serve(() => completion("x"), ["a", "b"]);
    expect(await new LocalModelClient({ baseUrl: s.baseUrl }).listModels()).toEqual(["a", "b"]);
  });
  it("returns text and usage, stripping reasoning", async () => {
    const s = await serve(() => completion("<think>plan</think>All good."));
    const r = await new LocalModelClient({ baseUrl: s.baseUrl }).run(rq());
    expect(r).toMatchObject({ ok: true, text: "All good.", usage: { prompt_tokens: 5 } });
  });
  it("sends the system prompt and a strict json_schema response_format", async () => {
    let seen: Parameters<Handler>[0] | undefined;
    const s = await serve((b) => { seen = b; return completion('{"ok":true}'); });
    const r = await new LocalModelClient({ baseUrl: s.baseUrl }).run(rq({ systemPrompt: "SYS", jsonSchema: SCHEMA }));
    expect(r.structured).toEqual({ ok: true });
    expect(seen!.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(seen!.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true, schema: SCHEMA } });
  });
  it("falls back to prompt-instructed JSON when the server rejects response_format", async () => {
    const s = await serve((b, n) => (n === 1 ? { status: 400, body: "response_format.type must be json_object" } : (expect(b.response_format).toBeUndefined(), completion('{"ok":false}'))));
    expect((await new LocalModelClient({ baseUrl: s.baseUrl }).run(rq({ jsonSchema: SCHEMA }))).structured).toEqual({ ok: false });
  });
  it("re-asks once or twice on invalid JSON, then gives up with invalid_output", async () => {
    let calls = 0;
    const s = await serve(() => (++calls, completion("I refuse to emit JSON")));
    const r = await new LocalModelClient({ baseUrl: s.baseUrl }).run(rq({ jsonSchema: SCHEMA }));
    expect(r).toMatchObject({ ok: false, failure: "invalid_output" });
    expect(calls).toBe(3);
    let n = 0;
    const s2 = await serve(() => completion(++n < 2 ? "prose" : '{"ok":true}'));
    expect((await new LocalModelClient({ baseUrl: s2.baseUrl }).run(rq({ jsonSchema: SCHEMA }))).structured).toEqual({ ok: true });
  });
  it("runs requests strictly one at a time, in order", async () => {
    const order: string[] = [];
    const s = await serve(async (b) => { order.push(b.messages.at(-1)!.content); await new Promise((r) => setTimeout(r, 40)); return completion("done"); });
    const c = new LocalModelClient({ baseUrl: s.baseUrl });
    const rs = await Promise.all(["a", "b", "c", "d"].map((p) => c.run(rq({ prompt: p }))));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(s.max()).toBe(1);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });
  it("classifies server errors, timeouts and unreachable servers", async () => {
    const s5 = await serve(() => ({ status: 503, body: "busy" }));
    expect((await new LocalModelClient({ baseUrl: s5.baseUrl }).run(rq())).failure).toBe("transient");
    await new Promise((r) => server!.close(r)); server = undefined;
    const slow = await serve(() => new Promise(() => {}));
    expect((await new LocalModelClient({ baseUrl: slow.baseUrl }).run(rq({ timeoutMs: 300 }))).failure).toBe("timeout");
    expect((await new LocalModelClient({ baseUrl: "http://127.0.0.1:1/v1" }).run(rq())).failure).toBe("transient");
    await expect(new LocalModelClient({ baseUrl: "http://127.0.0.1:1/v1" }).listModels()).rejects.toMatchObject({ kind: "unreachable" });
  });
  it("cancels in flight and while queued", async () => {
    const s = await serve(() => new Promise(() => {}));
    const c = new LocalModelClient({ baseUrl: s.baseUrl });
    const ac = new AbortController();
    const first = c.run(rq({ signal: ac.signal, timeoutMs: 30_000 }));
    const queued = c.run(rq({ signal: ac.signal, timeoutMs: 30_000 }));
    setTimeout(() => ac.abort(), 100);
    expect((await first).failure).toBe("cancelled");
    expect((await queued).failure).toBe("cancelled");
  });
  it("refuses unconfigured models and any request needing tools", async () => {
    const c = new LocalModelClient({ baseUrl: "http://127.0.0.1:1/v1" });
    expect((await c.run(rq({ model: "UNCONFIGURED-QWEN" }))).error).toMatch(/no local model configured/);
    expect((await c.run(rq({ model: undefined }))).ok).toBe(false);
    expect((await c.run(rq({ profile: "implementer" }))).error).toMatch(/read-only/);
  });
});

describe("ModelRouter + config", () => {
  const stub = (name: string): Agent & { calls: AgentRequest[] } => ({ provider: name as never, calls: [], async run(r) { this.calls.push(r); return { ok: true, text: name, denials: [], exitCode: 0, durationMs: 1 }; } });
  const routes = ModelsConfig.parse({
    routes: {
      classification: { provider: "local", model: "qwen-x" }, specification: { provider: "anthropic", model: "default" }, implementation: { provider: "anthropic", model: "claude-x" },
      independent_review: { provider: "local", model: "UNCONFIGURED-QWEN" }, final_review: { provider: "anthropic", model: "default" },
    },
  });
  it("dispatches by provider and injects the configured model", async () => {
    const [l, a] = [stub("local"), stub("anthropic")];
    const router = new ModelRouter(routes, { local: l, anthropic: a });
    expect((await router.run("classification", rq())).route).toEqual({ provider: "local", model: "qwen-x" });
    await router.run("implementation", rq({ profile: "implementer" }));
    expect(l.calls[0]!.model).toBe("qwen-x");
    expect(a.calls[0]!.model).toBe("claude-x");
  });
  it("refuses to route to a local model with no real id", async () => {
    const router = new ModelRouter(routes, { local: stub("local"), anthropic: stub("anthropic") });
    await expect(router.run("independent_review", rq())).rejects.toBeInstanceOf(ConfigError);
  });
  it("rejects configs that put specification or implementation on the local model", () => {
    const bad = (k: string) => ModelsConfig.safeParse({ routes: { ...routes.routes, [k]: { provider: "local", model: "q" } } }).success;
    expect(bad("implementation")).toBe(false);
    expect(bad("specification")).toBe(false);
    expect(bad("classification")).toBe(true);
  });
  it("ships a valid models.yaml", () => { expect(loadConfig("config").models.routes.implementation.provider).toBe("anthropic"); });
});

describe("AgentRunner boundaries and recording", () => {
  const writer = (fn: (r: AgentRequest) => void): Agent => ({ provider: "anthropic", async run(r): Promise<AgentResult> { fn(r); return { ok: true, text: "done", denials: [{ tool: "Bash", input: "git push" }], exitCode: 0, durationMs: 12, costUsd: 0.2, sessionId: "s", usage: {} }; } });
  const setup = (agent: Agent) => {
    const { db } = openDb(":memory:");
    db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    db.insert(jobs).values({ id: "j", projectId: "p", externalId: "e", externalKey: "E-1" }).run();
    const router = new ModelRouter(ModelsConfig.parse({ routes: { classification: { provider: "anthropic", model: "default" }, specification: { provider: "anthropic", model: "default" }, implementation: { provider: "anthropic", model: "default" }, independent_review: { provider: "anthropic", model: "default" }, final_review: { provider: "anthropic", model: "default" } } }), { anthropic: agent, local: agent });
    return { db, runner: new AgentRunner({ db, router, logDir: mkdtempSync(join(tmpdir(), "logs-")), protectedPaths: [".env", ".git/**", ".github/workflows/**"] }) };
  };
  it("records the invocation (agent, model, cwd, exit, duration, cost, log path) and fixes the profile from the role", async () => {
    const { repo } = makeRepo();
    let seen: AgentRequest | undefined;
    const { db, runner } = setup(writer((r) => { seen = r; }));
    const r = await runner.run({ jobId: "j", task: "implementation", role: "implementer", prompt: "go", cwd: repo, timeoutMs: 1000, baseRef: "HEAD" });
    expect(r.ok).toBe(true);
    expect(seen).toMatchObject({ profile: "implementer", persistSession: true });
    expect(seen!.systemPrompt).toContain("worktree");
    const row = db.select().from(agentInvocations).get()!;
    expect(row).toMatchObject({ jobId: "j", agent: "anthropic/implementer", cwd: repo, exitCode: 0, durationMs: 12 });
    expect(row.logPath).toContain("/j/");
    expect(JSON.parse(row.usageJson!)).toMatchObject({ costUsd: 0.2, sessionId: "s", denials: 1 });
  });
  it("fails the run and records a decision when an implementer touches a protected path", async () => {
    const { repo } = makeRepo();
    const { db, runner } = setup(writer((r) => { writeFileSync(join(r.cwd, ".env"), "LEAK=1"); }));
    const r = await runner.run({ jobId: "j", task: "implementation", role: "implementer", prompt: "go", cwd: repo, timeoutMs: 1000, baseRef: "HEAD" });
    expect(r).toMatchObject({ ok: false, failure: "error", violations: ["protected path changed: .env"] });
    expect(db.select().from(decisions).where(eq(decisions.kind, "agent.violation")).all()).toHaveLength(1);
  });
  it("fails a read-only reviewer that modified the worktree", async () => {
    const { repo } = makeRepo();
    const { runner } = setup(writer((r) => { writeFileSync(join(r.cwd, "sneaky.txt"), "x"); }));
    const r = await runner.run({ jobId: "j", task: "final_review", role: "final-reviewer", prompt: "review", cwd: repo, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, violations: ["read-only agent modified the worktree"] });
    sh(repo, "status", "--porcelain");
  });
  it("lets a well-behaved read-only reviewer through", async () => {
    const { repo } = makeRepo();
    const { runner } = setup(writer(() => {}));
    expect((await runner.run({ jobId: "j", task: "final_review", role: "final-reviewer", prompt: "review", cwd: repo, timeoutMs: 1000 })).ok).toBe(true);
  });
});
