import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs, ClaudeCodeAgent } from "../src/agents/claude.js";
import { mcpAccount, resolveMcp } from "../src/agents/mcp.js";
import { toolPolicy } from "../src/agents/permissions.js";
import { ModelRouter } from "../src/agents/router.js";
import { AgentRunner } from "../src/agents/runner.js";
import type { Agent, AgentRequest, AgentResult } from "../src/agents/types.js";
import { ConfigError, loadConfig } from "../src/config/load.js";
import { parseRepoFile } from "../src/config/repo-file.js";
import { addProfile } from "../src/config/profiles.js";
import { mcpServersOf, ModelsConfig, type LoadedConfig } from "../src/config/schema.js";
import { upsertProject } from "../src/config/store.js";
import { openDb } from "../src/db/client.js";
import { agentInvocations, decisions, jobs, projects } from "../src/db/schema.js";
import { buildServer } from "../src/server/app.js";
import type { ProjectActions } from "../src/service/actions.js";
import { TaskManager } from "../src/service/tasks.js";
import { fixtureConfigDir } from "./helpers/config.js";
import { memoryStore } from "./helpers/fake-atlassian.js";
import { tmp } from "./helpers/git-fixture.js";

const SECRET = ["fixture", "value", "123"].join("-"); // a made-up marker, built so it never looks like a credential literal
const req = (o: Partial<AgentRequest> = {}): AgentRequest => ({ role: "implementer", profile: "implementer", prompt: "p", cwd: tmp(), timeoutMs: 10_000, ...o });
const grant = { names: ["github"], servers: { github: { type: "stdio", command: "mcp-github", args: [], env: { TOKEN: "${SF_MCP_GITHUB_TOKEN}" } } }, env: { SF_MCP_GITHUB_TOKEN: SECRET } };
const SERVER_YAML = `mcp:\n  defaultServers: [github]\n  servers:\n    - name: github\n      command: mcp-github\n      env: [TOKEN]\n`;

describe("claude arguments with MCP", () => {
  it("are unchanged when no server is granted, for every role and both access modes", () => {
    for (const o of [{}, { access: "unrestricted" as const }, { profile: "read-only" as const, role: "qa-reviewer" as const }, { profile: "spec-writer" as const, role: "spec-writer" as const }]) {
      const r = req(o);
      const a = buildClaudeArgs(r);
      expect(a).toEqual(buildClaudeArgs({ ...r, mcp: { names: [], servers: {}, env: {} } }));
      expect(a).not.toContain("--mcp-config");
      expect(a).toContain("--strict-mcp-config");
    }
  });
  it("passes --mcp-config with --strict-mcp-config and allows mcp__<server>__* in both branches, with no secret on argv", () => {
    for (const o of [{}, { access: "unrestricted" as const }, { profile: "read-only" as const, role: "qa-reviewer" as const }]) {
      const a = buildClaudeArgs(req({ ...o, mcp: grant }));
      expect(JSON.parse(a[a.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: grant.servers });
      expect(a).toContain("--strict-mcp-config");
      expect(a).toContain("mcp__github__*");
      expect(a.join(" ")).not.toContain(SECRET);
    }
  });
  it("hands secret values to the subprocess environment only", async () => {
    let env: NodeJS.ProcessEnv | undefined;
    const agent = new ClaudeCodeAgent({ env: { PATH: "/bin", GH_TOKEN: "leak" }, run: async (o) => { env = o.env; return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false, cancelled: false }; } });
    await agent.run(req({ mcp: grant }));
    expect(env?.SF_MCP_GITHUB_TOKEN).toBe(SECRET);
    expect(env?.GH_TOKEN).toBeUndefined(); // the global allowlist is untouched
  });
});

