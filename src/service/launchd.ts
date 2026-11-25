import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBinary } from "../speckit/tools.js";

export const LABEL = "com.software-factory.agent";

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
 * their own stores. Low priority so it never makes the Mac sluggish.
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
${str("ProcessType", "Background")}
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

export interface InstallOptions { repoRoot?: string; configDir?: string; dataDir: string; home?: string; load?: boolean; run?: (file: string, args: string[]) => string }

const defaultRun = (f: string, a: string[]) => execFileSync(f, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repoRootOf = (r?: string) => r ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function buildPlist(o: Pick<InstallOptions, "repoRoot" | "configDir" | "dataDir" | "home">): string {
  const repoRoot = repoRootOf(o.repoRoot);
  return renderPlist({
    programArguments: serveCommand(repoRoot), workingDirectory: repoRoot,
    // FACTORY_CONFIG_DIR only when asked for: by default the service reads the user's own config (~/.software-factory/config), like the CLI does
    env: { PATH: servicePath(), HOME: o.home ?? homedir(), ...(o.configDir ? { FACTORY_CONFIG_DIR: o.configDir } : {}) },
    stdoutPath: join(o.dataDir, "logs", "launchd.out.log"), stderrPath: join(o.dataDir, "logs", "launchd.err.log"),
  });
}

/** Writes the plist. It is only *loaded* (started) when `load` is true: installing never silently starts autonomous work. */
export function installAgent(o: InstallOptions): { path: string; loaded: boolean } {
  const path = plistPath(o.home);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(o.dataDir, "logs"), { recursive: true });
  writeFileSync(path, buildPlist(o), { mode: 0o644 });
  chmodSync(path, 0o644);
  let loaded = false;
  if (o.load) {
    const run = o.run ?? defaultRun;
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try { run("/bin/launchctl", ["bootout", `${domain}/${LABEL}`]); } catch { /* not loaded yet */ }
    run("/bin/launchctl", ["bootstrap", domain, path]);
    loaded = true;
  }
  return { path, loaded };
}

/** Stops the LaunchAgent's service without removing it (`update` does this, then `refreshAgent` starts it again). */
export function stopAgent(o: { run?: InstallOptions["run"] } = {}): void {
  try { (o.run ?? defaultRun)("/bin/launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`]); } catch { /* not loaded */ }
}

const unesc = (s: string) => s.replace(/&quot;/g, "\"").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/**
 * Re-renders an installed LaunchAgent for the current code (same data dir and config dir as when it was installed), and loads it again when
 * `load` is set. Does nothing (installed: false) if none is installed, or if it belongs to another checkout of the factory. `update` calls it so the plist never keeps paths from an older install.
 */
export function refreshAgent(o: { home?: string; repoRoot?: string; load?: boolean; run?: InstallOptions["run"] } = {}): { installed: boolean; changed: boolean; loaded: boolean } {
  const path = plistPath(o.home);
  const field = ownPlist(o);
  if (!field) return { installed: false, changed: false, loaded: false };
  const out = field("StandardOutPath");
  if (!out) throw new Error(`${path} is not one this version understands: reinstall it with \`software-factory launchd:install\``);
  const opts = { repoRoot: o.repoRoot, home: o.home, dataDir: dirname(dirname(out)), configDir: field("FACTORY_CONFIG_DIR") };
  const changed = buildPlist(opts) !== readFileSync(path, "utf8");
  if (changed || o.load) installAgent({ ...opts, load: o.load, run: o.run });
  return { installed: true, changed, loaded: !!o.load };
}

/** Is the installed LaunchAgent this install's? (A development checkout must never stop or repoint the real one.) */
export const isOwnAgent = (o: { home?: string; repoRoot?: string } = {}): boolean => ownPlist(o) !== null;

function ownPlist(o: { home?: string; repoRoot?: string }): ((k: string) => string | undefined) | null {
  let xml: string;
  try { xml = readFileSync(plistPath(o.home), "utf8"); } catch { return null; }
  const field = (k: string) => { const m = new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(xml); return m ? unesc(m[1]!) : undefined; };
  return field("WorkingDirectory") === repoRootOf(o.repoRoot) ? field : null;
}

export function uninstallAgent(o: { home?: string; run?: InstallOptions["run"] } = {}): { removed: boolean } {
  const run = o.run ?? defaultRun;
  try { run("/bin/launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`]); } catch { /* not loaded */ }
  const path = plistPath(o.home);
  const had = existsSync(path);
  rmSync(path, { force: true });
  return { removed: had };
}

export function agentStatus(o: { home?: string; run?: InstallOptions["run"] } = {}): { installed: boolean; loaded: boolean; pid?: number; state?: string } {
  const installed = existsSync(plistPath(o.home));
  try {
    const out = (o.run ?? defaultRun)("/bin/launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
    return { installed, loaded: true, pid: Number(/\bpid = (\d+)/.exec(out)?.[1]) || undefined, state: /\bstate = (\w+)/.exec(out)?.[1] };
  } catch { return { installed, loaded: false }; }
}
