import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelRouter } from "../src/agents/router.js";
import { AgentRunner } from "../src/agents/runner.js";
import type { Agent, AgentRequest, AgentResult } from "../src/agents/types.js";
import { createContext } from "../src/app/context.js";
import { ConfigError, loadConfig } from "../src/config/load.js";
import { ModelsConfig, ProjectOverrides } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { agentInvocations, decisions, jobs, projects } from "../src/db/schema.js";
import { reviewerIndependence, pluginChecks } from "../src/doctor/checks.js";
import { createRegistry } from "../src/plugins/builtin/index.js";
import { PluginRegistry } from "../src/plugins/registry.js";
import { instanceOfRoute } from "../src/plugins/routes.js";
import { ENGINE_API_VERSION, type PluginCapabilities, type ProviderPlugin } from "../src/plugins/types.js";
import { buildServer } from "../src/server/app.js";
import { fixtureConfig, fixtureConfigDir } from "./helpers/config.js";
import { makeRepo } from "./helpers/git-fixture.js";

const SECRET = "sk-live-do-not-leak-0123456789";
const req = (o: Partial<AgentRequest> = {}): AgentRequest => ({ role: "qa-reviewer", profile: "read-only", prompt: "review", cwd: ".", model: "m1", timeoutMs: 5000, ...o });
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const completion = (content: string) => ({ body: { choices: [{ message: { content } }], usage: { prompt_tokens: 1 } } });

