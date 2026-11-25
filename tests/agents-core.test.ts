import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentEnv } from "../src/agents/env.js";
import { findProtectedChanges } from "../src/agents/guard.js";
import { pathRoots, toolPolicy } from "../src/agents/permissions.js";
import { runProcess } from "../src/agents/process.js";
import { buildClaudeArgs, parseClaudeOutput, ClaudeCodeAgent } from "../src/agents/claude.js";
import { ROLE_PROFILE, rolePrompt } from "../src/agents/roles.js";
import type { AgentRequest, AgentRole } from "../src/agents/types.js";
import { FactoryConfig } from "../src/config/schema.js";
import { makeRepo, sh, tmp } from "./helpers/git-fixture.js";

const NODE = process.execPath;
const req = (o: Partial<AgentRequest> = {}): AgentRequest => ({ role: "implementer", profile: "implementer", prompt: "SECRET PROMPT TEXT", cwd: tmp(), timeoutMs: 10_000, ...o });

describe("permission profiles", () => {
  const prot = FactoryConfig.parse({}).protectedPaths;
  it("read-only profile can never write", () => {
    const p = toolPolicy("read-only", { protectedPaths: prot });
    expect(p.tools).not.toContain("Write");
    expect(p.tools).not.toContain("Edit");
    expect(p.deny).toEqual(expect.arrayContaining(["Edit", "Write"]));
    expect(p.allow.join()).not.toMatch(/git add|git commit/);
  });
  it("implementer can edit and commit but not push, fetch, branch-switch, shell out to the network or use gh", () => {
    const p = toolPolicy("implementer", { protectedPaths: prot, bashAllow: ["pnpm test"], roots: ["/w"] });
    expect(p.allow).toEqual(expect.arrayContaining(["Edit(//w/**)", "Bash(git commit:*)", "Bash(git add:*)", "Bash(pnpm test:*)"]));
    for (const d of ["git push", "git fetch", "git checkout", "git config", "git remote", "gh", "curl", "ssh", "sudo", "rm -rf"]) expect(p.deny).toContain(`Bash(${d}:*)`);
  });
  it("denies edits to every protected path, including .env and the workflows directory", () => {
    const p = toolPolicy("implementer", { protectedPaths: prot });
    expect(p.deny).toEqual(expect.arrayContaining(["Edit(.env)", "Edit(.env.*)", "Edit(.git/**)", "Edit(**/*.pem)", "Edit(.github/workflows/**)"]));
  });
  it("spec-writer may only create artefacts under specs/ and .specify/", () => {
    const p = toolPolicy("spec-writer", { protectedPaths: prot });
    expect(p.allow).toEqual(expect.arrayContaining(["Edit(specs/**)", "Edit(.specify/memory/**)", "Bash(.specify/scripts/bash/check-prerequisites.sh:*)"]));
    expect(p.allow).not.toContain("Edit(.specify/**)"); // would allow editing the scripts and templates it executes
    expect(p.deny).toEqual(expect.arrayContaining(["Edit(.claude/**)", "Edit(.specify/scripts/**)", "Edit(.specify/templates/**)"]));
    expect(p.allow).not.toContain("Write");
    expect(p.allow).not.toContain("Edit");
  });
  it("never grants bare Write/Edit: the implementer may only edit inside its worktree (absolute scope)", () => {
    const p = toolPolicy("implementer", { protectedPaths: prot, roots: ["/work/JAM-1", "/alias/JAM-1"] });
    expect(p.allow).not.toContain("Write");
    expect(p.allow).not.toContain("Edit");
    expect(p.allow).toEqual(expect.arrayContaining(["Edit(//work/JAM-1/**)", "Edit(//alias/JAM-1/**)"]));
    expect(p.allow.filter((a) => a.startsWith("Edit("))).toHaveLength(2); // nothing broader than the roots
    expect(toolPolicy("implementer", { protectedPaths: prot }).allow.some((a) => a.startsWith("Edit"))).toBe(false); // no roots, no writes
  });
  it("never grants bare Read/Grep/Glob, which would let agents read outside their worktree", () => {
    for (const prof of ["read-only", "spec-writer", "implementer"] as const) {
      const allow = toolPolicy(prof, { protectedPaths: prot }).allow;
      for (const t of ["Read", "Grep", "Glob", "Bash", "Write", "Edit"]) expect(allow).not.toContain(t);
    }
  });
  it("a deny is never also an allow", () => {
    for (const prof of ["read-only", "spec-writer", "implementer"] as const) {
      const p = toolPolicy(prof, { protectedPaths: prot, bashAllow: ["pnpm test"] });
      expect(p.allow.filter((a) => p.deny.includes(a))).toEqual([]);
    }
  });
  it("every role has a prompt and the reviewers are read-only", () => {
    for (const r of Object.keys(ROLE_PROFILE) as AgentRole[]) expect(rolePrompt(r).length).toBeGreaterThan(50);
    for (const r of ["spec-reviewer", "qa-reviewer", "security-reviewer", "final-reviewer", "requirements-analyst", "classifier"] as AgentRole[]) expect(ROLE_PROFILE[r]).toBe("read-only");
    expect(ROLE_PROFILE.implementer).toBe("implementer");
  });
});

