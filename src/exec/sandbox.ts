import { existsSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * macOS `sandbox-exec` profile for running *project code* (tests, lint, installs). Properties, each verified in
 * tests/exec.test.ts against the real sandbox:
 *  - no network unless explicitly allowed (installs only);
 *  - writes only inside the worktree, temp dirs and listed cache dirs;
 *  - file *contents* under $HOME are unreadable except the worktree and toolchain locations, so ~/.ssh, ~/.aws,
 *    ~/.claude, ~/.software-factory (database, other projects) and other repositories cannot be read or exfiltrated.
 * (Metadata reads stay allowed because path resolution needs them. This is defence in depth, not a VM.)
 */
export interface SandboxOptions {
  worktree: string;
  network: boolean;
  loopback?: boolean; // allow TCP to and from this machine only (127.0.0.1 / ::1), nothing external. Ignored when `network` is already on.
  home?: string;
  readAllow?: string[]; // extra dirs under $HOME that tools need (toolchains, caches)
  writeDirs?: string[]; // extra writable ABSOLUTE dirs (build-tool caches the factory points tools at)
  writeAllow?: string[]; // extra writable dirs (package-manager caches for installs)
  gitCommonDir?: string; // a linked worktree's shared .git: readable so `git` works inside tests
}

/** Toolchain locations under $HOME that node/pnpm/git/python typically read. Overridable in config. */
export const DEFAULT_READ_ALLOW = [".nvm", ".npm", ".cache", ".pnpm-store", ".local", ".volta", ".fnm", ".asdf", ".cargo", ".rustup", ".bun", ".gitconfig", ".config/git", "Library/pnpm", "Library/Caches", ".yarn", ".nodenv"];
export const DEFAULT_WRITE_ALLOW = [".npm", ".cache", ".pnpm-store", ".local/share/pnpm", "Library/pnpm", "Library/Caches", ".yarn"];

const q = (p: string) => JSON.stringify(p); // SBPL string literals use the same escapes as JSON for ordinary paths
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
/** Both spellings on macOS (/var and /private/var are the same place; sandbox rules match the resolved one). */
const spellings = (p: string): string[] => [...new Set([resolve(p), real(p)])];

export function buildProfile(o: SandboxOptions): string {
  const home = real(o.home ?? homedir());
  const wt = spellings(o.worktree);
  const sub = (paths: string[]) => paths.map((p) => `(subpath ${q(p)})`).join(" ");
  const underHome = (rels: string[]) => rels.flatMap((r) => spellings(join(home, r)));
  const readOk = [...wt, ...underHome(o.readAllow ?? DEFAULT_READ_ALLOW), ...(o.gitCommonDir ? spellings(o.gitCommonDir) : [])];
  const writeOk = [...wt, ...(o.writeAllow ? underHome(o.writeAllow) : []), ...(o.writeDirs ?? []).flatMap(spellings)];
  return [
    "(version 1)",
    "(allow default)",
    o.network ? "" : "(deny network*)",
    // Opt-in per project: tests that start a local server or database (PGlite, a mock API) need loopback TCP. Local services on this
    // machine become reachable from the test, but nothing outside it.
    ...(!o.network && o.loopback ? ['(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))'] : []),
    // Local Unix-domain sockets inside temp dirs stay usable (tsx, vite and similar tools talk to themselves over one). This is
    // not network access: TCP, including loopback, remains denied (tests/exec.test.ts). SBPL's unix-socket filter takes ONE
    // path, so there is one rule per directory (found by iterating against the real sandbox-exec).
    ...(o.network ? [] : ["/private/var/folders", "/private/tmp"].map((d) => `(allow network-bind network-inbound network-outbound (local unix-socket (subpath ${q(d)})) (remote unix-socket (subpath ${q(d)})))`)),
    "(deny file-write*)",
    `(allow file-write* ${sub([...writeOk, "/private/tmp", "/private/var/folders", "/tmp"])} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/(fd|ttys[0-9]+)"))`,
    // Deny reading contents under $HOME, then re-allow the worktree and toolchain dirs (later rules win).
    `(deny file-read-data ${sub([home])})`,
    `(allow file-read-data ${sub(readOk)})`,
    // Credential stores stay unreadable even if a toolchain entry above would have covered them.
    `(deny file-read-data ${sub([".ssh", ".aws", ".gnupg", ".claude", ".config/gh", ".software-factory", "Library/Keychains"].flatMap((r) => spellings(join(home, r))))})`,
    `(allow file-read-data ${sub(wt)})`, // the worktree is always readable even if it lives under .software-factory
    // A linked worktree's repository (its shared .git) is readable even when it lives under ~/.software-factory, which the rule above
    // denies: without this `git show HEAD:file` fails inside tests with "not a git repository". Only that one .git directory, not its parent.
    ...(o.gitCommonDir || o.writeDirs?.length ? [`(allow file-read-data ${sub([...(o.gitCommonDir ? spellings(o.gitCommonDir) : []), ...(o.writeDirs ?? []).flatMap(spellings)])})`] : []), // and the tool cache dirs it may write, so it can read its own cache back
  ].filter(Boolean).join("\n");
}

export const sandboxAvailable = (): boolean => process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

/** Writes the profile (mode 0600) and returns the argv prefix that runs a command inside it. */
export function sandboxPrefix(o: SandboxOptions, profilePath: string): string[] {
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, buildProfile(o), { mode: 0o600 });
  return ["/usr/bin/sandbox-exec", "-f", profilePath];
}