type Handler = (body: { messages: { role: string; content: string }[]; response_format?: unknown }, n: number) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;
let server: Server | undefined;
async function serve(handler: Handler, models = ["m1"]) {
  let n = 0;
  const auth: (string | undefined)[] = [];
  server = createServer(async (rq, rs) => {
    auth.push(rq.headers.authorization);
    if (rq.url === "/v1/models") { rs.end(JSON.stringify({ data: models.map((id) => ({ id })) })); return; }
    let raw = ""; for await (const c of rq) raw += c;
    const r = await handler(JSON.parse(raw), ++n);
    rs.statusCode = r.status ?? 200; rs.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, auth, hits: () => n };
}
afterEach(async () => { await new Promise((r) => (server ? server.close(r) : r(null))); server = undefined; });

/** A third-party plugin: nothing in the engine, the workflow definitions or the built-ins knows about it. */
const caps = (o: Partial<PluginCapabilities> = {}): PluginCapabilities => ({ kind: "cli", tools: false, writesWorktree: false, structuredOutput: true, streaming: false, listsModels: false, readOnly: true, usesApiKey: false, ...o });
const echoPlugin = (o: Partial<ProviderPlugin<{ greeting: string }>> = {}): ProviderPlugin<{ greeting: string }> => ({
  id: "echo", name: "Echo", version: "0.1.0", engineApi: { min: 1, max: 1 }, capabilities: caps(),
  settings: z.object({ greeting: z.string().default("hi") }).strict(),
  create: (s) => ({ provider: "echo", async run(r: AgentRequest): Promise<AgentResult> { return { ok: true, text: `${s.greeting}:${r.prompt}`, denials: [], exitCode: 0, durationMs: 1 }; } }),
  ...o,
});

const ROUTES = { classification: { provider: "anthropic", model: "haiku" }, specification: { provider: "anthropic", model: "default" }, implementation: { provider: "anthropic", model: "default" }, final_review: { provider: "anthropic", model: "default" } };
const models = (over: Record<string, unknown> = {}, routes: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ModelsConfig.parse({ ...extra, plugins: over, routes: { ...ROUTES, ...routes } });

describe("plugin registry", () => {
  it("lists the built-ins with id, name, version, compatibility and capabilities", () => {
    const list = createRegistry().list();
    expect(list.map((p) => p.id)).toEqual(["claude-code", "openai-compatible", "openai"]);
    const claude = list.find((p) => p.id === "claude-code")!;
    expect(claude).toMatchObject({ name: "Claude Code", version: "1.0.0", engineApi: { min: 1, max: 1 }, state: "available", builtin: true, capabilities: { kind: "cli", tools: true, writesWorktree: true } });
    expect(list.find((p) => p.id === "openai")).toMatchObject({ name: "OpenAI API", capabilities: { kind: "api", tools: false, writesWorktree: false, usesApiKey: true, listsModels: true } });
    expect(list.find((p) => p.id === "openai-compatible")!.capabilities.tools).toBe(false);
  });
  it("registers a third-party plugin without touching anything else, and lists it", () => {
    const r = createRegistry({ extra: [echoPlugin()] });
    expect(r.list().find((p) => p.id === "echo")).toMatchObject({ name: "Echo", builtin: false, state: "available" });
    expect(() => r.register(echoPlugin())).toThrow(/already registered/);
    expect(() => r.register(echoPlugin({ id: "Bad Id" }))).toThrow(ConfigError);
  });
  it("rejects an incompatible plugin and says why", () => {
    const r = createRegistry({ extra: [echoPlugin({ engineApi: { min: ENGINE_API_VERSION + 1, max: ENGINE_API_VERSION + 2 } })] });
    expect(r.list().find((p) => p.id === "echo")).toMatchObject({ state: "incompatible", reason: expect.stringContaining("engine API") });
    expect(() => r.validate("e", { plugin: "echo", settings: {} })).toThrow(/engine API/);
  });
  it("validates settings: defaults, invalid values and unknown settings", () => {
    const r = createRegistry({ extra: [echoPlugin()] });
    expect(r.validate("e", { plugin: "echo", settings: {} })).toEqual({ greeting: "hi" });
    expect(() => r.validate("e", { plugin: "echo", settings: { greeting: 5 } })).toThrow(/invalid settings/);
    expect(() => r.validate("e", { plugin: "echo", settings: { surprise: 1 } })).toThrow(/invalid settings/);
    expect(() => r.validate("e", { plugin: "nope", settings: {} })).toThrow(/not installed/);
  });
  it("never lets run() throw: an escaped exception becomes a structured error", async () => {
    const boom = echoPlugin({ id: "boom", create: () => ({ provider: "boom", async run(): Promise<AgentResult> { throw new Error("kaput"); } }) });
    const rt = createRegistry({ extra: [boom] }).runtime("b", { plugin: "boom", settings: {} });
    expect(await rt.run(req())).toMatchObject({ ok: false, failure: "error", error: expect.stringContaining("kaput") });
  });
  it("shares one runtime (one request queue) between instances with identical settings", () => {
    const r = createRegistry();
    const a = r.runtime("a", { plugin: "openai-compatible", settings: { baseUrl: "http://127.0.0.1:1/v1" } });
    expect(r.runtime("b", { plugin: "openai-compatible", settings: { baseUrl: "http://127.0.0.1:1/v1" } })).toBe(a);
  });
});

describe("openai and openai-compatible settings", () => {
  const r = createRegistry();
  it("openai defaults to the OpenAI endpoint and OPENAI_API_KEY and accepts an alternative base URL", () => {
    expect(r.validate("o", { plugin: "openai", settings: {} })).toEqual({ baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" });
    expect(r.validate("o", { plugin: "openai", settings: { baseUrl: "https://gateway.example.test/v1" } })).toMatchObject({ baseUrl: "https://gateway.example.test/v1" });
    expect(() => r.validate("o", { plugin: "openai", settings: { baseUrl: "http://gateway.example.test/v1" } })).toThrow(/https/);
    expect(r.validate("o", { plugin: "openai", settings: { baseUrl: "http://127.0.0.1:9/v1" } })).toBeTruthy();
  });
  it("openai-compatible defaults to the local server and needs no key", () => {
    expect(r.validate("l", { plugin: "openai-compatible", settings: {} })).toEqual({ baseUrl: "http://127.0.0.1:1234/v1" });
    expect(() => r.validate("l", { plugin: "openai-compatible", settings: { baseUrl: "http://api.example.test/v1", apiKeyEnv: "K" } })).toThrow(/https/);
  });
  it("only ever takes the NAME of a key variable, and rejects unknown settings", () => {
    expect(() => r.validate("o", { plugin: "openai", settings: { apiKeyEnv: SECRET } })).toThrow(/environment variable name/);
    expect(() => r.validate("o", { plugin: "openai", settings: { apiKey: SECRET } })).toThrow(/invalid settings/);
  });
});

describe("openai / openai-compatible execution", () => {
  const compat = (baseUrl: string, env: NodeJS.ProcessEnv = {}) => createRegistry({ env: { env } }).runtime("c", { plugin: "openai-compatible", settings: { baseUrl } });

  it("returns structured output and usage, and lists models without a model call", async () => {
    const s = await serve(() => completion('{"ok":true}'), ["a", "b"]);
    const rt = compat(s.baseUrl);
    expect(await rt.run(req({ jsonSchema: SCHEMA }))).toMatchObject({ ok: true, structured: { ok: true }, exitCode: 0, usage: { prompt_tokens: 1 } });
    expect(await rt.listModels!()).toEqual(["a", "b"]);
  });
  it("falls back to prompt-instructed JSON when the server rejects response_format", async () => {
    const s = await serve((b, n) => (n === 1 ? { status: 400, body: "response_format unsupported" } : (expect(b.response_format).toBeUndefined(), completion('{"ok":false}'))));
    expect((await compat(s.baseUrl).run(req({ jsonSchema: SCHEMA }))).structured).toEqual({ ok: false });
  });
  it("gives up with invalid_output after retries", async () => {
    const s = await serve(() => completion("no json at all"));
    expect(await compat(s.baseUrl).run(req({ jsonSchema: SCHEMA }))).toMatchObject({ ok: false, failure: "invalid_output" });
    expect(s.hits()).toBe(3);
  });
  it("classifies HTTP errors, an unreachable server, a timeout and a cancellation without throwing", async () => {
    const s5 = await serve(() => ({ status: 503, body: "busy" }));
    expect((await compat(s5.baseUrl).run(req())).failure).toBe("transient");
    await new Promise((r) => server!.close(r)); server = undefined;
    const s4 = await serve(() => ({ status: 401, body: "bad key" }));
    expect(await compat(s4.baseUrl).run(req())).toMatchObject({ ok: false, failure: "error", error: expect.stringContaining("401") });
    await new Promise((r) => server!.close(r)); server = undefined;
    expect((await compat("http://127.0.0.1:1/v1").run(req())).failure).toBe("transient");
    const slow = await serve(() => new Promise(() => {}));
    expect((await compat(slow.baseUrl).run(req({ timeoutMs: 200 }))).failure).toBe("timeout");
    const ac = new AbortController();
    const p = compat(slow.baseUrl).run(req({ signal: ac.signal, timeoutMs: 30_000 }));
    setTimeout(() => ac.abort(), 100);
    expect((await p).failure).toBe("cancelled");
  });
  it("reports a missing key variable by name and sends no request", async () => {
    const s = await serve(() => completion("x"));
    const rt = createRegistry({ env: { env: {} } }).runtime("o", { plugin: "openai", settings: { baseUrl: s.baseUrl } });
    const r = await rt.run(req());
    expect(r).toMatchObject({ ok: false, failure: "error", error: expect.stringContaining("OPENAI_API_KEY") });
    expect(s.hits()).toBe(0);
  });
  it("openai sends its default key variable as a bearer token to the default endpoint, and the key never appears in results", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => { seen.push({ url, auth: (init.headers as Record<string, string>).Authorization }); return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 }); }) as unknown as typeof fetch;
    const rt = createRegistry({ env: { env: { OPENAI_API_KEY: SECRET }, fetch: fetchStub } }).runtime("o", { plugin: "openai", settings: {} });
    const r = await rt.run(req());
    expect(seen).toEqual([{ url: "https://api.openai.com/v1/chat/completions", auth: `Bearer ${SECRET}` }]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  it("is strictly sequential and read-only, whichever plugin id wraps it", async () => {
    let inflight = 0, max = 0;
    const s = await serve(async () => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 30)); inflight--; return completion("ok"); });
    const rt = createRegistry({ env: { env: { OPENAI_API_KEY: SECRET } } }).runtime("o", { plugin: "openai", settings: { baseUrl: s.baseUrl } });
    await Promise.all([1, 2, 3].map(() => rt.run(req())));
    expect(max).toBe(1);
    expect(await rt.run(req({ profile: "implementer" }))).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
  });
  it("probes reachability and model listing, without a model call", async () => {
    const s = await serve(() => completion("never"), ["m1"]);
    const r = createRegistry({ env: { env: {} } });
    expect(await r.check("c", { plugin: "openai-compatible", settings: { baseUrl: s.baseUrl } })).toMatchObject({ ok: true, models: ["m1"] });
    expect(s.hits()).toBe(0); // /models only
    expect(await r.check("o", { plugin: "openai", settings: { baseUrl: s.baseUrl } })).toMatchObject({ ok: false, detail: expect.stringContaining("OPENAI_API_KEY") });
    expect(await r.check("c", { plugin: "openai-compatible", settings: { baseUrl: "http://127.0.0.1:1/v1" } })).toMatchObject({ ok: false, detail: expect.stringContaining("unreachable") });
    expect(await r.check("c", { plugin: "openai-compatible", settings: { nope: 1 } })).toMatchObject({ ok: false });
  });
});

