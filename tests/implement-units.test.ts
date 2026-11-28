import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addedLines, addedLinesByFile, changedFiles, codeDiff } from "../src/implement/diff.js";
import { buildReport, isSecuritySensitive } from "../src/implement/handlers.js";
import { extractCriteria, implementPrompt, implRemediationPrompt } from "../src/implement/prompts.js";
import { historyText, HUMAN_ONLY_REASON, isDeferrable, openTasks, sameFinding } from "../src/implement/history.js";
import { humanItems } from "../src/delivery/handlers.js";
import { isTestFile, scanForSecrets, scanHistoryForSecrets } from "../src/implement/secrets.js";
import { writeExecWrapper } from "../src/exec/factory-exec.js";
import { sandboxAvailable } from "../src/exec/sandbox.js";
import { fixture } from "./helpers/scripted-agent.js";
import { makeRepo, sh, tmp } from "./helpers/git-fixture.js";

describe("scanForSecrets", () => {
  // Built at runtime so this file's own lines never match the scanner (a literal key here would stop any job that edits it).
  const AWS_KEY = "AKIA" + "Q".repeat(16);
  const AWS_DOC_KEY = "AKIAIOSFODNN7" + "EXAMPLE";
  const hit = (s: string) => scanForSecrets([s]).map((h) => h.rule);
  it.each([
    ["-----BEGIN RSA PRIVATE KEY-----", "private-key"], [`const k = '${AWS_KEY}'`, "aws-access-key"],
    ["token: ghp_" + "a".repeat(36), "github-token"], ["x = 'lin_api_" + "A".repeat(30) + "'", "linear-api-key"], ["k='sk-ant-api03-" + "z".repeat(40) + "'", "anthropic-key"],
    ["password = \"hunter2hunter2hunter2\"", "credential-assignment"], ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "jwt"],
  ])("flags %j", (line, rule) => expect(hit(line)).toEqual([rule]));
  it("ignores placeholders, docs and ordinary code", () => {
    for (const l of ["const apiKey = process.env.API_KEY;", "password = \"<your-password-here>\"", "token: 'changeme-changeme-123456'", "// set LINEAR_API_KEY in your environment", "const total = a + b;"]) expect(hit(l)).toEqual([]);
  });
  it("ignores the access keys AWS publishes in its documentation, but nothing else that looks like one", () => {
    for (const k of [AWS_DOC_KEY, "AKIAI44QH8DHB" + "EXAMPLE", "ASIAIOSFODNN7" + "EXAMPLE"]) expect(hit(`const KEY = "${k}";`)).toEqual([]);
    expect(hit(`const KEY = "${AWS_KEY}";`)).toEqual(["aws-access-key"]);
    expect(hit("const KEY = 'AKIAIOSFODNN7" + "EXAMPLF';")).toEqual(["aws-access-key"]); // one character off the documented key
    expect(hit("const KEY = 'ASIAI44QH8DHB" + "EXAMPLE';")).toEqual(["aws-access-key"]); // not a documented pairing
  });
  it("never echoes the secret itself", () => {
    const [h] = scanForSecrets([`AWS_KEY = '${AWS_KEY}'`]);
    expect(JSON.stringify(h)).not.toContain(AWS_KEY.slice(6));
  });
});

