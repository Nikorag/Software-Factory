import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelRouter } from "../src/agents/router.js";
import { AgentRunner } from "../src/agents/runner.js";
import { FactoryConfig, ModelsConfig, ProjectConfig } from "../src/config/schema.js";
import { openDb } from "../src/db/client.js";
import { onboardProject, raiseOnboardingPr } from "../src/speckit/onboard.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { GitHubError } from "../src/github/client.js";
import { commitPaths, findBinary, initSpecKit, isInitialised } from "../src/speckit/tools.js";
import { ScriptedAgent, overwrite } from "./helpers/scripted-agent.js";
import { makeRepo, sh, tmp } from "./helpers/git-fixture.js";

/** A stand-in `specify` that creates the files the real 1.4.4 CLI creates (observed on a scratch repo). */
const fakeSpecify = () => {
  const bin = join(tmp(), "specify");
  writeFileSync(bin, `#!${process.execPath}
const fs=require('fs');const a=process.argv.slice(2);
if(!a.includes('--non-interactive')||!a.includes('--integration')||a[a.indexOf('--integration')+1]!=='claude'){console.error('bad flags: '+a.join(' '));process.exit(2)}
fs.mkdirSync('.specify/memory',{recursive:true});fs.mkdirSync('.claude/skills/speckit-specify',{recursive:true});
fs.writeFileSync('.specify/init-options.json','{}');fs.writeFileSync('.specify/memory/constitution.md','# [PROJECT_NAME] Constitution\\n');
fs.writeFileSync('.claude/skills/speckit-specify/SKILL.md','skill');`, { mode: 0o755 });
  return bin;
};

const setup = (agentBehaviour?: (cwd: string) => void) => {
  const fx = makeRepo({ "README.md": "# App\n", "package.json": "{}" });
  const project = ProjectConfig.parse({ id: "p", name: "P", repository: fx.repo });
  const agent = new ScriptedAgent("anthropic");
  agent.run = async (req) => { agentBehaviour?.(req.cwd); agent.calls.push(req); return { ok: true, text: "ok", denials: [], exitCode: 0, durationMs: 1 }; };
  const route = { provider: "anthropic" as const, model: "default" };
  const router = new ModelRouter(ModelsConfig.parse({ routes: { classification: route, specification: route, implementation: route, independent_review: route, final_review: route } }), { anthropic: agent, local: agent });
  const runner = new AgentRunner({ db: openDb(":memory:").db, router, logDir: join(fx.base, "logs"), protectedPaths: FactoryConfig.parse({}).protectedPaths }); // the REAL default list, which includes .claude/** and .specify/scripts/**
  return { fx, project, agent, runner, dataDir: join(fx.base, "data") };
};