describe("routes: instances, migration on read and capability gating", () => {
  const LEGACY = `local:
  baseUrl: http://127.0.0.1:5555/v1
independentReviewFallback: block
routes:
  classification: { provider: local, model: q }
  specification: { provider: anthropic, model: c }
  implementation: { provider: anthropic, model: c }
  independent_review: { provider: local, model: gpt-x, baseUrl: "https://api.example.test/v1", apiKeyEnv: REVIEW_KEY }
  final_review: { provider: anthropic, model: c }
`;
  const withModels = (yaml: string) => { const d = fixtureConfigDir(); writeFileSync(join(d, "models.yaml"), yaml); return d; };

  it("loads a legacy models.yaml, routes identically, and never rewrites the file", () => {
    const dir = withModels(LEGACY);
    const c = loadConfig(dir);
    expect(readFileSync(join(dir, "models.yaml"), "utf8")).toBe(LEGACY);
    expect(c.models.routes.classification).toEqual({ provider: "local", model: "q" }); // the parsed config still reads as written
    expect(c.models.local.baseUrl).toBe("http://127.0.0.1:5555/v1");
    const router = new ModelRouter(c.models);
    expect(router.route("classification")).toEqual({ instance: "local", plugin: "openai-compatible", model: "q" });
    expect(router.route("specification")).toEqual({ instance: "claude-code", plugin: "claude-code", model: "c" });
    expect(router.route("final_review")).toMatchObject({ plugin: "claude-code", model: "c" });
    expect(instanceOfRoute(c.models, c.models.routes.classification).instance).toEqual({ plugin: "openai-compatible", settings: { baseUrl: "http://127.0.0.1:5555/v1" } }); // global local.baseUrl, as before
    const rev = router.route("independent_review");
    expect(rev).toMatchObject({ plugin: "openai-compatible", model: "gpt-x" });
    expect(rev.instance).toMatch(/^openai-compatible-[0-9a-f]{8}$/);
    expect(instanceOfRoute(c.models, c.models.routes.independent_review!).instance).toEqual({ plugin: "openai-compatible", settings: { baseUrl: "https://api.example.test/v1", apiKeyEnv: "REVIEW_KEY" } });
    expect(router.reviewerCanFallBack()).toBe(true); // an API endpoint that can be down
  });
  it("sends a legacy local route's requests to local.baseUrl and the reviewer's key to its own endpoint", async () => {
    const local = await serve(() => completion("from-local"));
    const dir = withModels(LEGACY.replace("http://127.0.0.1:5555/v1", local.baseUrl).replace("https://api.example.test/v1", local.baseUrl));
    const router = new ModelRouter(loadConfig(dir).models, {}, undefined, createRegistry({ env: { env: { REVIEW_KEY: SECRET } } }));
    expect(await router.run("classification", req())).toMatchObject({ ok: true, text: "from-local", route: { model: "q" } });
    expect(local.auth).toEqual([undefined]);
    expect(await router.run("independent_review", req())).toMatchObject({ ok: true, route: { model: "gpt-x" } });
    expect(local.auth[1]).toBe(`Bearer ${SECRET}`);
  });
  it("loads plugin instances and routes that name them", () => {
    const c = loadConfig(withModels(`plugins:
  gpt: { plugin: openai, settings: { baseUrl: "https://gateway.example.test/v1" } }
  lms: { plugin: openai-compatible, settings: { baseUrl: "http://127.0.0.1:1234/v1" } }
routes:
  classification: { plugin: lms, model: qwen }
  specification: { plugin: claude-code, model: default }
  implementation: { plugin: claude-code, model: default }
  independent_review: { plugin: gpt, model: gpt-4o-mini }
  final_review: { plugin: claude-code, model: default }
`));
    const router = new ModelRouter(c.models);
    expect(router.route("classification")).toEqual({ instance: "lms", plugin: "openai-compatible", model: "qwen" });
    expect(router.route("independent_review")).toEqual({ instance: "gpt", plugin: "openai", model: "gpt-4o-mini" });
    expect(c.models.routes.independent_review).toEqual({ plugin: "gpt", model: "gpt-4o-mini" });
  });
  it("fails with a clear ConfigError when a route names an instance that does not exist", () => {
    expect(() => loadConfig(withModels(LEGACY.replace("{ provider: local, model: q }", "{ plugin: ghost, model: q }")))).toThrow(/unknown plugin instance "ghost"/);
    // an instance can only be judged against the global list at route time for project overrides
    const router = new ModelRouter(models(), {}, () => ({ classification: { plugin: "ghost", model: "x" } }));
    expect(() => router.route("classification", "p")).toThrow(ConfigError);
    expect(() => router.route("classification", "p")).toThrow(/ghost/);
  });
  it("migrates project overrides with the same meaning (override, follow global, no reviewer)", () => {
    const ov = ProjectOverrides.parse({ models: { implementation: { provider: "anthropic", model: "opus" }, classification: { provider: "local", model: "q2" }, independent_review: null } });
    const router = new ModelRouter(models({}, {}, {}), {}, (id) => (id === "p" ? ov.models : undefined));
    expect(router.route("implementation", "p")).toEqual({ instance: "claude-code", plugin: "claude-code", model: "opus" });
    expect(router.route("classification", "p")).toEqual({ instance: "local", plugin: "openai-compatible", model: "q2" });
    expect(router.route("specification", "p")).toMatchObject({ model: "default" }); // left out: follows the global route
    expect(router.reviewer("p")).toBeNull();
    expect(router.route("implementation")).toMatchObject({ model: "default" }); // other projects unaffected
    expect(() => ProjectOverrides.parse({ models: { implementation: { provider: "local", model: "m" } } })).toThrow(/must use provider `anthropic`/);
  });
  it("rejects a plugin without tools for specification, implementation and prompt_generation, based on its declared capabilities", () => {
    const inst = { gpt: { plugin: "openai", settings: {} } };
    for (const task of ["specification", "implementation", "prompt_generation"]) {
      expect(() => models(inst, { [task]: { plugin: "gpt", model: "gpt-4o" } })).toThrow(/file and shell tools/);
      expect(() => models({}, { [task]: { plugin: "local", model: "x" } })).toThrow(/file and shell tools/);
    }
    expect(models(inst, { classification: { plugin: "gpt", model: "gpt-4o" } }).routes.classification).toEqual({ plugin: "gpt", model: "gpt-4o" });
    expect(models({}, { implementation: { plugin: "claude-code", model: "opus" } }).routes.implementation.plugin).toBe("claude-code");
  });
  it("gates third-party plugins by capability when routing, and accepts a tool-capable one", () => {
    const registry = createRegistry({ extra: [echoPlugin(), echoPlugin({ id: "agy", name: "AGY", capabilities: caps({ tools: true, writesWorktree: true }) })] });
    const m = models({ e: { plugin: "echo", settings: {} }, a: { plugin: "agy", settings: {} } }, { classification: { plugin: "e", model: "x" }, implementation: { plugin: "a", model: "x" }, specification: { plugin: "e", model: "x" } });
    const router = new ModelRouter(m, {}, undefined, registry);
    expect(router.route("classification")).toEqual({ instance: "e", plugin: "echo", model: "x" });
    expect(router.route("implementation")).toEqual({ instance: "a", plugin: "agy", model: "x" });
    expect(() => router.route("specification")).toThrow(/read-only/); // echo declares no tools
  });
  it("reports a plugin that is not installed when routing", () => {
    const router = new ModelRouter(models({ g: { plugin: "ghost", settings: {} } }, { classification: { plugin: "g", model: "x" } }));
    expect(() => router.route("classification")).toThrow(/not installed/);
  });
  it("keeps the independent fallback keyed off the plugin kind, not its name", () => {
    const registry = createRegistry({ extra: [echoPlugin()] }); // a CLI-kind plugin
    const cli = new ModelRouter(models({ e: { plugin: "echo", settings: {} } }, { independent_review: { plugin: "e", model: "x" } }), {}, undefined, registry);
    expect(cli.reviewerCanFallBack()).toBe(false);
    const none = new ModelRouter(models());
    expect(none.reviewerCanFallBack()).toBe(false);
    const api = new ModelRouter(models({}, { independent_review: { plugin: "local", model: "x" } }));
    expect(api.reviewerCanFallBack()).toBe(true);
  });
  it("never accepts a key value in config", () => {
    expect(() => loadConfig(withModels(`plugins:\n  gpt: { plugin: openai, settings: { apiKey: "${SECRET}" } }\n${LEGACY.split("\n").slice(3).join("\n")}`))).toThrow(/looks like a secret/);
    expect(() => models({ gpt: { plugin: "openai", settings: {} } }, { independent_review: { plugin: "gpt", model: "m", apiKeyEnv: "K" } })).toThrow();
  });
});

