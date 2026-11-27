import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult } from "./commands.js";

/**
 * Dependencies follow the code. The configured install command runs once before implementing; when the implementer then adds a
 * package or a dependency, the manifests change and nothing would install it, so checks fail for a reason no code fix can cure
 * (live: a new workspace package with no node_modules, `test` exiting 126, three refused deferrals, a failed job).
 *
 * So before any check runs, the dependency manifests are fingerprinted; when they differ from the last successful install in this
 * worktree, the install command runs first. It is the project's own command from trusted config, in the same sandbox as always
 * (network for installs only, writes to the worktree and package caches, no credential reads).
 */

/** Files whose change means dependencies must be installed again. */
export const MANIFEST = /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc\.yml|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile|Pipfile\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile|Gemfile\.lock)$/;

/** Tracked and untracked (not ignored) manifests and their contents, as one hash. node_modules and the like are gitignored, so never read. */
export function manifestFingerprint(worktree: string, files?: string[]): string {
  const list = files ?? execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: worktree, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }).split("\0");
  const h = createHash("sha256");
  for (const f of [...new Set(list.filter((x) => x && MANIFEST.test(x)))].sort()) {
    h.update(f).update("\0");
    try { h.update(readFileSync(join(worktree, f))); } catch { h.update("<missing>"); } // deleted but still in the index
    h.update("\0");
  }
  return h.digest("hex");
}

const read = (state: string): string | null => { try { return (JSON.parse(readFileSync(state, "utf8")) as { fingerprint?: string }).fingerprint ?? null; } catch { return null; } };
export const recordInstalled = (state: string, fingerprint: string) => writeFileSync(state, JSON.stringify({ fingerprint, at: new Date().toISOString() }), { mode: 0o600 });

/**
 * Installs again when the manifests changed since the last successful install (or there is no record of one). Returns the install's
 * result when it ran, or null when nothing needed installing. A failed install is not recorded, so the next check tries again.
 */
export async function ensureDependencies(o: { worktree: string; install?: string; state: string; force?: boolean; run: (command: string) => Promise<CommandResult>; fingerprint?: (wt: string) => string }): Promise<CommandResult | null> {
  if (!o.install) return null;
  const fp = (o.fingerprint ?? manifestFingerprint)(o.worktree);
  if (!o.force && existsSync(o.state) && read(o.state) === fp) return null;
  const r = await o.run(o.install);
  if (r.ok) recordInstalled(o.state, fp);
  return r;
}