describe("toolPolicy with MCP grants", () => {
  it("adds mcp__<server>__* for the granted servers only, and never a bare Read/Write/Edit", () => {
    for (const p of ["read-only", "spec-writer", "implementer"] as const) {
      const base = toolPolicy(p, { roots: ["/w"] });
      const withMcp = toolPolicy(p, { roots: ["/w"], mcpServers: ["github", "jira"] });
      expect(withMcp.allow).toEqual([...base.allow, "mcp__github__*", "mcp__jira__*"]);
      expect(withMcp.deny).toEqual(base.deny);
      expect(withMcp.tools).toEqual(base.tools);
      for (const bare of ["Read", "Write", "Edit"]) expect(withMcp.allow).not.toContain(bare);
    }
  });
});

describe("MCP configuration", () => {
  const dirWith = (yaml: string) => { const d = fixtureConfigDir(); appendFileSync(join(d, "factory.yaml"), `\n${yaml}`); return d; };
  it("defaults to no servers", () => {
    const c = loadConfig(fixtureConfigDir());
    expect(c.factory.mcp).toMatchObject({ servers: [], defaultServers: [] });
    expect(resolveMcp(c, "example-game", memoryStore())).toBeUndefined();
  });
  it("accepts valid stdio and http servers", () => {
    const c = loadConfig(dirWith(`${SERVER_YAML}    - name: docs\n      type: http\n      url: https://mcp.example.com/mcp\n`));
    expect(c.factory.mcp.servers.map((s) => [s.name, s.type])).toEqual([["github", "stdio"], ["docs", "http"]]);
  });
  it.each([
    ["a missing name", "mcp:\n  servers:\n    - command: x\n", /name/],
    ["an empty command", "mcp:\n  servers:\n    - name: a\n      command: ''\n", /command/],
    ["no command", "mcp:\n  servers:\n    - name: a\n", /command/],
    ["an empty url", "mcp:\n  servers:\n    - name: a\n      type: http\n      url: ''\n", /url/],
    ["an inline secret in env", "mcp:\n  servers:\n    - name: a\n      command: x\n      env: { API_TOKEN: abc }\n", /secret|env/],
    ["an inline secret header", "mcp:\n  servers:\n    - name: a\n      type: http\n      url: https://x.example\n      headers: { X-Api-Key: abc }\n", /secret/],
    ["a bearer header with no reference", "mcp:\n  servers:\n    - name: a\n      type: http\n      url: https://x.example\n      headers: { Authorization: Bearer abcdefgh }\n", /secret/],
    ["a header referencing a variable not in env", "mcp:\n  servers:\n    - name: a\n      type: http\n      url: https://x.example\n      headers: { Authorization: 'Bearer ${NOPE}' }\n", /not listed in env/],
    ["a name with underscores", "mcp:\n  servers:\n    - name: a__b\n      command: x\n", /name/],
    ["a default naming an unknown server", "mcp:\n  defaultServers: [ghost]\n", /unknown MCP server/],
  ])("rejects %s with a ConfigError", (_n, yaml, re) => {
    expect(() => loadConfig(dirWith(yaml))).toThrow(ConfigError);
    expect(() => loadConfig(dirWith(yaml))).toThrow(re);
  });
  it("a project's selection beats the profile default, and leaving it out follows the profile", () => {
    const dir = dirWith(`${SERVER_YAML}    - name: docs\n      type: sse\n      url: https://mcp.example.com/sse\n`);
    upsertProject({ id: "own", name: "Own", github: { repo: "me/own" }, overrides: { mcpServers: ["docs"] } }, dir);
    upsertProject({ id: "none", name: "None", github: { repo: "me/none" }, overrides: { mcpServers: [] } }, dir);
    upsertProject({ id: "follow", name: "Follow", github: { repo: "me/follow" } }, dir);
    const c = loadConfig(dir);
    const of = (id: string) => mcpServersOf(c, c.projects.projects.find((p) => p.id === id));
    expect(of("own")).toEqual(["docs"]);
    expect(of("none")).toEqual([]);
    expect(of("follow")).toEqual(["github"]);
    expect(() => upsertProject({ id: "bad", name: "Bad", github: { repo: "me/bad" }, overrides: { mcpServers: ["ghost"] } }, dir)).toThrow(/not defined in factory.yaml/);
  });
  it("gives each profile its own MCP keychain service", () => {
    expect(loadConfig(join(addProfile("work", tmp()).home, "config")).factory.mcp.keychainService).toBe("software-factory-mcp-work");
  });
  it("a repository file cannot define MCP servers", () => {
    expect(() => parseRepoFile("id: p\nmcp:\n  servers: [{ name: a, command: x }]\n", "p")).toThrow(ConfigError);
    expect(() => parseRepoFile("id: p\nmcpServers: [a]\n", "p")).toThrow(ConfigError);
  });
});