describe("runner and workflow integration with plugins", () => {
  const stub = (name: string, fn: (r: AgentRequest) => void = () => {}): Agent & { calls: AgentRequest[] } => ({ provider: name, calls: [], async run(r): Promise<AgentResult> { this.calls.push(r); fn(r); return { ok: true, text: name, denials: [], exitCode: 0, durationMs: 1 }; } });
  const setup = (m: ModelsConfig, agents: Record<string, Agent>, registry: PluginRegistry) => {
    const { db } = openDb(":memory:");
    db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    db.insert(jobs).values({ id: "j", projectId: "p", externalId: "e", externalKey: "E-1" }).run();
    const router = new ModelRouter(m, agents, undefined, registry);
    return { db, runner: new AgentRunner({ db, router, logDir: mkdtempSync(join(tmpdir(), "logs-")), protectedPaths: [".env"] }) };
  };

  it("runs two steps of one workflow on different plugin instances and records each instance", async () => {
    const registry = createRegistry({ extra: [echoPlugin()] });
    const claude = stub("claude");
    const { db, runner } = setup(models({ alt: { plugin: "echo", settings: { greeting: "yo" } } }, { classification: { plugin: "alt", model: "x" } }), { "claude-code": claude }, registry);
    const { repo } = makeRepo();
    const a = await runner.run({ jobId: "j", task: "classification", role: "classifier", prompt: "p1", cwd: repo, timeoutMs: 1000 });
    const b = await runner.run({ jobId: "j", task: "specification", role: "spec-writer", prompt: "p2", cwd: repo, timeoutMs: 1000 });
    expect(a).toMatchObject({ ok: true, text: "yo:p1", route: { instance: "alt", plugin: "echo" } });
    expect(b).toMatchObject({ ok: true, text: "claude", route: { instance: "claude-code", plugin: "claude-code" } });
    expect(claude.calls).toHaveLength(1);
    expect(db.select().from(agentInvocations).all().map((r) => r.agent)).toEqual(["alt/classifier", "claude-code/spec-writer"]);
  });
  it("refuses a non-read-only role on a plugin that cannot write the worktree, without calling it", async () => {
    const registry = createRegistry({ extra: [echoPlugin()] });
    const e = stub("echo");
    const { db, runner } = setup(models({ e: { plugin: "echo", settings: {} } }, { classification: { plugin: "e", model: "x" } }), { e }, registry);
    const { repo } = makeRepo();
    const r = await runner.run({ jobId: "j", task: "classification", role: "implementer", prompt: "write", cwd: repo, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, failure: "error", error: expect.stringContaining("read-only") });
    expect(e.calls).toHaveLength(0);
    expect(db.select().from(agentInvocations).all()).toHaveLength(0);
  });
  it("applies the read-only worktree check to any plugin that declares tools, whatever its name", async () => {
    const registry = createRegistry({ extra: [echoPlugin({ id: "codex", capabilities: caps({ tools: true, writesWorktree: true }) })] });
    const sneaky = stub("codex", (r) => writeFileSync(join(r.cwd, "sneaky.txt"), "x"));
    const { runner } = setup(models({ cx: { plugin: "codex", settings: {} } }, { final_review: { plugin: "cx", model: "x" } }), { cx: sneaky }, registry);
    const { repo } = makeRepo();
    const r = await runner.run({ jobId: "j", task: "final_review", role: "final-reviewer", prompt: "review", cwd: repo, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, violations: ["read-only agent modified the worktree"] });
  });
  it("keeps key values out of the database and the run log", async () => {
    const s = await serve(() => completion("fine"));
    const registry = createRegistry({ env: { env: { OPENAI_API_KEY: SECRET } } });
    const { db, runner } = setup(models({ gpt: { plugin: "openai", settings: { baseUrl: s.baseUrl } } }, { classification: { plugin: "gpt", model: "m1" } }), {}, registry);
    const { repo } = makeRepo();
    const r = await runner.run({ jobId: "j", task: "classification", role: "classifier", prompt: "p", cwd: repo, timeoutMs: 2000 });
    expect(r.ok).toBe(true);
    expect(s.auth[0]).toBe(`Bearer ${SECRET}`);
    const everything = JSON.stringify([db.select().from(agentInvocations).all(), db.select().from(decisions).all(), r]) + readFileSync(db.select().from(agentInvocations).get()!.logPath!, "utf8");
    expect(everything).not.toContain(SECRET);
  });
  it("createContext takes extra plugins and exposes the registry, with no engine change", () => {
    const base = fixtureConfig();
    const config = { ...base, models: models({ alt: { plugin: "echo", settings: {} } }, { classification: { plugin: "alt", model: "x" } }) };
    const ctx = createContext(config, { db: openDb(":memory:"), logger: pino({ level: "silent" }), plugins: [echoPlugin()] });
    expect(ctx.registry.list().map((p) => p.id)).toContain("echo");
    expect(ctx.router.route("classification")).toMatchObject({ instance: "alt", plugin: "echo" });
  });
});