describe("absolute path anchoring (survives a Bash `cd`)", () => {
  const prot = [".env", ".git/**", "**/*.pem", ".claude/**"];
  it("emits relative AND absolute forms of every scoped allow and every protected-path deny", () => {
    const p = toolPolicy("spec-writer", { protectedPaths: prot, roots: ["/work/JAM-1"] });
    expect(p.allow).toEqual(expect.arrayContaining(["Edit(specs/**)", "Edit(//work/JAM-1/specs/**)", "Edit(//work/JAM-1/.specify/memory/**)", "Edit(//work/JAM-1/.specify/feature.json)"]));
    expect(p.deny).toEqual(expect.arrayContaining(["Edit(.env)", "Edit(//work/JAM-1/.env)", "Edit(//work/JAM-1/.git/**)", "Edit(//work/JAM-1/**/*.pem)", "Edit(//work/JAM-1/.claude/**)"]));
    const i = toolPolicy("implementer", { protectedPaths: prot, roots: ["/work/JAM-1"] });
    expect(i.deny).toContain("Edit(//work/JAM-1/.env)");
  });
  it("covers every spelling of the root, including macOS /var vs /private/var", () => {
    const real = tmp();
    const roots = pathRoots(real);
    expect(roots).toContain(real);
    if (real.startsWith("/private/var/")) expect(roots).toContain(real.slice("/private".length));
    const p = toolPolicy("spec-writer", { roots });
    for (const r of roots) expect(p.allow).toContain(`Edit(//${r.slice(1)}/specs/**)`);
  });
  it("buildClaudeArgs passes the anchored rules for the request's cwd", () => {
    const cwd = tmp();
    const a = buildClaudeArgs({ role: "spec-writer", profile: "spec-writer", prompt: "x", cwd, timeoutMs: 1 });
    expect(a.join(" ")).toContain(`Edit(//${cwd.slice(1)}/specs/**)`);
  });
});

