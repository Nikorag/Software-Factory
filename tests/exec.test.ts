import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProjectCommand, SandboxUnavailable, tailOf, type RunCommandOptions } from "../src/exec/commands.js";
import { buildProfile, sandboxAvailable } from "../src/exec/sandbox.js";
import { tmp } from "./helpers/git-fixture.js";

// Fake homes live under the repo (NOT the system temp dir, which the sandbox deliberately lets commands write to).
const SCRATCH = join(process.cwd(), ".tmp-tests");
const made: string[] = [];
const scratch = () => { mkdirSync(SCRATCH, { recursive: true }); const d = realpathSync(mkdtempSync(join(SCRATCH, "w-"))); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const sb = describe.skipIf(!sandboxAvailable());

let server: ReturnType<typeof createServer>;
let port = 0;
beforeAll(async () => {
  server = createServer((_q, r) => r.end("reachable"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise((r) => server.close(r)));

/** A fake $HOME (so tests never touch the real one) containing a worktree, a secret, and another "project". */
function world() {
  const home = scratch();
  const wt = join(home, "work", "JAM-1");
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, "other-project"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_rsa"), "PRIVATE-KEY-CANARY");
  writeFileSync(join(home, "other-project", "secret.txt"), "OTHER-PROJECT-CANARY");
  writeFileSync(join(wt, "ok.txt"), "WORKTREE-OK");
  const outside = scratch();
  return { home, wt, outside, profileDir: join(home, ".profiles") };
}
const run = (w: ReturnType<typeof world>, command: string, over: Partial<RunCommandOptions> = {}) =>
  runProjectCommand({ kind: "test", command, worktree: w.wt, timeoutMs: 20_000, profileDir: w.profileDir, sandbox: { home: w.home }, ...over });

sb("sandboxed project commands (real sandbox-exec)", () => {
  it("runs commands in the worktree, can write there, and reports success", async () => {
    const w = world();
    const r = await run(w, `cat ok.txt && echo built > out.txt && node -e "console.log(process.version)"`);
    expect(r).toMatchObject({ ok: true, exitCode: 0, sandboxed: true });
    expect(r.tail).toContain("WORKTREE-OK");
    expect(readFileSync(join(w.wt, "out.txt"), "utf8")).toContain("built");
  });
  it("cannot write outside the worktree (home, sibling dirs) but may use temp dirs", async () => {
    const w = world();
    const r = await run(w, `echo x > ${w.home}/escaped.txt; echo x > ${w.outside}/escaped.txt; echo ok > ${join(w.home, "work", "sibling.txt")}; echo t > /tmp/factory-sb-ok-$$; echo done`);
    expect(r.tail).toContain("done");
    expect(existsSync(join(w.home, "escaped.txt"))).toBe(false);
    expect(existsSync(join(w.outside, "escaped.txt"))).toBe(false);
    expect(existsSync(join(w.home, "work", "sibling.txt"))).toBe(false);
    expect(r.tail).toMatch(/Operation not permitted/);
  });
  it("cannot read secrets or other projects under $HOME, but can read the worktree", async () => {
    const w = world();
    const r = await run(w, `cat ${w.home}/.ssh/id_rsa; cat ${w.home}/other-project/secret.txt; cat ok.txt`);
    expect(r.tail).not.toContain("PRIVATE-KEY-CANARY");
    expect(r.tail).not.toContain("OTHER-PROJECT-CANARY");
    expect(r.tail).toContain("WORKTREE-OK");
    expect(r.tail).toMatch(/Operation not permitted|Permission denied/);
  });
  it("blocks all network, including loopback, for test/lint/typecheck", async () => {
    const w = world();
    const probe = `node -e "require('http').get('http://127.0.0.1:${port}',r=>{console.log('NET-OK');process.exit(0)}).on('error',e=>{console.log('NET-BLOCKED '+e.code);process.exit(3)})"`;
    const r = await run(w, probe);
    expect(r.tail).toContain("NET-BLOCKED");
    expect(r.ok).toBe(false);
  });
  it("allows network only for install", async () => {
    const w = world();
    const r = await run(w, `node -e "require('http').get('http://127.0.0.1:${port}',r=>{console.log('NET-OK');process.exit(0)}).on('error',e=>{console.log('NET-BLOCKED');process.exit(3)})"`, { kind: "install" });
    expect(r.tail).toContain("NET-OK");
    expect(r.ok).toBe(true);
  });
  it("gives commands a scrubbed environment (no tokens, no API keys)", async () => {
    const w = world();
    process.env.LINEAR_API_KEY = "lin_secret"; process.env.GH_TOKEN = "gh_secret"; process.env.ANTHROPIC_API_KEY = "sk_secret";
    try {
      const r = await run(w, `node -e "console.log(JSON.stringify([process.env.LINEAR_API_KEY,process.env.GH_TOKEN,process.env.ANTHROPIC_API_KEY,process.env.CI]))"`);
      expect(r.tail.trim()).toBe('[null,null,null,"1"]');
    } finally { delete process.env.LINEAR_API_KEY; delete process.env.GH_TOKEN; delete process.env.ANTHROPIC_API_KEY; }
  });
  it("a failing command is reported with its output tail and exit code", async () => {
    const r = await run(world(), `echo "FAIL: 3 assertions" >&2; exit 7`);
    expect(r).toMatchObject({ ok: false, exitCode: 7, timedOut: false });
    expect(r.tail).toContain("FAIL: 3 assertions");
  });
  it("kills a hung command and its children on timeout, and on cancel", async () => {
    const w = world();
    const t = await run(w, `sleep 60 & sleep 60`, { timeoutMs: 800 });
    expect(t).toMatchObject({ ok: false, timedOut: true });
    const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
    const c = await run(w, `sleep 60`, { timeoutMs: 20_000, signal: ac.signal });
    expect(c).toMatchObject({ ok: false, cancelled: true });
  }, 30_000);
});

describe("sandbox policy", () => {
  it("refuses to run project code unconfined when sandboxing is required but unavailable", async () => {
    const w = { home: "/h", wt: tmp(), outside: "", profileDir: tmp() };
    await expect(runProjectCommand({ kind: "test", command: "true", worktree: w.wt, timeoutMs: 1000, profileDir: w.profileDir }, { available: () => false })).rejects.toBeInstanceOf(SandboxUnavailable);
  });
  it("may run unconfined only if explicitly allowed, and says so", async () => {
    const wt = tmp();
    const r = await runProjectCommand({ kind: "test", command: "echo hi", worktree: wt, timeoutMs: 5000, profileDir: tmp(), sandbox: { required: false } }, { available: () => false });
    expect(r).toMatchObject({ ok: true, sandboxed: false });
  });
  it("the profile denies network and writes by default, and credentials even if a toolchain dir covers them", () => {
    const p = buildProfile({ worktree: "/work/x", network: false, home: "/Users/u", readAllow: [".ssh"] });
    expect(p).toContain("(deny network*)");
    expect(p).toContain("(deny file-write*)");
    const lines = p.split("\n");
    const allowSsh = lines.findIndex((l) => l.includes('allow file-read-data') && l.includes("/Users/u/.ssh"));
    const denySsh = lines.map((l, i) => (l.startsWith("(deny file-read-data") && l.includes("/Users/u/.ssh") ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(denySsh).toBeGreaterThan(allowSsh); // the credential deny comes after (and wins over) the toolchain allow
    expect(buildProfile({ worktree: "/work/x", network: true })).not.toContain("(deny network*)");
  });
  it("tailOf keeps the end of long output", () => {
    expect(tailOf("a".repeat(10) + "END", 5)).toMatch(/omitted\]\naaEND$/);
    expect(tailOf("short", 100)).toBe("short");
  });
});