describe("doctor", () => {
  it("reports plugins that are missing, not installed or misconfigured, and stays quiet for Claude only", async () => {
    const quiet = await pluginChecks(fixtureConfig(), (async () => { throw new Error("no network"); }) as unknown as typeof fetch, createRegistry());
    expect(quiet).toEqual([{ name: "local models", status: "ok", detail: expect.stringContaining("Claude Code only") }]);
    const c = fixtureConfig();
    c.models.plugins = { ghost: { plugin: "ghost", settings: {} }, bad: { plugin: "openai", settings: { nope: 1 } } };
    c.models.routes.classification = { plugin: "ghost", model: "m" };
    c.models.routes.final_review = { plugin: "bad", model: "m" };
    c.models.routes.independent_review = { plugin: "nowhere", model: "m" };
    const out = await pluginChecks(c, (async () => { throw new Error("no network"); }) as unknown as typeof fetch, createRegistry());
    expect(out.find((x) => x.name === "plugin ghost")).toMatchObject({ status: "fail", detail: expect.stringContaining("not installed") });
    expect(out.find((x) => x.name === "plugin bad")).toMatchObject({ status: "fail", detail: expect.stringContaining("invalid settings") });
    expect(out.find((x) => x.name === "plugin nowhere")).toMatchObject({ status: "fail", detail: expect.stringContaining("not defined") });
  });
  it("checks the models of a named instance and compares reviewer independence by instance", async () => {
    const s = await serve(() => completion("x"), ["qwen"]);
    const c = fixtureConfig();
    c.models.plugins = { lms: { plugin: "openai-compatible", settings: { baseUrl: s.baseUrl } } };
    c.models.routes.classification = { plugin: "lms", model: "qwen" };
    c.models.routes.final_review = { plugin: "lms", model: "missing" };
    const out = await pluginChecks(c, fetch, createRegistry());
    expect(out.find((x) => x.name === "route classification")).toMatchObject({ status: "ok" });
    expect(out.find((x) => x.name === "route final_review")).toMatchObject({ status: "fail", detail: expect.stringContaining("qwen") });
    c.models.routes.independent_review = { plugin: "claude-code", model: c.models.routes.specification.model };
    expect(reviewerIndependence(c)[0]!.status).toBe("warn");
  });
});