describe("resolving a run's MCP grant", () => {
  const config = (): LoadedConfig => loadConfig((() => { const d = fixtureConfigDir(); appendFileSync(join(d, "factory.yaml"), `\n${SERVER_YAML}`); return d; })());
  it("builds ${VAR} references and scoped env, with the value only in env", () => {
    const g = resolveMcp(config(), "example-game", memoryStore({ [mcpAccount("github", "TOKEN")]: SECRET }))!;
    expect(g.names).toEqual(["github"]);
    expect(g.env).toEqual({ SF_MCP_GITHUB_TOKEN: SECRET });
    expect(JSON.stringify(g.servers)).not.toContain(SECRET);
    expect(g.servers.github).toMatchObject({ command: "mcp-github", env: { TOKEN: "${SF_MCP_GITHUB_TOKEN}" } });
  });
  it("refuses to start with a secret missing", () => {
    expect(() => resolveMcp(config(), "example-game", memoryStore())).toThrow(/no value saved for TOKEN/);
  });
});

describe("AgentRunner and MCP", () => {
  const spy = (seen: AgentRequest[], provider: "anthropic" | "local"): Agent => ({ provider, async run(r): Promise<AgentResult> { seen.push(r); return { ok: true, text: "ok", denials: [], exitCode: 0, durationMs: 1 }; } });
  const setup = (provider: "anthropic" | "local") => {
    const { db } = openDb(":memory:");
    db.insert(projects).values({ id: "p", configJson: "{}" }).run();
    db.insert(jobs).values({ id: "j", projectId: "p", externalId: "e", externalKey: "E-1" }).run();
    const seen: AgentRequest[] = [];
    const route = { provider, model: "default" };
    const router = new ModelRouter(ModelsConfig.parse({ routes: { classification: route, specification: { provider: "anthropic", model: "default" }, implementation: { provider: "anthropic", model: "default" }, independent_review: route, final_review: route } }), { anthropic: spy(seen, "anthropic"), local: spy(seen, "local") });
    const runner = new AgentRunner({ db, router, logDir: mkdtempSync(join(tmpdir(), "logs-")), protectedPaths: [], mcp: () => grant });
    return { db, runner, seen };
  };
  it("passes the grant to Claude Code and records only the server names", async () => {
    const { db, runner, seen } = setup("anthropic");
    await runner.run({ jobId: "j", task: "final_review", role: "final-reviewer", prompt: "x", cwd: tmp(), timeoutMs: 1000 });
    expect(seen[0]!.mcp).toBe(grant);
    expect(JSON.parse(db.select().from(agentInvocations).get()!.usageJson!).mcpServers).toEqual(["github"]);
    const d = db.select().from(decisions).where(eq(decisions.kind, "agent.mcp")).all();
    expect(d).toHaveLength(1);
    expect(JSON.stringify([d, db.select().from(agentInvocations).all()])).not.toContain(SECRET);
  });
  it("gives the local provider no MCP", async () => {
    const { db, runner, seen } = setup("local");
    await runner.run({ jobId: "j", task: "classification", role: "classifier", prompt: "x", cwd: tmp(), timeoutMs: 1000 });
    expect(seen[0]!.mcp).toBeUndefined();
    expect(db.select().from(decisions).where(eq(decisions.kind, "agent.mcp")).all()).toHaveLength(0);
  });
});