describe("buildClaudeArgs", () => {
  it("never uses --bare or permission bypass, and keeps the prompt off the command line", () => {
    const a = buildClaudeArgs(req());
    expect(a).not.toContain("--bare");
    expect(a.join(" ")).not.toMatch(/dangerously|bypassPermissions/);
    expect(a.join(" ")).not.toContain("SECRET PROMPT TEXT");
    expect(a).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--strict-mcp-config"]));
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
  });
  it("passes a model only when it is not 'default'", () => {
    expect(buildClaudeArgs(req({ model: "default" }))).not.toContain("--model");
    expect(buildClaudeArgs(req())).not.toContain("--model");
    const a = buildClaudeArgs(req({ model: "claude-opus-5-5" }));
    expect(a[a.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  });
  it("supports structured output, resume and session persistence", () => {
    expect(buildClaudeArgs(req({ jsonSchema: { type: "object" } }))).toEqual(expect.arrayContaining(["--json-schema", '{"type":"object"}']));
    expect(buildClaudeArgs(req())).toContain("--no-session-persistence");
    expect(buildClaudeArgs(req({ persistSession: true }))).not.toContain("--no-session-persistence");
    const r = buildClaudeArgs(req({ resumeSessionId: "abc" }));
    expect(r).toEqual(expect.arrayContaining(["--resume", "abc"]));
    expect(r).not.toContain("--no-session-persistence");
  });
});

describe("parseClaudeOutput (shapes captured from the real CLI)", () => {
  const run = (o: object, exitCode: number | null = 0, stderr = "") => ({ stdout: JSON.stringify(o), stderr, exitCode, durationMs: 5 });
  const ok = { type: "result", subtype: "success", is_error: false, result: "OK", session_id: "s1", total_cost_usd: 0.01, num_turns: 1, usage: { input_tokens: 3 }, permission_denials: [] };
  it("parses success with usage, cost and session", () => {
    expect(parseClaudeOutput(run(ok))).toMatchObject({ ok: true, text: "OK", sessionId: "s1", costUsd: 0.01, numTurns: 1 });
  });
  it("returns structured_output when present", () => {
    expect(parseClaudeOutput(run({ ...ok, structured_output: { verdict: "fail" } })).structured).toEqual({ verdict: "fail" });
  });
  it("surfaces permission denials", () => {
    const r = parseClaudeOutput(run({ ...ok, permission_denials: [{ tool_name: "Bash", tool_input: { command: "git push" } }] }));
    expect(r.denials).toEqual([{ tool: "Bash", input: '{"command":"git push"}' }]);
  });
  it("classifies failures: auth, rate limit, transient, other", () => {
    expect(parseClaudeOutput(run({ ...ok, is_error: true, api_error_status: 401, result: "Invalid API key" }, 1)).failure).toBe("auth");
    expect(parseClaudeOutput(run({ ...ok, is_error: true, api_error_status: 429, result: "x" }, 1)).failure).toBe("rate_limited");
    expect(parseClaudeOutput(run({ ...ok, is_error: true, result: "Claude usage limit reached" }, 1)).failure).toBe("rate_limited");
    expect(parseClaudeOutput(run({ ...ok, is_error: true, api_error_status: 529, result: "Overloaded" }, 1)).failure).toBe("transient");
    expect(parseClaudeOutput(run({ ...ok, is_error: true, subtype: "error_during_execution", result: "boom" }, 1)).failure).toBe("error");
  });
  it("treats unparseable output as a failure, never as success", () => {
    const r = parseClaudeOutput({ stdout: "not json", stderr: "crash", exitCode: 1, durationMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unparseable");
  });
  it("a non-zero exit is a failure even if the JSON says success", () => {
    expect(parseClaudeOutput(run(ok, 2)).ok).toBe(false);
  });
});

describe("agentEnv", () => {
  it("drops every secret and keeps what the CLI needs", () => {
    const env = agentEnv({
      PATH: "/bin", HOME: "/h", LANG: "en", LC_ALL: "C", LINEAR_API_KEY: "lin", GH_TOKEN: "gh", GITHUB_TOKEN: "gh2", ANTHROPIC_API_KEY: "sk",
      AWS_SECRET_ACCESS_KEY: "aws", SSH_AUTH_SOCK: "/s", RANDOM_UNKNOWN_SECRET: "x", NPM_TOKEN: "n",
    });
    expect(Object.keys(env).sort()).toEqual(["CI", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "LC_ALL", "PATH"]);
    expect(JSON.stringify(env)).not.toMatch(/lin|gh2|sk|aws|SSH|RANDOM|NPM/);
  });
});

describe("runProcess", () => {
  const base = { cwd: process.cwd(), env: process.env };
  it("delivers stdin and captures stdout, stderr and the exit code", async () => {
    const r = await runProcess({ ...base, cmd: NODE, args: ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log('got:'+d);console.error('warn');process.exit(3)})"], stdin: "hello", timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: 3, timedOut: false, cancelled: false });
    expect(r.stdout.trim()).toBe("got:hello");
    expect(r.stderr.trim()).toBe("warn");
  });
  it("on timeout kills the whole process tree, not just the top process", async () => {
    const pidFile = join(tmp(), "grandchild.pid");
    const script = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
    const r = await runProcess({ ...base, cmd: NODE, args: ["-e", script], timeoutMs: 600, graceMs: 200 });
    expect(r.timedOut).toBe(true);
    const gc = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    expect(() => process.kill(gc, 0)).toThrow(); // grandchild is gone
  });
  it("cancels on abort signal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runProcess({ ...base, cmd: NODE, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 30_000, signal: ac.signal, graceMs: 200 });
    expect(r.cancelled).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });
  it("an already-aborted signal never lets the process run on", async () => {
    const ac = new AbortController(); ac.abort();
    const r = await runProcess({ ...base, cmd: NODE, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 30_000, signal: ac.signal, graceMs: 100 });
    expect(r.cancelled).toBe(true);
  });
  it("reports a missing binary as a spawn error and writes a log file", async () => {
    const r = await runProcess({ ...base, cmd: "definitely-not-a-binary-xyz", args: [], timeoutMs: 5000 });
    expect(r.spawnError).toBeDefined();
    const logFile = join(tmp(), "logs", "a.log");
    await runProcess({ ...base, cmd: NODE, args: ["-e", "console.log('logged');console.error('oops')"], timeoutMs: 5000, logFile });
    expect(readFileSync(logFile, "utf8")).toContain("logged");
    expect(readFileSync(logFile, "utf8")).toContain("[stderr] oops");
  });
});

describe("ClaudeCodeAgent with a fake claude binary", () => {
  const fake = (body: string) => {
    const dir = tmp(); const bin = join(dir, "claude");
    writeFileSync(bin, `#!${NODE}\n${body}`, { mode: 0o755 });
    return bin;
  };
  it("sends the prompt on stdin, scrubs secrets from the child environment, and parses the result", async () => {
    const bin = fake(`let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({prompt:d,linear:process.env.LINEAR_API_KEY||null,gh:process.env.GH_TOKEN||null,anth:process.env.ANTHROPIC_API_KEY||null,args:process.argv.slice(2)}),session_id:'sid',total_cost_usd:0.5,num_turns:2,permission_denials:[]}))})`);
    const agent = new ClaudeCodeAgent({ bin, env: { PATH: process.env.PATH, HOME: process.env.HOME, LINEAR_API_KEY: "lin_secret", GH_TOKEN: "gh_secret", ANTHROPIC_API_KEY: "sk_secret" } });
    const r = await agent.run(req({ prompt: "do the thing" }));
    expect(r).toMatchObject({ ok: true, sessionId: "sid", costUsd: 0.5, numTurns: 2 });
    const seen = JSON.parse(r.text);
    expect(seen.prompt).toBe("do the thing");
    expect(seen.linear).toBeNull(); expect(seen.gh).toBeNull(); expect(seen.anth).toBeNull();
    expect(seen.args.join(" ")).not.toContain("do the thing");
  });
  it("maps timeout and cancellation to distinct failures", async () => {
    const bin = fake("setInterval(()=>{},1000)");
    const agent = new ClaudeCodeAgent({ bin });
    expect((await agent.run(req({ timeoutMs: 400 }))).failure).toBe("timeout");
    const ac = new AbortController(); setTimeout(() => ac.abort(), 200);
    expect((await agent.run(req({ timeoutMs: 20_000, signal: ac.signal }))).failure).toBe("cancelled");
  }, 20_000);
  it("reports a missing CLI clearly", async () => {
    const r = await new ClaudeCodeAgent({ bin: "/nonexistent/claude" }).run(req());
    expect(r).toMatchObject({ ok: false, failure: "error" });
    expect(r.error).toContain("could not start");
  });
});

describe("findProtectedChanges", () => {
  const P = FactoryConfig.parse({}).protectedPaths;
  it("is empty for ordinary changes", async () => {
    const { repo } = makeRepo();
    writeFileSync(join(repo, "src.ts"), "x"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "c");
    expect(await findProtectedChanges(repo, "HEAD~1", P)).toEqual([]);
  });
  it("catches committed, staged and untracked protected files, including nested ones", async () => {
    const { repo } = makeRepo();
    mkdirSync(join(repo, "deploy"), { recursive: true });
    writeFileSync(join(repo, "deploy", "server.pem"), "k"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "c");
    writeFileSync(join(repo, ".env"), "S=1");
    mkdirSync(join(repo, ".github/workflows"), { recursive: true }); writeFileSync(join(repo, ".github/workflows/ci.yml"), "x");
    expect(await findProtectedChanges(repo, "HEAD~1", P)).toEqual([".env", ".github/workflows/ci.yml", "deploy/server.pem"]);
  });
  it("catches a protected file renamed away (old path)", async () => {
    const { repo } = makeRepo({ "README.md": "x", ".env": "S=1" });
    sh(repo, "mv", ".env", "env.txt");
    expect(await findProtectedChanges(repo, "HEAD", P)).toContain(".env");
  });
  void existsSync;
});