describe("review fixes", () => {
  it("doctor sends the instance's key when listing models, and fails clearly when the variable is unset", async () => {
    const seen: (string | undefined)[] = [];
    const keyed = (async (_u: string, init?: RequestInit) => { const a = (init?.headers as Record<string, string> | undefined)?.Authorization; seen.push(a); return a ? new Response(JSON.stringify({ data: [{ id: "m1" }] })) : new Response("no", { status: 401 }); }) as unknown as typeof fetch;
    const { checkLocalModels } = await import("../src/doctor/checks.js");
    expect((await checkLocalModels("http://x/v1", keyed, "DOC_KEY", { DOC_KEY: SECRET }))[0]).toMatchObject({ status: "ok" });
    expect(seen).toEqual([`Bearer ${SECRET}`]);
    expect((await checkLocalModels("http://x/v1", keyed, "DOC_KEY", {}))[0]).toMatchObject({ status: "fail", detail: expect.stringContaining("DOC_KEY") });
  });
  it("rejects a secret held in plugin instance settings", () => {
    expect(() => models({ p: { plugin: "echo", settings: { apiKey: SECRET } } })).toThrow(/must not hold a secret/);
    expect(models({ p: { plugin: "echo", settings: { apiKeyEnv: "K" } } }).plugins.p).toBeTruthy();
  });
  it("blocks a remote settings save that sets a route endpoint or key variable", async () => {
    const { blockedRemoteBody } = await import("../src/hub/remote-policy.js");
    const put = (routes: unknown) => blockedRemoteBody("PUT", "/api/settings/global", Buffer.from(JSON.stringify({ routes })));
    expect(put({ independent_review: { provider: "local", model: "m", baseUrl: "https://evil.test/v1", apiKeyEnv: "AWS_SECRET" } })).toMatch(/decide on the machine/);
    expect(put({ classification: { plugin: "local", model: "m" } })).toBeNull();
  });
});

