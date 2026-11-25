import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/client.js";
import type { Profile } from "../src/config/profiles.js";
import { buildPlist, installAgent, isOwnAgent, plistPath, refreshAgent, renderPlist, serveCommand } from "../src/service/launchd.js";
import { isAbiMismatch, nodeRecordFile, recordNode, repairNativeModules, stableNodePath } from "../src/service/native.js";
import { backupDatabase, profileDbFile, runUpdate, UpdateRefused, type UpdateDeps } from "../src/service/update-run.js";
import type { UpdatePlan } from "../src/service/update.js";
import { tmp } from "./helpers/git-fixture.js";

const ROOT = process.cwd();

describe("a stable entry point (nothing version-specific in the LaunchAgent or the app)", () => {
  it("serveCommand goes through the install's bin/factory: no Node version, no pnpm store path, no dist/", () => {
    const cmd = serveCommand("/app");
    expect(cmd).toEqual(["/bin/sh", "/app/bin/factory", "serve"]);
    const xml = buildPlist({ repoRoot: "/app", dataDir: "/d", home: tmp() });
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)![1]!;
    expect(args).not.toContain(process.execPath);
    expect(args).not.toMatch(/\.pnpm|tsx@|Cellar|\.nvm|dist\//);
  });

  it("ignores a compiled dist/ (its paths would resolve inside dist/, where package.json, migrations and the dashboard are not)", () => {
    const app = tmp(); mkdirSync(join(app, "dist", "src"), { recursive: true }); writeFileSync(join(app, "dist", "src", "cli.js"), "");
    expect(serveCommand(app)).toEqual(["/bin/sh", join(app, "bin", "factory"), "serve"]);
  });

  /** A copy of bin/factory in a fake install whose "node" records how it was called. */
  function fakeInstall() {
    const app = tmp();
    mkdirSync(join(app, "bin")); copyFileSync(join(ROOT, "bin", "factory"), join(app, "bin", "factory"));
    mkdirSync(join(app, "node_modules", "tsx"), { recursive: true });
    const out = join(app, "called");
    const node = join(app, "fake-node");
    writeFileSync(node, `#!/bin/sh\ncase "$1" in -e) exit 0;; esac\necho "$@" > ${JSON.stringify(out)}\n`); chmodSync(node, 0o755);
    const sh = (env: Record<string, string> = {}) => spawnSync("/bin/sh", [join(app, "bin", "factory"), "--version"], { cwd: "/", encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: app, ...env } });
    return { app, node, out, sh };
  }

  it("bin/factory runs the CLI source through tsx with the recorded Node, from the install dir", () => {
    const f = fakeInstall();
    writeFileSync(join(f.app, "node_modules", ".factory-node"), `${f.node}\n`);
    expect(f.sh().status).toBe(0);
    expect(readFileSync(f.out, "utf8").trim()).toBe(`--import tsx ${join(f.app, "src", "cli.ts")} --version`);
  });

  it("bin/factory skips a recorded Node that is gone, and FACTORY_NODE wins over everything", () => {
    const f = fakeInstall();
    writeFileSync(join(f.app, "node_modules", ".factory-node"), "/nonexistent/v20.0.0/bin/node\n");
    const r = f.sh({ PATH: `${join(f.app)}:/usr/bin:/bin` }); // falls through to PATH: no `node` there, so the Homebrew locations, else a clear error
    if (r.status === 127) expect(r.stderr).toContain("no Node.js 22 or newer found");
    expect(f.sh({ FACTORY_NODE: f.node }).status).toBe(0);
    expect(readFileSync(f.out, "utf8")).toContain("--import tsx");
  });

  it("bin/factory says what to do when dependencies are missing", () => {
    const f = fakeInstall();
    spawnSync("rm", ["-rf", join(f.app, "node_modules", "tsx")]);
    const r = f.sh({ FACTORY_NODE: f.node });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dependencies are missing");
  });
});

