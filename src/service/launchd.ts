import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBinary } from "../speckit/tools.js";

export const LABEL = "com.software-factory.agent";
/** One LaunchAgent per profile. The default profile keeps the original label, so an existing install is still recognised. */
export const labelFor = (profile = "default") => (profile === "default" ? LABEL : `${LABEL}.${profile}`);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface PlistOptions {
  label?: string;
  programArguments: string[];
  workingDirectory: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

/**
 * The LaunchAgent: starts the service at login and restarts it if it crashes (a clean exit, e.g. SIGTERM from `launchctl`,
 * is NOT restarted). It carries no secrets: the Linear key comes from the keychain, GitHub and Claude credentials from
 * their own stores. ProcessType Standard, not Background: Background throttles CPU and I/O for everything the service
 * starts (Claude, test suites, builds), which made jobs crawl; a mild Nice keeps the Mac responsive instead. ExitTimeOut
 * gives a stop time to let running agents stand down before launchd resorts to SIGKILL.
 */
export function renderPlist(o: PlistOptions): string {
  const str = (k: string, v: string) => `\t<key>${esc(k)}</key>\n\t<string>${esc(v)}</string>`;
  const env = Object.entries(o.env).map(([k, v]) => `\t\t<key>${esc(k)}</key>\n\t\t<string>${esc(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${str("Label", o.label ?? LABEL)}
\t<key>ProgramArguments</key>
\t<array>
${o.programArguments.map((a) => `\t\t<string>${esc(a)}</string>`).join("\n")}
\t</array>
${str("WorkingDirectory", o.workingDirectory)}
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>30</integer>
\t<key>ExitTimeOut</key>
\t<integer>45</integer>
${str("ProcessType", "Standard")}
\t<key>Nice</key>
\t<integer>5</integer>
${str("StandardOutPath", o.stdoutPath)}
${str("StandardErrorPath", o.stderrPath)}
</dict>
</plist>
`;
}

export const plistPath = (home = homedir(), label = LABEL) => join(home, "Library", "LaunchAgents", `${label}.plist`);

/** PATH for the service: a LaunchAgent starts with almost none, but needs node, git, gh, claude and specify. */
export function servicePath(extra: string[] = []): string {
  const dirs = new Set<string>([dirname(process.execPath), ...extra]);
  for (const b of ["claude", "gh", "git", "specify"]) { const f = findBinary(b); if (f) dirs.add(dirname(f)); }
  for (const d of [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) dirs.add(d);
  return [...dirs].join(":");
}

/** How to run `factory serve`: compiled JS if built, else the TypeScript source through tsx. Absolute paths throughout. */
export function serveCommand(repoRoot: string): string[] {
  const built = join(repoRoot, "dist", "src", "cli.js");
  if (existsSync(built)) return [process.execPath, built, "serve"];
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  return [process.execPath, "--import", tsx, join(repoRoot, "src", "cli.ts"), "serve"];
}

export interface InstallOptions {
  repoRoot?: string; configDir?: string; dataDir: string; home?: string; load?: boolean; run?: (file: string, args: string[]) => string;
  /** Which profile this LaunchAgent runs (default: the default profile), and the factory root the profiles live in. */
  profile?: string; root?: string;
}

const defaultRun = (f: string, a: string[]) => execFileSync(f, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function buildPlist(o: Pick<InstallOptions, "repoRoot" | "configDir" | "dataDir" | "home" | "profile" | "root">): string {
  const repoRoot = o.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const profile = o.profile ?? "default";
  return renderPlist({
    label: labelFor(profile),
    programArguments: serveCommand(repoRoot), workingDirectory: repoRoot,
    // FACTORY_CONFIG_DIR only when asked for: by default the service reads the user's own config (~/.software-factory/config), like the CLI does.
    // The profile is chosen through the environment (`serve` reads FACTORY_PROFILE), so the command line stays the same for every profile.
    env: {
      PATH: servicePath(), HOME: o.home ?? homedir(), ...(o.configDir ? { FACTORY_CONFIG_DIR: o.configDir } : {}),
      ...(o.root ? { FACTORY_ROOT: o.root } : {}), ...(profile !== "default" ? { FACTORY_PROFILE: profile } : {}),
    },
    stdoutPath: join(o.dataDir, "logs", "launchd.out.log"), stderrPath: join(o.dataDir, "logs", "launchd.err.log"),
  });
}

/** Writes the plist. It is only *loaded* (started) when `load` is true: installing never silently starts autonomous work. */
export function installAgent(o: InstallOptions): { path: string; loaded: boolean } {
  const label = labelFor(o.profile);
  const path = plistPath(o.home, label);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(o.dataDir, "logs"), { recursive: true });
  writeFileSync(path, buildPlist(o), { mode: 0o644 });
  chmodSync(path, 0o644);
  let loaded = false;
  if (o.load) {
    const run = o.run ?? defaultRun;
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try { run("/bin/launchctl", ["bootout", `${domain}/${label}`]); } catch { /* not loaded yet */ }
    run("/bin/launchctl", ["bootstrap", domain, path]);
    loaded = true;
  }
  return { path, loaded };
}

type AgentRef = { home?: string; run?: InstallOptions["run"]; profile?: string };
const target = (profile?: string) => `gui/${process.getuid?.() ?? 501}/${labelFor(profile)}`;

export function uninstallAgent(o: AgentRef = {}): { removed: boolean } {
  const run = o.run ?? defaultRun;
  try { run("/bin/launchctl", ["bootout", target(o.profile)]); } catch { /* not loaded */ }
  const path = plistPath(o.home, labelFor(o.profile));
  const had = existsSync(path);
  rmSync(path, { force: true });
  return { removed: had };
}

export function agentStatus(o: AgentRef = {}): { installed: boolean; loaded: boolean; pid?: number; state?: string; stdoutPath?: string } {
  const installed = existsSync(plistPath(o.home, labelFor(o.profile)));
  try {
    const out = (o.run ?? defaultRun)("/bin/launchctl", ["print", target(o.profile)]);
    return { installed, loaded: true, pid: Number(/\bpid = (\d+)/.exec(out)?.[1]) || undefined, state: /\bstate = (\w+)/.exec(out)?.[1], stdoutPath: /\bstdout path = (.+)/.exec(out)?.[1]?.trim() };
  } catch { return { installed, loaded: false }; }
}

/**
 * Stops a loaded LaunchAgent for good (until the next login, or until it is started again): `bootout` unloads it, so launchd
 * does not restart it, however the process ends. A plain kill would not stick: KeepAlive restarts it after anything but a clean exit.
 */
export function bootoutAgent(o: AgentRef = {}): boolean {
  try { (o.run ?? defaultRun)("/bin/launchctl", ["bootout", target(o.profile)]); return true; } catch { return false; }
}

/** Starts an installed LaunchAgent: load it if it is not loaded, else kick it (it may be waiting out its restart throttle). */
export function startAgent(o: AgentRef = {}): void {
  const run = o.run ?? defaultRun;
  if (agentStatus(o).loaded) run("/bin/launchctl", ["kickstart", target(o.profile)]);
  else run("/bin/launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, plistPath(o.home, labelFor(o.profile))]);
}

/**
 * Is this LaunchAgent the one for the factory whose data lives in `dataDir`? The label is per profile name, not per
 * install, so a second install (another FACTORY_ROOT, a test) must not stop or start the real one: the plist's log paths,
 * which are under the data dir, tell them apart.
 */
export function agentServes(dataDir: string, o: AgentRef = {}): { installed: boolean; loaded: boolean } {
  const logs = join(dataDir, "logs") + "/";
  let installed = false;
  try { installed = readFileSync(plistPath(o.home, labelFor(o.profile)), "utf8").includes(`<string>${esc(logs)}launchd.out.log</string>`); } catch { /* not installed */ }
  const s = agentStatus(o);
  return { installed, loaded: s.loaded && (s.stdoutPath ? s.stdoutPath.startsWith(logs) : installed) };
}