describe("project onboarding", () => {
  it("creates a review branch with Spec Kit and a constitution, without touching the checkout or pushing", async () => {
    const s = setup((cwd) => overwrite(cwd, ".specify/memory/constitution.md", "# P Constitution\n\n## Principles\n- Tests: `npm test` must pass.\n"));
    const r = await onboardProject(s.project, { runner: s.runner, dataDir: s.dataDir, init: { bin: fakeSpecify() } });
    expect(r).toMatchObject({ status: "created", branch: "factory/onboard-speckit", commits: ["initialise Spec Kit", "constitution"] });
    expect(sh(r.worktree, "log", "--format=%s", "origin/main..HEAD").split("\n")).toEqual(["docs: add project constitution (for review)", "chore: initialise Spec Kit (claude integration)"]);
    expect(readFileSync(join(r.worktree, ".specify/memory/constitution.md"), "utf8")).toContain("npm test");
    expect(isInitialised(s.fx.repo)).toBe(false); // original checkout untouched
    expect(sh(s.fx.repo, "status", "--porcelain")).toBe("");
    expect(sh(s.fx.origin, "branch", "--list")).not.toContain("onboard"); // never pushed: a human reviews policy first
    const call = s.agent.calls[0]!;
    expect(call).toMatchObject({ role: "spec-writer", profile: "spec-writer" });
    expect(call.prompt).toContain("speckit-constitution/SKILL.md");
    expect(call.prompt).toMatch(/do not invent standards/i);
  });
  it("does not flag the factory's own init commit (which adds protected .claude/ and .specify/ files) as an agent violation, but still catches the agent touching them", async () => {
    const ok = setup((cwd) => overwrite(cwd, ".specify/memory/constitution.md", "# fine\n"));
    await expect(onboardProject(ok.project, { runner: ok.runner, dataDir: ok.dataDir, init: { bin: fakeSpecify() } })).resolves.toMatchObject({ status: "created" });
    const bad = setup((cwd) => overwrite(cwd, ".claude/skills/speckit-specify/SKILL.md", "tampered"));
    await expect(onboardProject(bad.project, { runner: bad.runner, dataDir: bad.dataDir, init: { bin: fakeSpecify() } })).rejects.toThrow(/boundary violation.*\.claude\/skills/);
  });
  it("is idempotent: a second run does not re-run the agent or overwrite a reviewed constitution", async () => {
    const s = setup((cwd) => overwrite(cwd, ".specify/memory/constitution.md", "# Reviewed\n"));
    const first = await onboardProject(s.project, { runner: s.runner, dataDir: s.dataDir, init: { bin: fakeSpecify() } });
    overwrite(first.worktree, ".specify/memory/constitution.md", "# Edited by a human\n");
    sh(first.worktree, "commit", "-qam", "human edit");
    const second = await onboardProject(s.project, { runner: s.runner, dataDir: s.dataDir, init: { bin: fakeSpecify() } });
    expect(second.status).toBe("already-initialised");
    expect(s.agent.calls).toHaveLength(1);
    expect(readFileSync(join(second.worktree, ".specify/memory/constitution.md"), "utf8")).toBe("# Edited by a human\n");
  });
  it("recovers when a crash left Spec Kit initialised but the constitution unwritten", async () => {
    const s = setup((cwd) => overwrite(cwd, ".specify/memory/constitution.md", "# Done\n"));
    const crashing = { run: async () => { throw new Error("crash"); } } as unknown as AgentRunner;
    await expect(onboardProject(s.project, { runner: crashing, dataDir: s.dataDir, init: { bin: fakeSpecify() } })).rejects.toThrow("crash");
    const r = await onboardProject(s.project, { runner: s.runner, dataDir: s.dataDir, init: { bin: fakeSpecify() } });
    expect(r.status).toBe("created");
    expect(r.commits).toEqual(["constitution"]); // init was not repeated
    expect(sh(r.worktree, "log", "--format=%s", "-1")).toContain("constitution");
  });
  it("reports the agent's failure instead of committing a half-written constitution", async () => {
    const s = setup();
    s.agent.run = async () => ({ ok: false, text: "", denials: [], exitCode: 1, durationMs: 1, failure: "rate_limited", error: "limit" });
    await expect(onboardProject(s.project, { runner: s.runner, dataDir: s.dataDir, init: { bin: fakeSpecify() } })).rejects.toThrow(/rate_limited/);
  });
});

describe("spec kit tooling", () => {
  it("initSpecKit passes the verified non-interactive flags and surfaces failures", async () => {
    const dir = tmp();
    await initSpecKit(dir, { bin: fakeSpecify() });
    expect(existsSync(join(dir, ".specify/init-options.json"))).toBe(true);
    await expect(initSpecKit(dir, { bin: "/bin/false" })).rejects.toThrow(/specify init failed/);
    await expect(initSpecKit(dir, { bin: "/nonexistent/specify" })).rejects.toThrow(/specify init failed/);
  });
  it("findBinary searches PATH then user-install dirs", () => {
    const d = tmp(); writeFileSync(join(d, "mytool"), "");
    expect(findBinary("mytool", { PATH: `/nope:${d}` }, [])).toBe(join(d, "mytool"));
    expect(findBinary("mytool", { PATH: "/nope" }, [d])).toBe(join(d, "mytool"));
    expect(findBinary("zzz-missing", { PATH: "/nope" }, [])).toBeNull();
  });
  it("commitPaths commits only what changed, only the named paths, as the factory", async () => {
    const { repo } = makeRepo();
    overwrite(repo, "specs/a/spec.md", "x"); overwrite(repo, "other.txt", "y");
    expect(await commitPaths(repo, ["specs"], "spec: add")).toBe(true);
    expect(await commitPaths(repo, ["specs"], "spec: again")).toBe(false); // nothing new
    expect(sh(repo, "log", "--format=%an|%s", "-1")).toBe("Software Factory|spec: add");
    expect(sh(repo, "status", "--porcelain")).toBe("?? other.txt"); // unrelated file left alone
    expect(await commitPaths(repo, ["does-not-exist"], "x")).toBe(false);
  });
});