describe("LaunchAgent refresh", () => {
  const stale = (home: string, repoRoot: string) => {
    const xml = renderPlist({
      programArguments: ["/Users/x/.nvm/versions/node/v26.13.1/bin/node", "--import", `file://${repoRoot}/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/esm/index.mjs`, `${repoRoot}/src/cli.ts`, "serve"],
      workingDirectory: repoRoot, env: { PATH: "/old", HOME: home, FACTORY_CONFIG_DIR: "/cfg & co" },
      stdoutPath: join(home, "data", "logs", "launchd.out.log"), stderrPath: join(home, "data", "logs", "launchd.err.log"),
    });
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath(home), xml);
  };

  it("re-renders an old plist for the current code, keeping its data dir and config dir, without starting it", () => {
    const home = tmp(); stale(home, "/app");
    const run = vi.fn(() => "");
    expect(refreshAgent({ home, repoRoot: "/app", run })).toEqual({ installed: true, changed: true, loaded: false });
    const xml = readFileSync(plistPath(home), "utf8");
    expect(xml).toBe(buildPlist({ home, repoRoot: "/app", dataDir: join(home, "data"), configDir: "/cfg & co" }));
    expect(xml).not.toContain("tsx@4.23.15");
    expect(run).not.toHaveBeenCalled();
    expect(refreshAgent({ home, repoRoot: "/app", run }).changed).toBe(false); // idempotent
  });

  it("loads it again when asked (after an update stopped it)", () => {
    const home = tmp(); installAgent({ home, repoRoot: "/app", dataDir: join(home, "data"), run: () => "" });
    const run = vi.fn((_f: string, _a: string[]) => "");
    expect(refreshAgent({ home, repoRoot: "/app", load: true, run }).loaded).toBe(true);
    expect(run.mock.calls.map((c) => c[1][0])).toEqual(["bootout", "bootstrap"]);
  });

  it("never touches a LaunchAgent that belongs to another checkout, or none at all", () => {
    const home = tmp();
    expect(refreshAgent({ home, repoRoot: "/app" }).installed).toBe(false);
    stale(home, "/real/install");
    const before = readFileSync(plistPath(home), "utf8");
    expect(isOwnAgent({ home, repoRoot: "/dev/checkout" })).toBe(false);
    expect(refreshAgent({ home, repoRoot: "/dev/checkout", load: true, run: () => { throw new Error("must not run"); } }).installed).toBe(false);
    expect(readFileSync(plistPath(home), "utf8")).toBe(before);
    expect(isOwnAgent({ home, repoRoot: "/real/install" })).toBe(true);
  });
});