describe("scanHistoryForSecrets: test files and the generic credential heuristic", () => {
  const FIXTURE = 'const SECRET = "s3cr3t-value-' + '123";';
  const added = (file: string, line: string) => [{ file, line }];
  it("recognises test files", () => {
    for (const f of ["tests/mcp.test.ts", "src/a/b.spec.js", "web/src/lib/x.test.tsx", "test/due.test.js", "pkg/__tests__/x.ts", "tests/helpers/fixture.ts"]) expect(isTestFile(f), f).toBe(true);
    for (const f of ["src/config.ts", "src/latest/config.ts", "docs/testing.md", "src/contest.ts", ""]) expect(isTestFile(f), f).toBe(false);
  });
  it("lets a made-up credential in a test file through, but flags the same line anywhere else", () => {
    expect(scanHistoryForSecrets(added("tests/mcp.test.ts", FIXTURE))).toEqual([]);
    expect(scanHistoryForSecrets(added("src/config.ts", FIXTURE)).map((h) => h.rule)).toEqual(["credential-assignment"]);
    expect(scanHistoryForSecrets(added("", FIXTURE)).map((h) => h.rule)).toEqual(["credential-assignment"]); // unknown file: not exempt
  });
  it("still flags real token formats in test files", () => {
    for (const [line, rule] of [["const k = 'AKIA" + "Q".repeat(16) + "'", "aws-access-key"], ["t = 'ghp_" + "a".repeat(36) + "'", "github-token"], ["-----BEGIN RSA PRIVATE KEY-----", "private-key"]] as const)
      expect(scanHistoryForSecrets(added("tests/x.test.ts", line)).map((h) => h.rule)).toEqual([rule]);
  });
  it("attributes added lines to their files", () => {
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n+one\n-gone\n+two\ndiff --git a/t/x.test.ts b/t/x.test.ts\n--- /dev/null\n+++ b/t/x.test.ts\n@@\n+three\n";
    expect(addedLinesByFile(diff)).toEqual([{ file: "a.ts", line: "one" }, { file: "a.ts", line: "two" }, { file: "t/x.test.ts", line: "three" }]);
  });
});

describe("diff helpers (real git)", () => {
  it("separates code from spec artefacts, reports files and stat, truncates huge diffs", async () => {
    const { repo } = makeRepo({ "src/a.js": "a\n" });
    sh(repo, "checkout", "-q", "-b", "feat");
    mkdirSync(join(repo, "specs/x"), { recursive: true });
    writeFileSync(join(repo, "specs/x/spec.md"), "spec"); writeFileSync(join(repo, "src/a.js"), "a\nb\n"); writeFileSync(join(repo, "src/big.js"), "x\n".repeat(5000));
    sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "c");
    expect(await changedFiles(repo, "main")).toEqual(["specs/x/spec.md", "src/a.js", "src/big.js"]);
    expect(await changedFiles(repo, "main", { code: true })).toEqual(["src/a.js", "src/big.js"]);
    const d = await codeDiff(repo, "main", 200);
    expect(d.files).toEqual(["src/a.js", "src/big.js"]);
    expect(d.truncated).toBe(true);
    expect(d.text).toContain("diff truncated");
    expect(d.stat).toContain("src/big.js");
    expect(d.text).not.toContain("specs/x");
    expect(addedLines("+++ b/f\n+real\n-gone\n ctx")).toEqual(["real"]);
  });
  it("is empty when nothing but specs changed", async () => {
    const { repo } = makeRepo();
    sh(repo, "checkout", "-q", "-b", "feat"); mkdirSync(join(repo, "specs"), { recursive: true }); writeFileSync(join(repo, "specs/s.md"), "x"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "c");
    expect((await codeDiff(repo, "main")).files).toEqual([]);
  });
});

