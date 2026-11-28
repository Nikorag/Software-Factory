import { execFileSync } from "node:child_process";
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
  it("with loopback enabled, a test can listen and connect on 127.0.0.1, but still cannot reach anything external", async () => {
    const w = world();
    const local = `node -e "const net=require('net');const s=net.createServer(c=>c.end('PONG')).listen(0,'127.0.0.1',()=>{net.connect(s.address().port,'127.0.0.1').on('data',d=>{console.log(String(d));s.close();process.exit(0)})}).on('error',e=>{console.log('TCP-BLOCKED '+e.code);process.exit(3)})"`;
    const r = await run(w, local, { sandbox: { home: w.home, loopback: true } });
    expect(r.tail).toContain("PONG");
    expect(r.ok).toBe(true);
    const ext = await run(w, `node -e "const s=require('net').connect(80,'93.184.216.34');s.setTimeout(3000,()=>{console.log('NET-TIMEOUT');process.exit(3)});s.on('connect',()=>{console.log('NET-OK');process.exit(0)}).on('error',e=>{console.log('NET-BLOCKED '+e.code);process.exit(3)})"`, { sandbox: { home: w.home, loopback: true } });
    expect(ext.tail).not.toContain("NET-OK");
  });
  it("lets a tool use a Unix-domain socket in the temp dir (tsx needs one) while TCP, even loopback, stays blocked", async () => {
    const w = world();
    const sock = `/tmp/factory-sbx-${process.pid}-${Date.now()}.sock`;
    const unix = `node -e "const net=require('net');const s=net.createServer(c=>c.end('PONG')).listen('${sock}',()=>{net.connect('${sock}').on('data',d=>{console.log(String(d));s.close();process.exit(0)})})"`;
    const r = await run(w, unix);
    expect(r.tail).toContain("PONG");
    expect(r.ok).toBe(true);
    const tcp = await run(w, `node -e "require('net').createServer().listen(0,'127.0.0.1',()=>{console.log('TCP-LISTEN-OK');process.exit(0)}).on('error',e=>{console.log('TCP-BLOCKED '+e.code);process.exit(3)})"`);
    expect(tcp.tail).toContain("TCP-BLOCKED");
  });
  it("git works inside a linked worktree whose repository lives under ~/.software-factory (a credential-store directory)", async () => {
    const w = world();
    const repo = join(w.home, ".software-factory", "projects", "app");
    mkdirSync(repo, { recursive: true });
    const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
    g(repo, "init", "-q", "-b", "main"); writeFileSync(join(repo, "f.txt"), "FROM-HEAD"); g(repo, "add", "."); g(repo, "commit", "-q", "-m", "init");
    const wt = join(w.home, ".software-factory", "workspaces", "app", "_check"); mkdirSync(join(wt, ".."), { recursive: true });
    g(repo, "worktree", "add", "-q", "--detach", wt);
    const common = realpathSync(join(repo, ".git"));
    const r = await run(w, "git show HEAD:f.txt", { worktree: wt, sandbox: { home: w.home, gitCommonDir: common } });
    expect(r.tail).toContain("FROM-HEAD");
    expect(r.ok).toBe(true);
    // ...but the rest of ~/.software-factory (other projects, the database) stays unreadable.
    mkdirSync(join(w.home, ".software-factory", "database"), { recursive: true }); writeFileSync(join(w.home, ".software-factory", "database", "factory.sqlite"), "DB-CANARY");
    const leak = await run(w, `cat ${w.home}/.software-factory/database/factory.sqlite`, { worktree: wt, sandbox: { home: w.home, gitCommonDir: common } });
    expect(leak.tail).not.toContain("DB-CANARY");
  });
  it("gives build tools a writable cache dir (TURBO_CACHE_DIR) but never lets a command rewrite its own sandbox profile", async () => {
    const w = world();
    const r = await run(w, `mkdir -p "$TURBO_CACHE_DIR" && echo cached > "$TURBO_CACHE_DIR/entry" && cat "$TURBO_CACHE_DIR/entry"`);
    expect(r.tail).toContain("cached");
    expect(r.ok).toBe(true);
    const tamper = await run(w, `echo '(allow default)' > ${w.profileDir}/sandbox-test.sb`);
    expect(tamper.ok).toBe(false);
    expect(tamper.tail).toMatch(/Operation not permitted|Permission denied/);
  });
  it("allows network only for install", async () => {
    const w = world();
    const r = await run(w, `node -e "require('http').get('http://127.0.0.1:${port}',r=>{console.log('NET-OK');process.exit(0)}).on('error',e=>{console.log('NET-BLOCKED');process.exit(3)})"`, { kind: "install" });
    expect(r.tail).toContain("NET-OK");
    expect(r.ok).toBe(true);
  });
  it("lets an INSTALL write package-manager caches (so `npm ci` can work) but never a test/lint/typecheck command (found by project:check: npm failed with EPERM)", async () => {
    const w = world();
    mkdirSync(join(w.home, ".npm"), { recursive: true });
    const cmd = `echo cached > ${w.home}/.npm/cache-entry && cat ${w.home}/.npm/cache-entry`;
    const inst = await run(w, cmd, { kind: "install" });
    expect(inst.tail).toContain("cached");
    expect(readFileSync(join(w.home, ".npm", "cache-entry"), "utf8")).toContain("cached");
    rmSync(join(w.home, ".npm", "cache-entry"));
    const test = await run(w, cmd, { kind: "test" });
    expect(test.tail).toMatch(/Operation not permitted/);
    expect(existsSync(join(w.home, ".npm", "cache-entry"))).toBe(false);
    // ...and even an install cannot write elsewhere under $HOME
    const stray = await run(w, `echo x > ${w.home}/elsewhere.txt`, { kind: "install" });
    expect(stray.tail).toMatch(/Operation not permitted/);
    expect(existsSync(join(w.home, "elsewhere.txt"))).toBe(false);
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

describe("visual check network policy (injected runner, no real sandbox or browser)", () => {
  const profileOf = async (loopback?: boolean) => {
    const dir = scratch();
    let args: string[] = [];
    const r = await runProjectCommand(
      { kind: "visual", command: "pnpm exec playwright test", worktree: dir, timeoutMs: 1000, profileDir: join(dir, "p"), sandbox: { home: dir, ...(loopback === undefined ? {} : { loopback }) } },
      { available: () => true, run: async (o) => { args = o.args; return { stdout: "", stderr: "", exitCode: 0, timedOut: false, cancelled: false, durationMs: 1 } as never; } },
    );
    expect(r).toMatchObject({ kind: "visual", ok: true });
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "pnpm exec playwright test"]);
    return readFileSync(join(dir, "p", "sandbox-visual.sb"), "utf8");
  };
  it("denies all network by default and allows loopback only when the project opts in, never external", async () => {
    const off = await profileOf();
    expect(off).toContain("(deny network*)");
    expect(off).not.toContain("localhost:*");
    const on = await profileOf(true);
    expect(on).toContain("(deny network*)");
    expect(on).toContain('(allow network-outbound (remote ip "localhost:*"))');
  });
});