describe("native module vs Node version", () => {
  const mismatch = new Error("The module '/x/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.");

  it("recognises an ABI mismatch and nothing else", () => {
    expect(isAbiMismatch(mismatch)).toBe(true);
    expect(isAbiMismatch(new Error("SQLITE_CANTOPEN"))).toBe(false);
  });

  it("at startup: rebuilds once for this Node, records it, and asks for a fresh process", () => {
    const root = tmp(); mkdirSync(join(root, "node_modules"));
    const rebuild = vi.fn();
    expect(repairNativeModules({ root, load: () => { throw mismatch; }, rebuild, log: () => {} })).toBe("rebuilt");
    expect(rebuild).toHaveBeenCalledWith(root);
    expect(readFileSync(nodeRecordFile(root), "utf8").trim()).toBe(stableNodePath());
    expect(repairNativeModules({ root, load: () => {}, rebuild })).toBe("ok");
    expect(repairNativeModules({ root, load: () => { throw new Error("something else"); }, rebuild })).toBe("ok"); // left for the real use to report
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("at startup: a failed rebuild says exactly how to fix it", () => {
    expect(() => repairNativeModules({ root: "/app", load: () => { throw mismatch; }, rebuild: () => { throw new Error("gyp ERR!"); }, log: () => {} }))
      .toThrow(/pnpm --dir "\/app" rebuild better-sqlite3/);
  });

  it("records a stable Homebrew symlink rather than the versioned Cellar path behind it", () => {
    const d = tmp();
    const cellar = join(d, "Cellar", "node", "26.1.0", "bin"); mkdirSync(cellar, { recursive: true });
    writeFileSync(join(cellar, "node"), ""); symlinkSync(join(cellar, "node"), join(d, "node"));
    expect(stableNodePath(join(cellar, "node"), [join(d, "missing"), join(d, "node")])).toBe(join(d, "node"));
    expect(stableNodePath("/somewhere/else/node", [join(d, "node")])).toBe("/somewhere/else/node");
    const root = tmp(); recordNode(root, "/n"); expect(existsSync(nodeRecordFile(root))).toBe(false); // no node_modules: nothing to describe
  });
});

describe("database backup before an update", () => {
  it("takes a consistent copy with VACUUM INTO and keeps the newest few", () => {
    const dir = tmp(), file = join(dir, "database", "factory.sqlite");
    const h = openDb(file);
    h.raw.exec("CREATE TABLE t (x); INSERT INTO t VALUES (42);");
    const first = backupDatabase(file, "abc1234", 2, new Date(1000))!;
    expect(first).toMatch(/backups\/factory-.*-abc1234\.sqlite$/);
    const copy = new Database(first, { readonly: true });
    expect(copy.prepare("SELECT x FROM t").get()).toEqual({ x: 42 });
    copy.close();
    backupDatabase(file, "b", 2, new Date(2000)); backupDatabase(file, "c", 2, new Date(3000));
    h.close();
    expect(readdirSync(join(dir, "database", "backups")).sort()).toEqual([expect.stringContaining("-b.sqlite"), expect.stringContaining("-c.sqlite")].sort());
    expect(backupDatabase(join(dir, "none.sqlite"), "x")).toBeNull();
  });

  it("finds each profile's database (its home, unless factory.yaml moves the data dir)", () => {
    const home = tmp();
    expect(profileDbFile({ name: "w", home, port: 1 })).toBe(join(home, "database", "factory.sqlite"));
    mkdirSync(join(home, "config")); writeFileSync(join(home, "config", "factory.yaml"), "dataDir: /elsewhere\n");
    expect(profileDbFile({ name: "w", home, port: 1 })).toBe("/elsewhere/database/factory.sqlite");
  });
});

describe("runUpdate: stop, back up, apply, restart", () => {
  const plan = { currentSha: "abcdef0123", targetSha: "f", behind: 1 } as UpdatePlan;
  const P = (name: string): Profile => ({ name, home: `/h/${name}`, port: 1 });

  function world(o: { up?: string[]; jobs?: number[]; agent?: boolean; apply?: () => Promise<void> } = {}) {
    const events: string[] = [];
    const jobs = [...(o.jobs ?? [0])];
    const d: UpdateDeps = {
      profiles: () => [P("default"), P("work"), P("idle")],
      isUp: async (p) => (o.up ?? ["default", "work"]).includes(p.name),
      runningJobs: async (p) => (p.name === "default" ? (jobs.length > 1 ? jobs.shift()! : jobs[0]!) : 0),
      stop: async (p) => { events.push(`stop ${p.name}`); },
      start: async (p) => { events.push(`start ${p.name}`); return { started: true }; },
      agent: { loaded: () => !!o.agent, stop: () => { events.push("agent stop"); }, refresh: (load) => { events.push(`agent refresh load=${load}`); return { installed: !!o.agent }; } },
      backup: async (p, tag) => { events.push(`backup ${p.name} ${tag}`); return null; },
      apply: async () => { events.push("apply"); await o.apply?.(); },
      sleep: async () => { events.push("sleep"); },
      log: () => {},
    };
    return { d, events };
  }

  it("stops everything that runs, backs up every profile, applies, then restarts exactly what ran", async () => {
    const { d, events } = world();
    expect(await runUpdate(plan, {}, d)).toEqual({ restarted: ["default", "work"] });
    expect(events).toEqual(["stop default", "stop work", "backup default abcdef0", "backup work abcdef0", "backup idle abcdef0", "apply", "agent refresh load=false", "start default", "start work"]);
  });

  it("hands the default profile back to the LaunchAgent (stopped with bootout, re-rendered and reloaded after)", async () => {
    const { d, events } = world({ agent: true, up: ["default"] });
    expect((await runUpdate(plan, {}, d)).restarted).toEqual(["default"]);
    expect(events[0]).toBe("agent stop");
    expect(events).toContain("agent refresh load=true");
    expect(events).not.toContain("start default");
  });

  it("restarts the services even when the update fails (they then run the rolled-back code)", async () => {
    const { d, events } = world({ apply: async () => { throw new Error("rolled back"); } });
    await expect(runUpdate(plan, {}, d)).rejects.toThrow("rolled back");
    expect(events.slice(-2)).toEqual(["start default", "start work"]);
  });

  it("refuses while jobs are running, changing nothing; --wait waits for them; --force goes ahead", async () => {
    const refused = world({ jobs: [2] });
    await expect(runUpdate(plan, {}, refused.d)).rejects.toBeInstanceOf(UpdateRefused);
    expect(refused.events).toEqual([]);

    const waited = world({ jobs: [2, 1, 0] });
    await runUpdate(plan, { wait: true }, waited.d);
    expect(waited.events.slice(0, 3)).toEqual(["sleep", "sleep", "stop default"]);

    const forced = world({ jobs: [2] });
    await runUpdate(plan, { force: true }, forced.d);
    expect(forced.events).toContain("apply");
  });

  it("a failed backup stops the update before any code changes, and the services come back", async () => {
    const { d, events } = world();
    d.backup = async () => { throw new Error("disk full"); };
    await expect(runUpdate(plan, {}, d)).rejects.toThrow("disk full");
    expect(events).not.toContain("apply");
    expect(events).toContain("start work");
  });
});