describe("heuristics and report", () => {
  it("flags security-sensitive changes by path or by code", () => {
    expect(isSecuritySensitive(["src/auth/login.js"], "")).toBe(true);
    expect(isSecuritySensitive(["package.json"], "")).toBe(true);
    expect(isSecuritySensitive([".github/workflows/ci.yml"], "")).toBe(true);
    expect(isSecuritySensitive(["src/a.js"], "+const out = require('child_process').execSync(cmd)")).toBe(true);
    expect(isSecuritySensitive(["src/a.js"], "+const sum = a + b")).toBe(false);
  });
  it("extracts FR and SC criteria from a real Spec Kit spec", () => {
    const c = extractCriteria(fixture("spec.md"));
    expect(c.filter((x) => x.id.startsWith("FR-")).length).toBeGreaterThanOrEqual(5);
    expect(c.filter((x) => x.id.startsWith("SC-")).length).toBeGreaterThanOrEqual(3);
    expect(c[0]!.text.length).toBeGreaterThan(10);
  });
  it("builds an evidence report with checks, criteria, commits and rejected findings", () => {
    const md = buildReport({ key: "JAM-1", title: "T", url: "u", branch: "factory/JAM-1", base: "origin/main", stat: " a | 2 +-", commits: "abc1234 impl", remediations: 1, rejected: ["R2: already covered"],
      results: [{ kind: "test", command: "npm test", ok: true, exitCode: 0, timedOut: false, cancelled: false, durationMs: 4000, tail: "", sandboxed: true }],
      criteria: [{ id: "FR-001", met: true, evidence: "src/a.js:1, test/a.test.js:3" }] });
    expect(md).toContain("PASS `test`"); expect(md).toContain("MET FR-001: src/a.js:1"); expect(md).toContain("R2: already covered"); expect(md).toContain("remediation cycles: 1");
  });
});

