import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeRepo, sh, tmp } from "./helpers/git-fixture.js";

const INSTALL = join(process.cwd(), "install.sh");
type Tool = string; // a tool name; its value is the stub's shell body
const stub = (dir: string, name: string, body = "exit 0") => { const f = join(dir, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); };

/** Runs `install.sh --check` with only the stubbed tools on PATH, in a throwaway HOME, so we see exactly what it says and that it changes nothing. */
function check(tools: Record<Tool, string | true>) {
  const bin = tmp(), home = tmp();
  for (const [n, body] of Object.entries(tools)) stub(bin, n, body === true ? "exit 0" : body);
  const r = spawnSync("/bin/bash", [INSTALL, "--check"], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FACTORY_HOME: join(home, "fh"), FACTORY_REF: "main" }, encoding: "utf8" });
  return { out: `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, ""), code: r.status, home, touched: readdirSync(home) };
}
const GOOD = {
  node: "case \"$1\" in -v) echo v22.1.0;; -p) echo 22;; esac", python3: "case \"$*\" in *version_info*) exit 0;; *platform*) echo 3.12.1;; *) echo 'Python 3.12.1';; esac",
  uv: true, specify: true, claude: "echo '{\"loggedIn\": true}'", gh: "exit 0", git: "exit 0",
} satisfies Record<string, string | true>;

describe.skipIf(process.platform !== "darwin")("install.sh preflight", () => {
  it("passes when everything is installed and signed in", () => {
    const r = check(GOOD);
    expect(r.code).toBe(0);
    expect(r.out).toContain("all requirements are in place");
    for (const x of ["macOS", "git", "Node.js", "Spec Kit", "Claude Code (signed in)", "GitHub CLI (signed in)"]) expect(r.out).toContain(`✓ ${x}`);
  });
  it("stops before changing anything and says exactly how to fix each missing tool", () => {
    const { claude: _c, specify: _s, ...rest } = GOOD; void _c; void _s;
    const r = check(rest);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("✗ Claude Code is not installed");
    expect(r.out).toMatch(/fix: curl -fsSL https:\/\/claude\.ai\/install\.sh/);
    expect(r.out).toContain("✗ Spec Kit ('specify') is not installed");
    expect(r.out).toContain("fix: uv tool install specify-cli");
    expect(r.out).toContain("2 requirement(s) missing. Nothing was installed or changed");
    expect(r.touched).toEqual([]); // not a single file created
  });
  it("catches tools that are installed but not signed in", () => {
    const r = check({ ...GOOD, claude: "echo '{\"loggedIn\": false}'" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("✗ Claude Code is installed but not signed in");
    expect(r.out).toContain("/login");
  });
  it("rejects an old Node", () => {
    const r = check({ ...GOOD, node: "case \"$1\" in -v) echo v18.0.0;; -p) echo 18;; esac" });
    expect(r.out).toContain("✗ Node.js 22 or newer is required (found v18.0.0)");
  });
  it("accepts an old system Python when uv is present (uv provides its own), and rejects it when it is not", () => {
    const old = "case \"$*\" in *version_info*) exit 1;; *) echo 'Python 3.9.6';; esac";
    expect(check({ ...GOOD, python3: old }).out).toContain("Python (uv provides 3.11+ for Spec Kit)");
    const { uv: _u, ...noUv } = GOOD; void _u;
    const r = check({ ...noUv, python3: old });
    expect(r.out).toContain("✗ Python 3.11 or newer is required for Spec Kit (found Python 3.9.6)");
    expect(r.out).toContain("✗ uv is not installed");
  });
  it("only warns about the GitHub CLI (Bitbucket projects do not need it), and still passes", () => {
    const { gh: _g, ...noGh } = GOOD; void _g;
    const missing = check(noGh);
    expect(missing.code).toBe(0);
    expect(missing.out).toContain("! GitHub CLI ('gh') is not installed (needed for GitHub projects; Bitbucket projects do not need it)");
    const signedOut = check({ ...GOOD, gh: "exit 1" });
    expect(signedOut.code).toBe(0);
    expect(signedOut.out).toContain("! GitHub CLI is installed but not signed in (needed for GitHub projects)");
    expect(signedOut.out).toContain("all requirements are in place");
  });
});

/** A real (local) install: real git against a local origin with a release tag; pnpm and the checked tools stubbed. */
describe.skipIf(process.platform !== "darwin")("install.sh download and re-run", () => {
  function setup() {
    const { origin, repo } = makeRepo({ "a.txt": "1\n", ".gitignore": "node_modules/\n" });
    sh(repo, "tag", "v0.1.0"); sh(repo, "push", "-q", "origin", "v0.1.0");
    writeFileSync(join(repo, "b.txt"), "2\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "b"); sh(repo, "push", "-q", "origin", "main");
    const bin = tmp(), home = tmp();
    const { git: _g, ...tools } = GOOD; void _g; // the real git
    for (const [n, body] of Object.entries({ ...tools, pnpm: "mkdir -p node_modules; exit 0" })) stub(bin, n, body === true ? "exit 0" : body);
    const install = (ref: string) => spawnSync("/bin/bash", [INSTALL], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FACTORY_HOME: join(home, "fh"), FACTORY_BIN: join(home, "bin"), FACTORY_REPO: origin, FACTORY_REF: ref }, encoding: "utf8" });
    return { install, app: join(home, "fh", "app"), home, bin };
  }

  it("a tag install can still see origin/main (so `update` and re-runs work), records the Node, and the launcher uses bin/factory", () => {
    const s = setup();
    const r = s.install("v0.1.0");
    expect(r.status, r.stderr).toBe(0);
    expect(sh(s.app, "describe", "--tags", "--exact-match")).toBe("v0.1.0");
    expect(sh(s.app, "config", "--get-all", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(sh(s.app, "rev-parse", "--verify", "origin/main")).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(s.app, "node_modules", ".factory-node"), "utf8").trim()).toBe(join(s.bin, "node"));
    expect(readFileSync(join(s.home, "bin", "software-factory"), "utf8")).toContain(`exec /bin/sh "${s.app}/bin/factory"`);
    const again = s.install("main"); // re-run, switching to main: the branch exists now
    expect(again.status, again.stderr).toBe(0);
    expect(sh(s.app, "ls-files")).toContain("b.txt");
  });

  it("a re-run refuses an install with local changes instead of carrying them along", () => {
    const s = setup();
    expect(s.install("v0.1.0").status).toBe(0);
    writeFileSync(join(s.app, "a.txt"), "edited\n");
    const r = s.install("main");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("has local changes");
    expect(sh(s.app, "describe", "--tags", "--exact-match")).toBe("v0.1.0"); // not moved
    expect(readFileSync(join(s.app, "a.txt"), "utf8")).toBe("edited\n");
  });
});
