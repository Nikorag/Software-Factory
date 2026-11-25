import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * How to run `factory serve`: the install's own bin/factory, through /bin/sh. Nothing version-specific (a Node version, a Homebrew Cellar
 * path, a tsx path inside the pnpm store) is baked into the LaunchAgent or the desktop app: bin/factory resolves those every time, so an
 * update or a Node switch never leaves them pointing at something that is gone. (The TypeScript source always runs through tsx: a
 * compiled dist/ is not used, because the code finds package.json, migrations, config and the dashboard relative to the source tree.)
 */
export function serveCommand(repoRoot: string): string[] {
  return ["/bin/sh", join(repoRoot, "bin", "factory"), "serve"];
}

export interface InstallOptions {
  repoRoot?: string; configDir?: string; dataDir: string; home?: string; load?: boolean; run?: (file: string, args: string[]) => string;
  /** Which profile this LaunchAgent runs (default: the default profile), and the factory root the profiles live in. */
  profile?: string; root?: string;
}

const defaultRun = (f: string, a: string[]) => execFileSync(f, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repoRootOf = (r?: string) => r ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function buildPlist(o: Pick<InstallOptions, "repoRoot" | "configDir" | "dataDir" | "home" | "profile" | "root">): string {
  const repoRoot = repoRootOf(o.repoRoot);
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

export type AgentRef = { home?: string; run?: InstallOptions["run"]; profile?: string; repoRoot?: string };
const domain = () => `gui/${process.getuid?.() ?? 501}`;
const target = (profile?: string) => `${domain()}/${labelFor(profile)}`;
const unesc = (s: string) => s.replace(/&quot;/g, "\"").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/**
 * The installed plist for this profile, if it is this install's. Two checks, because the label is per profile name and so shared by
 * every install on the machine: WorkingDirectory is this checkout (a development checkout must never stop or repoint the real one),
 * and, when a data dir is given, the plist logs under it (another FACTORY_ROOT, e.g. a test, must not touch the real profile's).
 */
function ownPlist(o: AgentRef & { dataDir?: string }): ((k: string) => string | undefined) | null {
  let xml: string;
  try { xml = readFileSync(plistPath(o.home, labelFor(o.profile)), "utf8"); } catch { return null; }
  const field = (k: string) => { const m = new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(xml); return m ? unesc(m[1]!) : undefined; };
  if (field("WorkingDirectory") !== repoRootOf(o.repoRoot)) return null;
  if (o.dataDir && !(field("StandardOutPath") ?? "").startsWith(join(o.dataDir, "logs") + "/")) return null;
  return field;
}

/** Is the installed LaunchAgent (of this profile) this install's? */
export const isOwnAgent = (o: AgentRef & { dataDir?: string } = {}): boolean => ownPlist(o) !== null;

/**
 * This install's LaunchAgent for the factory whose data lives in `dataDir`: installed (see ownPlist), and loaded. What launchd has
 * loaded is checked too (its stdout path), in case the file was replaced by another install after it was loaded.
 */
export function agentServes(dataDir: string, o: AgentRef = {}): { installed: boolean; loaded: boolean } {
  const installed = isOwnAgent({ ...o, dataDir });
  if (!installed) return { installed, loaded: false };
  const s = agentStatus(o);
  return { installed, loaded: s.loaded && (!s.stdoutPath || s.stdoutPath.startsWith(join(dataDir, "logs") + "/")) };
}

export function uninstallAgent(o: AgentRef = {}): { removed: boolean } {
  stopAgent(o);
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
 * THE way to stop a LaunchAgent's service (used by `shutdown`, `update` and uninstall, through stopService where a profile is
 * involved): `bootout` unloads it, so launchd does not restart it however the process ends; a plain kill would not stick, because
 * KeepAlive restarts anything but a clean exit. The plist stays: it starts again at the next login, `start`, or after `update`.
 */
export function stopAgent(o: AgentRef = {}): boolean {
  try { (o.run ?? defaultRun)("/bin/launchctl", ["bootout", target(o.profile)]); return true; } catch { return false; }
}

/**
 * Starts an installed LaunchAgent from the plist as it is on disk now (`start` has just re-rendered it): unload it first if it is
 * loaded (it is only called when the service is not answering), then load it.
 */
export function startAgent(o: AgentRef = {}): void {
  const run = o.run ?? defaultRun;
  if (agentStatus(o).loaded) stopAgent(o);
  run("/bin/launchctl", ["bootstrap", domain(), plistPath(o.home, labelFor(o.profile))]);
}

/**
 * Re-renders an installed LaunchAgent for the current code (same profile, root, data dir and config dir as when it was installed),
 * and loads it again when `load` is set. Does nothing (installed: false) if this profile has none, or if it belongs to another install.
 * `start` and `update` call it so the plist never keeps paths from an older install.
 */
export function refreshAgent(o: AgentRef & { load?: boolean } = {}): { installed: boolean; changed: boolean; loaded: boolean } {
  const path = plistPath(o.home, labelFor(o.profile));
  const field = ownPlist(o);
  if (!field) return { installed: false, changed: false, loaded: false };
  const out = field("StandardOutPath");
  if (!out) throw new Error(`${path} is not one this version understands: reinstall it with \`software-factory launchd:install\``);
  const opts = { repoRoot: o.repoRoot, home: o.home, dataDir: dirname(dirname(out)), configDir: field("FACTORY_CONFIG_DIR"), root: field("FACTORY_ROOT"), profile: o.profile };
  const changed = buildPlist(opts) !== readFileSync(path, "utf8");
  if (changed || o.load) installAgent({ ...opts, load: o.load, run: o.run });
  return { installed: true, changed, loaded: !!o.load };
}