describe("raising the onboarding PR (never merges)", () => {
  const ready = async () => {
    const s = setup((cwd) => overwrite(cwd, ".specify/memory/constitution.md", "# Constitution\n- tests must pass\n"));
    const r = await onboardProject(s.project, { runner: s.runner, dataDir: s.dataDir, init: { bin: fakeSpecify() } });
    const project = ProjectConfig.parse({ ...s.project, github: { repo: "Nikorag/Thing" } });
    return { ...s, project, r };
  };
  it("pushes factory/onboard-speckit to origin (not main) and opens a PR whose body asks for careful review", async () => {
    const { fx, project, r } = await ready();
    const gh = new FakeGitHub();
    const out = await raiseOnboardingPr(project, { github: gh, worktree: r.worktree });
    expect(out.reused).toBe(false);
    expect(sh(fx.origin, "branch", "--list", "factory/onboard-speckit")).toContain("factory/onboard-speckit");
    expect(sh(fx.origin, "log", "--format=%s", "main", "-1")).toBe("init"); // main untouched
    expect(gh.created[0]).toMatchObject({ repo: "Nikorag/Thing", head: "factory/onboard-speckit", base: "main", title: "Add Spec Kit and project constitution (for review)" });
    expect(gh.created[0]!.body).toMatch(/not merged automatically/);
    expect(gh.created[0]!.body).toMatch(/becomes policy/);
    expect(gh.calls.filter((c) => /merge/i.test(c))).toEqual([]);
  });
  it("retries a transient GitHub failure (seen live) and succeeds, but stops at once on a refusal", async () => {
    const { project, r } = await ready();
    const flaky = new FakeGitHub();
    flaky.failures.push({ method: "createPr", times: 2, error: new GitHubError("GraphQL: Something went wrong while executing your query", true) });
    const out = await raiseOnboardingPr(project, { github: flaky, worktree: r.worktree, retryDelayMs: 1 });
    expect(out.pr.number).toBe(1); expect(flaky.calls.filter((c) => c === "createPr")).toHaveLength(3);
    const refused = new FakeGitHub();
    refused.failures.push({ method: "createPr", times: 9, error: new GitHubError("HTTP 403 forbidden", false) });
    await expect(raiseOnboardingPr(project, { github: refused, worktree: r.worktree, retryDelayMs: 1 })).rejects.toThrow(/403/);
    expect(refused.calls.filter((c) => c === "createPr")).toHaveLength(1);
  });
  it("is idempotent and refuses a closed PR, a missing constitution, and a dirty worktree", async () => {
    const { project, r } = await ready();
    const gh = new FakeGitHub();
    await raiseOnboardingPr(project, { github: gh, worktree: r.worktree });
    expect((await raiseOnboardingPr(project, { github: gh, worktree: r.worktree })).reused).toBe(true);
    expect(gh.created).toHaveLength(1);
    gh.prs[0]!.state = "CLOSED";
    await expect(raiseOnboardingPr(project, { github: gh, worktree: r.worktree })).rejects.toThrow(/already exists and is CLOSED/);
    overwrite(r.worktree, "dirty.txt", "x");
    await expect(raiseOnboardingPr(project, { github: new FakeGitHub(), worktree: r.worktree })).rejects.toThrow(/uncommitted changes/);
    const fresh = setup(); sh(fresh.fx.repo, "branch", "x");
    await expect(raiseOnboardingPr(project, { github: new FakeGitHub(), worktree: fresh.fx.repo })).rejects.toThrow(/no constitution commit/);
  });
});
