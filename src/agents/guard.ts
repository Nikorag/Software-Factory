import picomatch from "picomatch";
import { git as realGit, type GitFn } from "../repo/git.js";

/**
 * Independent post-run check: whatever Claude Code's permission system did or did not stop, no protected
 * path may appear in the worktree's changes (committed since `baseRef`, staged, modified or untracked).
 */
export async function findProtectedChanges(worktree: string, baseRef: string, patterns: string[], git: GitFn = realGit): Promise<string[]> {
  const isProtected = picomatch(patterns, { dot: true, matchBase: false });
  const committed = await git(worktree, ["diff", "--name-only", "-z", `${baseRef}...HEAD`]).catch(() => "");
  const dirty = await git(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]).catch(() => "");
  const files = new Set<string>(committed.split("\0").filter(Boolean));
  const tokens = dirty.split("\0").filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!; // "XY path"; renames/copies are followed by an extra token holding the *old* path
    files.add(t.slice(3));
    if (/^[RC]/.test(t) || /^.[RC]/.test(t)) { const old = tokens[++i]; if (old) files.add(old); }
  }
  return [...files].filter((f) => isProtected(f)).sort();
}