describe("MCP API", () => {
  const HOST = { host: "127.0.0.1:4780" }, UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1" };
  function setup() {
    const dir = fixtureConfigDir();
    const config = loadConfig(dir);
    const store = memoryStore();
    const app = buildServer({ db: openDb(":memory:").db, logger: pino({ level: "silent" }), config, port: 4780, controlToken: "t".repeat(64), mcp: { store, pathEnv: "" }, settings: { tasks: new TaskManager(), actions: {} as unknown as ProjectActions, linear: () => { throw new Error("no linear in this test"); }, linearKeyPresent: () => false, saveLinearKey: async () => ({ name: "Me" }) } });
    const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, headers: Record<string, string>, body?: unknown) =>
      app.inject({ method, url, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, remoteAddress: "127.0.0.1", payload: body === undefined ? undefined : JSON.stringify(body) });
    return { dir, config, store, call };
  }
  const def = { command: "mcp-github", env: ["TOKEN"], secrets: { TOKEN: SECRET } };
  it("needs the token guard to write; a write stores the secret in the store, never in config", async () => {
    const s = setup();
    for (const r of [await s.call("PUT", "/api/mcp/servers/github", HOST, def), await s.call("DELETE", "/api/mcp/servers/github", HOST), await s.call("POST", "/api/mcp/servers/github/test", HOST), await s.call("PUT", "/api/mcp/default", HOST, { servers: [] })]) expect(r.statusCode).toBe(401);
    const ok = await s.call("PUT", "/api/mcp/servers/github", UI, def);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(s.store.data[mcpAccount("github", "TOKEN")]).toBe(SECRET);
    expect(readFileSync(join(s.dir, "factory.yaml"), "utf8")).not.toContain(SECRET);
    expect(JSON.stringify(s.config)).not.toContain(SECRET);
    expect(s.config.factory.mcp.servers[0]).toMatchObject({ name: "github", command: "mcp-github", env: ["TOKEN"] });
  });
  it("GET returns only whether each secret is set", async () => {
    const s = setup();
    await s.call("PUT", "/api/mcp/servers/github", UI, def);
    await s.call("PUT", "/api/mcp/servers/other", UI, { command: "x", env: ["KEY"] });
    const r = await s.call("GET", "/api/mcp/servers", HOST);
    expect(r.body).not.toContain(SECRET);
    expect(r.json().servers.map((x: { name: string; secrets: unknown }) => [x.name, x.secrets])).toEqual([["github", [{ name: "TOKEN", set: true }]], ["other", [{ name: "KEY", set: false }]]]);
  });
  it("GET returns headers as stored (references, not values), and a GET-then-PUT round trip leaves them unchanged", async () => {
    const s = setup();
    const http = { type: "http", url: "https://mcp.example.com", env: ["TOKEN"], headers: { Authorization: "Bearer ${TOKEN}", "X-Trace": "on" }, secrets: { TOKEN: SECRET } };
    expect((await s.call("PUT", "/api/mcp/servers/docs", UI, http)).statusCode).toBe(200);
    const got = (await s.call("GET", "/api/mcp/servers", HOST)).json().servers[0];
    expect(got.headers).toEqual({ Authorization: "Bearer ${TOKEN}", "X-Trace": "on" });
    const { name, type, url, env, headers } = got;
    expect((await s.call("PUT", `/api/mcp/servers/${name}`, UI, { type, url, env, headers })).statusCode).toBe(200);
    expect(s.config.factory.mcp.servers[0]!.headers).toEqual({ Authorization: "Bearer ${TOKEN}", "X-Trace": "on" });
  });
  it("rejects invalid servers and secrets for unlisted variables", async () => {
    const s = setup();
    expect((await s.call("PUT", "/api/mcp/servers/a", UI, { command: "" })).statusCode).toBe(400);
    expect((await s.call("PUT", "/api/mcp/servers/a", UI, { type: "http", url: "" })).statusCode).toBe(400);
    expect((await s.call("PUT", "/api/mcp/servers/a", UI, { command: "x", secrets: { TOKEN: "v" } })).statusCode).toBe(400);
    expect(s.config.factory.mcp.servers).toEqual([]);
  });
  it("tests readiness without starting the server, sets the default, and removes a server with its secrets", async () => {
    const s = setup();
    await s.call("PUT", "/api/mcp/servers/github", UI, { command: "mcp-github", env: ["TOKEN"] });
    expect((await s.call("POST", "/api/mcp/servers/github/test", UI)).json()).toMatchObject({ ok: false, missingSecrets: ["TOKEN"], commandFound: false });
    await s.call("PUT", "/api/mcp/servers/github", UI, def);
    expect((await s.call("PUT", "/api/mcp/default", UI, { servers: ["ghost"] })).statusCode).toBe(400);
    expect((await s.call("PUT", "/api/mcp/default", UI, { servers: ["github"] })).statusCode).toBe(200);
    expect(s.config.factory.mcp.defaultServers).toEqual(["github"]);
    expect((await s.call("DELETE", "/api/mcp/servers/github", UI)).statusCode).toBe(200);
    expect(s.config.factory.mcp).toMatchObject({ servers: [], defaultServers: [] });
    expect(s.store.get(mcpAccount("github", "TOKEN"))).toBeUndefined();
  });
  it("refuses to remove a server a project still selects", async () => {
    const s = setup();
    await s.call("PUT", "/api/mcp/servers/github", UI, def);
    upsertProject({ id: "w", name: "W", github: { repo: "me/w" }, overrides: { mcpServers: ["github"] } }, s.dir);
    const r = await s.call("DELETE", "/api/mcp/servers/github", UI);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/still select/);
  });
  const proj = { name: "W", github: { repo: "me/w" } };
  it("refuses a project save that selects an unknown server, naming it, and writes nothing", async () => {
    const s = setup();
    await s.call("PUT", "/api/mcp/servers/github", UI, def);
    const r = await s.call("PUT", "/api/settings/projects/w", UI, { ...proj, overrides: { mcpServers: ["github", "ghost"] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('"ghost"');
    expect(s.config.projects.projects.find((p) => p.id === "w")).toBeUndefined();
  });
  it("a project save keeps a selection that is sent back, keeps [] as none, and a save without one follows the profile", async () => {
    const s = setup();
    await s.call("PUT", "/api/mcp/servers/github", UI, def);
    await s.call("PUT", "/api/mcp/default", UI, { servers: ["github"] });
    const saved = () => s.config.projects.projects.find((p) => p.id === "w");
    expect((await s.call("PUT", "/api/settings/projects/w", UI, { ...proj, overrides: { mcpServers: ["github"] } })).statusCode).toBe(200);
    // the editor sends the existing selection back along with other changes
    expect((await s.call("PUT", "/api/settings/projects/w", UI, { ...proj, name: "Renamed", overrides: { maxImplementationPasses: 2, mcpServers: ["github"] } })).statusCode).toBe(200);
    expect(saved()?.overrides?.mcpServers).toEqual(["github"]);
    expect((await s.call("PUT", "/api/settings/projects/w", UI, { ...proj, overrides: { mcpServers: [] } })).statusCode).toBe(200);
    expect(saved()?.overrides?.mcpServers).toEqual([]);
    expect(mcpServersOf(s.config, saved())).toEqual([]);
    expect((await s.call("PUT", "/api/settings/projects/w", UI, { ...proj })).statusCode).toBe(200);
    expect(mcpServersOf(s.config, saved())).toEqual(["github"]);
  });
});