describe.skipIf(!sandboxAvailable())("factory-exec wrapper: the only way an agent runs project code", () => {
  const setup = () => {
    const wt = realpathSync(tmp()); const dir = realpathSync(tmp());
    writeFileSync(join(wt, "marker.txt"), "M");
    const wrapper = writeExecWrapper(dir, { worktree: wt, profileDir: join(dir, "p"), timeoutMs: 20_000, commands: { test: "cat marker.txt && echo RAN-TEST", lint: "exit 3" } });
    return { wt, dir, wrapper };
  };
  const run = (w: string, ...args: string[]) => spawnSync(w, args, { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  it("runs the configured command sandboxed and reports pass/fail with the right exit code", () => {
    const { wrapper } = setup();
    const ok = run(wrapper, "test");
    expect(ok.status).toBe(0); expect(ok.stdout).toContain("RAN-TEST"); expect(ok.stdout).toMatch(/test: PASSED.*sandboxed, no network/);
    const bad = run(wrapper, "lint");
    expect(bad.status).toBe(1); expect(bad.stdout).toContain("FAILED (exit 3)");
  });
  it("accepts only the named checks: no arbitrary command, no unconfigured check, and install only when the project configures one", () => {
    const { wrapper, wt } = setup();
    expect(run(wrapper, "install").status).toBe(65); // this project has no install command: nothing to run (never a command of the agent's own)
    expect(run(wrapper, "rm -rf /").status).toBe(64);
    expect(run(wrapper, "echo pwned > " + join(wt, "pwn.txt")).status).toBe(64);
    expect(run(wrapper, "typecheck").status).toBe(65);
    expect(run(wrapper, "visual").status).toBe(65); // known kind, not configured
    expect(run(wrapper, "bogus").stderr).toContain("allowed: test, lint, typecheck, build, install, visual");
    expect(() => readFileSync(join(wt, "pwn.txt"))).toThrow();
    expect(run(wrapper).status).toBe(64);
  });
  it("runs a configured visual check sandboxed and reports its result", () => {
    const wt = realpathSync(tmp()); const dir = realpathSync(tmp());
    const wrapper = writeExecWrapper(dir, { worktree: wt, profileDir: join(dir, "p"), timeoutMs: 20_000, commands: { visual: "echo RAN-VISUAL" } });
    const r = run(wrapper, "visual");
    expect(r.status).toBe(0); expect(r.stdout).toContain("RAN-VISUAL"); expect(r.stdout).toMatch(/visual: PASSED.*sandboxed, no network/);
  });
  it("the wrapper and its spec live outside the worktree and are not world-writable", () => {
    const { wrapper, dir } = setup();
    expect(wrapper.startsWith(dir)).toBe(true);
    expect(execFileSync("stat", ["-f", "%Lp", wrapper], { encoding: "utf8" }).trim()).toBe("700");
    expect(execFileSync("stat", ["-f", "%Lp", join(dir, "exec-spec.json")], { encoding: "utf8" }).trim()).toBe("600");
  });
});

describe("visual check in the implementer prompts", () => {
  const base = { featureDir: "specs/x", wrapper: "/w/factory-exec", pass: 1 };
  it("keeps the defer-all-visual wording without a visual check, and changes it only with one", () => {
    const without = implementPrompt({ ...base, checks: ["test"] });
    const withV = implementPrompt({ ...base, checks: ["test", "visual"] });
    expect(without).toContain("manual or visual testing");
    expect(without).not.toContain("`visual` check");
    expect(withV).not.toContain("manual or visual testing");
    expect(withV).toContain("`/w/factory-exec visual`");
    expect(withV).toContain("Defer only what a person must judge");
    expect(withV).toContain("real devices"); // the rest of the rule stays
    const rem = (checks: string[]) => implRemediationPrompt({ wrapper: "/w/factory-exec", checks, findings: [] });
    expect(rem(["test"])).toContain("manual or visual testing");
    expect(rem(["test", "visual"])).toContain("Defer only what a person must judge");
  });
});

describe("human deferral and fix-cycle memory (pure helpers)", () => {
  it("openTasks finds unticked tasks and which ones the spec reserved for a human", () => {
    const md = "- [x] T001 done\n- [ ] T002 [P] [US1] write code\n  - [ ] T003 [HUMAN] walk through quickstart in a browser\n- [ ] T004 [HUMAN: needs a phone] check on device\n- [ ] not a task\n";
    expect(openTasks(md)).toEqual([
      { id: "T002", text: "[P] [US1] write code", human: false },
      { id: "T003", text: "[HUMAN] walk through quickstart in a browser", human: true },
      { id: "T004", text: "[HUMAN: needs a phone] check on device", human: true },
    ]);
  });
  it("stable ids match by id; reviewer ids (reused each cycle) match by file and wording", () => {
    expect(sameFinding({ id: "gate:tasks-open", severity: "blocker" }, { id: "gate:tasks-open", severity: "blocker" })).toBe(true);
    expect(sameFinding({ id: "criterion:FR-001", severity: "blocker" }, { id: "criterion:FR-002", severity: "blocker" })).toBe(false);
    const a = { id: "R1", severity: "major", file: "src/a.ts", issue: "isOverdue does not validate the due date string" };
    expect(sameFinding(a, { ...a, id: "R7", issue: "isOverdue does not validate the due date string format" })).toBe(true);
    expect(sameFinding(a, { ...a, id: "R1", issue: "the error message is not translated" })).toBe(false); // same id, different finding
    expect(sameFinding(a, { ...a, file: "src/b.ts" })).toBe(false);
  });
  it("only soft findings can be deferred; failing checks and safety gates cannot", () => {
    for (const id of ["gate:tasks-open", "criterion:FR-001", "R1", "sec:S2", "ci:CI/deploy"]) expect(isDeferrable(id), id).toBe(true);
    for (const id of ["check:test", "gate:check-lint", "gate:test-weakening", "gate:test-deleted", "gate:protected-path", "gate:clean-tree", "gate:conflict-markers", "gate:no-change"]) expect(isDeferrable(id), id).toBe(false);
  });
  it("recognises a rejection that really means 'a human has to do this'", () => {
    expect(HUMAN_ONLY_REASON.test("T023 is a manual quickstart walkthrough")).toBe(true);
    expect(HUMAN_ONLY_REASON.test("needs a real device to verify")).toBe(true);
    expect(HUMAN_ONLY_REASON.test("callers validate input per FR-003")).toBe(false);
  });
  it("historyText is empty before any cycle and summarises outcomes and scope afterwards", () => {
    expect(historyText([], [])).toBe("");
    const t = historyText([{ n: 1, stage: "LOCAL_MODEL_REVIEW", head: "abc", findings: [{ id: "R1", severity: "major", file: "src/a.ts", issue: "x", outcome: "rejected", reason: "because" }] }], [{ id: "T023", what: "task T023 in tasks.md", reason: "manual" }], " src/a.ts | 2 +-");
    expect(t).toMatch(/R1 src\/a\.ts: x -> REJECTED by the implementer: because/);
    expect(t).toMatch(/Deferred to a human[\s\S]*T023/);
    expect(t).toMatch(/only for code that changed since the last review/);
  });
  it("humanItems lists deferrals (with the task text) and [HUMAN] tasks, once each", () => {
    const items = humanItems({ deferred: [{ id: "T003", what: "task T003 in tasks.md", reason: "browser" }, { id: "R9", what: "src/a.ts: check on a phone", reason: "device" }], tasksMd: "- [ ] T003 [HUMAN] walk through quickstart\n- [ ] T004 [HUMAN] look at the colours\n" });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/^- \[ \] \*\*T003\*\* walk through quickstart\n {2}_Why a human:_ browser$/);
    expect(items[1]).toContain("R9**: src/a.ts: check on a phone");
    expect(items[2]).toBe("- [ ] **T004** look at the colours");
  });
  it("the pass>1 prompt states what converge actually found, and never claims tasks were appended when none were", () => {
    const base = { featureDir: "specs/x", wrapper: "/w", checks: ["test"], pass: 2 };
    const none = implementPrompt({ ...base, gaps: { appended: 0, summary: "migration missing" } });
    expect(none).toContain("migration missing"); expect(none).toMatch(/appended no new tasks/); expect(none).not.toMatch(/appended \d+ new task/);
    expect(implementPrompt({ ...base, gaps: { appended: 2, summary: "edge cases" } })).toMatch(/appended 2 new task\(s\) to tasks\.md: do those/);
    expect(implementPrompt({ ...base, pass: 1 })).not.toMatch(/This is pass/);
  });
});

describe("prompts follow the project's agent access", () => {
  const r = { featureDir: "specs/x", wrapper: "/w/exec", checks: ["test"], findings: [{ id: "check:test" }] };
  it("bashAny drops the 'other code-running commands are refused' limit; off keeps it", () => {
    const o = { featureDir: "specs/x", wrapper: "/w/exec", checks: ["test"], pass: 1 };
    expect(implRemediationPrompt(r)).toMatch(/other code-running commands are refused/);
    expect(implRemediationPrompt({ ...r, bashAny: false })).toMatch(/other code-running commands are refused/);
    const a = implRemediationPrompt({ ...r, bashAny: true });
    expect(a).not.toMatch(/other code-running commands are refused/);
    expect(a).not.toMatch(/unrestricted access/);
    expect(a).toMatch(/still refused/);
    expect(implementPrompt(o)).toMatch(/they are refused/);
    expect(implementPrompt({ ...o, bashAny: true })).not.toMatch(/they are refused/);
  });
  it("restricted: only the check tool; unrestricted: free to run tools, and told old 'cannot run' conclusions no longer hold", () => {
    expect(implRemediationPrompt(r)).toMatch(/check tool only/);
    expect(implRemediationPrompt(r)).not.toMatch(/unrestricted access/);
    const u = implRemediationPrompt({ ...r, unrestricted: true });
    expect(u).toMatch(/unrestricted access/);
    expect(u).toMatch(/no longer holds/);
    expect(u).not.toMatch(/other code-running commands are refused/);
  });
  it("tells the agent that regenerating fixtures for a deliberate change is a fix, in both modes", () => {
    for (const unrestricted of [false, true]) expect(implRemediationPrompt({ ...r, unrestricted })).toMatch(/regenerating them with the project's own tooling is a fix/);
  });
});