describe("plugin API", () => {
  const HOST = { host: "127.0.0.1:4780" }, UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1", "content-type": "application/json" };
  function app(registry = createRegistry({ env: { env: { SOME_KEY: SECRET } } })) {
    const config = loadConfig(fixtureConfigDir());
    return { config, app: buildServer({ db: openDb(":memory:").db, logger: pino({ level: "silent" }), port: 4780, controlToken: "t".repeat(64), config, plugins: registry }) };
  }
  const post = (a: ReturnType<typeof app>["app"], method: "POST" | "PUT", url: string, body: unknown) => a.inject({ method, url, headers: UI, remoteAddress: "127.0.0.1", payload: JSON.stringify(body) });

  it("lists plugins with capabilities and the instances (with their validation state)", async () => {
    const s = app();
    const r = (await s.app.inject({ method: "GET", url: "/api/plugins", headers: HOST, remoteAddress: "127.0.0.1" })).json();
    expect(r.plugins.map((p: { id: string }) => p.id)).toEqual(["claude-code", "openai-compatible", "openai"]);
    expect(r.plugins[0]).toMatchObject({ state: "available", capabilities: { tools: true } });
    expect(r.instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "claude-code", plugin: "claude-code", valid: true, builtin: true, usedBy: expect.arrayContaining(["implementation"]) }),
      expect.objectContaining({ id: "local", plugin: "openai-compatible", valid: true }),
    ]));
  });
  it("saves instances to models.yaml, reloads them live, and refuses invalid ones", async () => {
    const s = app();
    expect((await post(s.app, "PUT", "/api/plugins/instances", { instances: { gpt: { plugin: "openai", settings: { baseUrl: "https://gateway.example.test/v1" } } } })).statusCode).toBe(200);
    const file = join(s.config.configDir!, "models.yaml");
    expect(readFileSync(file, "utf8")).toContain("gpt");
    expect(s.config.models.plugins.gpt).toMatchObject({ plugin: "openai" });
    expect((await post(s.app, "PUT", "/api/plugins/instances", { instances: { x: { plugin: "openai", settings: { bogus: 1 } } } })).statusCode).toBe(400);
    expect((await post(s.app, "PUT", "/api/plugins/instances", { instances: { x: { plugin: "nope", settings: {} } } })).statusCode).toBe(400);
    expect((await s.app.inject({ method: "PUT", url: "/api/plugins/instances", headers: { ...HOST, "content-type": "application/json" }, remoteAddress: "127.0.0.1", payload: "{}" })).statusCode).toBe(401);
    // an instance a route still uses cannot be removed
    await post(s.app, "PUT", "/api/plugins/instances", { instances: { gpt: { plugin: "openai", settings: {} } } });
    writeFileSync(file, readFileSync(file, "utf8").replace(/classification:.*\n/, "classification: { plugin: gpt, model: m }\n"));
    expect((await post(s.app, "PUT", "/api/plugins/instances", { instances: {} })).statusCode).toBe(400);
  });
  it("validates a draft or a saved instance without a model call, and never echoes a key", async () => {
    const m = await serve(() => completion("never"), ["m1", "m2"]);
    const s = app();
    const ok = (await post(s.app, "POST", "/api/plugins/validate", { plugin: "openai-compatible", settings: { baseUrl: m.baseUrl } })).json();
    expect(ok).toMatchObject({ ok: true, models: ["m1", "m2"] });
    expect(m.hits()).toBe(0);
    const unset = (await post(s.app, "POST", "/api/plugins/validate", { plugin: "openai", settings: { baseUrl: m.baseUrl, apiKeyEnv: "UNSET_VAR_X" } })).json();
    expect(unset).toMatchObject({ ok: false, detail: expect.stringContaining("UNSET_VAR_X") });
    const keyed = await post(s.app, "POST", "/api/plugins/validate", { plugin: "openai", settings: { baseUrl: m.baseUrl, apiKeyEnv: "SOME_KEY" } });
    expect(keyed.json()).toMatchObject({ ok: true });
    expect(keyed.body).not.toContain(SECRET);
    expect((await post(s.app, "POST", "/api/plugins/validate", { plugin: "openai", settings: { bogus: 1 } })).json()).toMatchObject({ ok: false });
    expect((await post(s.app, "POST", "/api/plugins/validate", { instance: "ghost" })).statusCode).toBe(404);
    expect((await post(s.app, "POST", "/api/plugins/validate", { instance: "claude-code" })).json()).toHaveProperty("ok");
  });
});
