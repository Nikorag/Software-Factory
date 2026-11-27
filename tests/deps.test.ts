import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDependencies, manifestFingerprint } from "../src/exec/deps.js";
import { main as factoryExec } from "../src/exec/factory-exec.js";
import { sandboxAvailable } from "../src/exec/sandbox.js";
import type { CommandResult } from "../src/exec/commands.js";
import { defaults, write } from "./helpers/impl-agent.js";
import { decisionKinds, harness, job, type H } from "./helpers/impl-harness.js";

const ok = (command: string, pass = true): CommandResult => ({ kind: "install", command, ok: pass, exitCode: pass ? 0 : 1, timedOut: false, cancelled: false, durationMs: 1, tail: "", sandboxed: true });
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), "factory-deps-"));
  execFileSync("git", ["init", "-q", d]);
  writeFileSync(join(d, ".gitignore"), "node_modules\n");
  writeFileSync(join(d, "package.json"), '{"name":"root"}\n');
  return d;
};

describe("dependency manifests", () => {
  it("the fingerprint changes when a package is added (even untracked) or a manifest changes, and ignores node_modules and other files", () => {
    const d = repo();
    const a = manifestFingerprint(d);
    writeFileSync(join(d, "index.js"), "x\n");
    mkdirSync(join(d, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(d, "node_modules", "left-pad", "package.json"), "{}");
    expect(manifestFingerprint(d)).toBe(a);
    mkdirSync(join(d, "config", "workers", "seo-redirect"), { recursive: true });
    writeFileSync(join(d, "config", "workers", "seo-redirect", "package.json"), '{"name":"seo-redirect"}\n');
    const b = manifestFingerprint(d);
    expect(b).not.toBe(a);
    writeFileSync(join(d, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    expect(manifestFingerprint(d)).not.toBe(b);
  });

  it("installs when there is no record, skips while the manifests are unchanged, retries after a failure, and always on request", async () => {
    const state = join(mkdtempSync(join(tmpdir(), "factory-state-")), "deps.json");
    let fp = "A", runs = 0, pass = true;
    const go = (force = false) => ensureDependencies({ worktree: "/w", install: "pnpm install", state, force, fingerprint: () => fp, run: async (c) => { runs++; return ok(c, pass); } });
    expect(await go()).toMatchObject({ ok: true }); // nothing recorded yet
    expect(await go()).toBeNull(); // unchanged
    fp = "B"; pass = false;
    expect(await go()).toMatchObject({ ok: false });
    pass = true;
    expect(await go()).toMatchObject({ ok: true }); // a failed install is not recorded, so it is tried again
    expect(await go()).toBeNull();
    expect(await go(true)).toMatchObject({ ok: true });
    expect(runs).toBe(4);
    expect(await ensureDependencies({ worktree: "/w", state, run: async () => ok("x") })).toBeNull(); // no install command configured
  });
});

describe.skipIf(!sandboxAvailable())("the agent's check tool and dependencies", () => {
  it("installs on request, and before a check when the manifests changed (KPS-19: a new package with no node_modules)", async () => {
    const d = repo();
    const jobDir = mkdtempSync(join(tmpdir(), "factory-job-"));
    // The install marks every package dir that has a package.json; the test needs the new package to be installed.
    // The install marks every package dir that has a package.json and logs each run (inside the worktree: the sandbox lets an
    // install write only there and to package caches). The test exits 126, like KPS-19, when a package was never installed.
    const install = 'for p in $(find . -name package.json -not -path "*/node_modules/*"); do mkdir -p "$(dirname "$p")/node_modules" && echo ok > "$(dirname "$p")/node_modules/.ok"; done; echo run >> installs.log';
    const test = "for p in $(find . -name package.json -not -path '*/node_modules/*'); do test -f \"$(dirname \"$p\")/node_modules/.ok\" || exit 126; done";
    const specPath = join(jobDir, "exec-spec.json");
    writeFileSync(specPath, JSON.stringify({ worktree: d, profileDir: join(jobDir, "profiles"), timeoutMs: 60_000, commands: { test }, install, depsState: join(jobDir, "deps.json"), sandbox: { writeAllow: [] } }));
    const log = () => (existsSync(join(d, "installs.log")) ? readFileSync(join(d, "installs.log"), "utf8").trim().split("\n").length : 0);

    expect(await factoryExec([specPath, "install"])).toBe(0);
    expect(log()).toBe(1);
    expect(await factoryExec([specPath, "test"])).toBe(0);
    expect(log()).toBe(1); // nothing changed: no second install

    mkdirSync(join(d, "config", "workers", "seo-redirect"), { recursive: true });
    writeFileSync(join(d, "config", "workers", "seo-redirect", "package.json"), '{"name":"seo-redirect"}\n');
    expect(await factoryExec([specPath, "test"])).toBe(0); // installed first, by itself, then the test passed
    expect(log()).toBe(2);
    expect(existsSync(join(d, "config", "workers", "seo-redirect", "node_modules", ".ok"))).toBe(true);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(h: H, cond: () => boolean, ticks = 60) { for (let i = 0; i < ticks && !cond(); i++) { await h.engine.tick(); if (!cond()) await sleep(10); } }

describe.skipIf(!sandboxAvailable())("the factory's own checks follow the dependencies", () => {
  it("after the implementer adds a package, the checks install again first, so the new package's tests can run", async () => {
    const h = await harness({
      commands: {
        install: 'for p in $(find . -name package.json -not -path "*/node_modules/*"); do mkdir -p "$(dirname "$p")/node_modules" && echo ok > "$(dirname "$p")/node_modules/.ok"; done',
        test: "node --test && for p in $(find . -name package.json -not -path '*/node_modules/*'); do test -f \"$(dirname \"$p\")/node_modules/.ok\" || exit 126; done",
      },
    });
    h.claude.b.implement = (cwd, dir, n, req) => { defaults().implement(cwd, dir, n, req); write(cwd, "packages/seo-redirect/package.json", '{"name":"seo-redirect"}\n'); };
    await settle(h, () => ["MERGING", "NEEDS_ATTENTION", "FAILED"].includes(job(h).stage));
    expect(h.hist()).toContain("AUTOMATED_TESTING:succeeded");
    expect(h.hist().filter((x) => x.startsWith("REMEDIATION"))).toEqual([]); // nothing for the agent to "fix"
    expect(decisionKinds(h)).toContain("deps.install");
  });
});

describe.skipIf(!sandboxAvailable())("no dead ends for the implementer", () => {
  it("a failing check the implementer cannot fix and may not defer stops for a person with its reasons, instead of failing the job", async () => {
    const h = await harness({ commands: { test: "node --test && test ! -f BROKEN" } });
    h.claude.b.implement = (cwd, dir, n, req) => { defaults().implement(cwd, dir, n, req); write(cwd, "BROKEN", "x\n"); };
    h.claude.b.remediation = () => ({ accepted: [], rejected: [], deferred: [{ id: "check:test", reason: "I can't run pnpm install here, so the new package's tests cannot run" }], summary: "environment limit" });
    await settle(h, () => ["NEEDS_ATTENTION", "FAILED", "MERGING"].includes(job(h).stage));
    expect(job(h).stage).toBe("NEEDS_ATTENTION");
    expect(job(h).lastError).toMatch(/could not fix check:test and changed nothing/);
    expect(job(h).lastError).toContain("I can't run pnpm install here");
    expect(job(h).lastError).toMatch(/Answer with what it should do/);
    expect(h.hist().filter((x) => x === "REMEDIATION:failed")).toHaveLength(1); // one run, not three retries into FAILED
  });

  it("an implementer that changes nothing twice stops for a person with what it said, instead of failing the job", async () => {
    const h = await harness();
    h.claude.b.implement = () => {};
    h.claude.b.implementResult = () => ({ summary: "I may not write .github/workflows/deploy.yml", tasksDone: [], tasksSkipped: [], deferred: [] });
    await settle(h, () => ["NEEDS_ATTENTION", "FAILED"].includes(job(h).stage));
    expect(job(h).stage).toBe("NEEDS_ATTENTION");
    expect(job(h).lastError).toMatch(/without changing any code\. It said: I may not write \.github\/workflows\/deploy\.yml/);
    expect(job(h).lastError).toMatch(/This happened twice/);
  });
});
