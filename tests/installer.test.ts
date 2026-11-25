import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { tmp } from "./helpers/git-fixture.js";

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
    const { claude: _c, specify: _s, gh: _g, ...rest } = GOOD; void _c; void _s; void _g;
    const r = check(rest);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("✗ Claude Code is not installed");
    expect(r.out).toMatch(/fix: curl -fsSL https:\/\/claude\.ai\/install\.sh/);
    expect(r.out).toContain("✗ Spec Kit ('specify') is not installed");
    expect(r.out).toContain("fix: uv tool install specify-cli");
    expect(r.out).toContain("✗ GitHub CLI ('gh') is not installed");
    expect(r.out).toContain("brew install gh");
    expect(r.out).toContain("3 requirement(s) missing. Nothing was installed or changed");
    expect(r.touched).toEqual([]); // not a single file created
  });
  it("catches tools that are installed but not signed in", () => {
    const r = check({ ...GOOD, claude: "echo '{\"loggedIn\": false}'", gh: "exit 1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("✗ Claude Code is installed but not signed in");
    expect(r.out).toContain("/login");
    expect(r.out).toContain("✗ GitHub CLI is installed but not signed in");
    expect(r.out).toContain("fix: gh auth login");
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
});
