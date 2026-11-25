import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** How to run `factory serve`: compiled JS if built, else the TypeScript source through tsx. Absolute paths throughout. */
export function serveCommand(repoRoot: string): string[] {
  const built = join(repoRoot, "dist", "src", "cli.js");
  if (existsSync(built)) return [process.execPath, built, "serve"];
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  return [process.execPath, "--import", tsx, join(repoRoot, "src", "cli.ts"), "serve"];
}

export interface InstallOptions { repoRoot?: string; configDir?: string; dataDir: string; home?: string; load?: boolean; run?: (file: string, args: string[]) => string }

const defaultRun = (f: string, a: string[]) => execFileSync(f, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function buildPlist(o: Pick<InstallOptions, "repoRoot" | "configDir" | "dataDir" | "home">): string {
  const repoRoot = o.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return renderPlist({
    programArguments: serveCommand(repoRoot), workingDirectory: repoRoot,
    env: { PATH: servicePath(), HOME: o.home ?? homedir(), FACTORY_CONFIG_DIR: o.configDir ?? join(repoRoot, "config") },
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
