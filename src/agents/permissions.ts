import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { PermissionProfile } from "./types.js";

export interface ToolPolicy { tools: string[]; allow: string[]; deny: string[] }

/**
 * Absolute spellings of the worktree root. Claude Code's shell keeps `cd` between calls, and relative path rules
 * resolve against the *current* directory, so after `cd specs/x` a rule `Edit(specs/**)` silently stops matching
 * (found live: it made spec edits "denied" whenever the agent had cd'd first). Rules therefore also carry absolute
 * forms, for the lexical and canonical path (macOS: /var vs /private/var, which Claude Code does not equate).
 */
export function pathRoots(cwd: string): string[] {
  const roots = new Set([resolve(cwd)]);
  try {
    const real = realpathSync(cwd);
    roots.add(real);
    if (/^\/private\/(var|tmp|etc)\//.test(real)) roots.add(real.slice("/private".length));
  } catch { /* cwd may not exist yet (tests): the lexical form is still emitted */ }
  return [...roots];
}
// `//path` means "absolute from the filesystem root" in Claude Code rules.
const absRule = (root: string, pattern: string) => `//${root.replace(/^\/+/, "")}/${pattern.replace(/^\/+/, "")}`;
const editRules = (patterns: string[], roots: string[]) => patterns.flatMap((p) => [`Edit(${p})`, ...roots.map((r) => `Edit(${absRule(r, p)})`)]);

// Verified against Claude Code 2.1.332 (see docs/integrations.md):
//  - a deny rule beats a broad allow;
//  - path scoping uses `Edit(<glob>)`, which governs both the Edit and Write tools;
//  - a bare `Write` / `Edit` allow is needed to enable those tools at all;
//  - `Bash(git:*)` allow plus `Bash(git push:*)` deny permits git but not push;
//  - NEVER allow bare `Write`/`Edit` either (they permit writes anywhere the user can write); scope with `Edit(//abs/root/**)`;
//  - NEVER allow bare `Read`/`Grep`/`Glob`: with no rule, Claude Code confines them to the working directory, but a
//    bare allow lets the agent read any file the user can (other projects, ~/.ssh, the factory database). Found by
//    live test; Bash read-only built-ins (cat, ls, grep) are likewise refused outside the working directory.
const GIT_READ = ["git status", "git diff", "git log", "git show", "git blame", "git ls-files", "git rev-parse"];
const GIT_WRITE = ["git add", "git commit", "git restore", "git rm", "git mv", "git stash"];
const ALWAYS_DENY_BASH = [
  "git push", "git remote", "git config", "git fetch", "git pull", "git clone", "git worktree", "git submodule",
  "git checkout", "git switch", "git branch", "git reset", "git rebase", "git merge", "git filter-branch", "git update-ref",
  "gh", "curl", "wget", "ssh", "scp", "rsync", "nc", "sudo", "su", "chmod", "chown", "launchctl", "security", "osascript",
  "rm -rf", "rm -fr", "npm publish", "pnpm publish", "yarn publish", "docker", "kubectl",
];
const SPECKIT_SCRIPTS = [".specify/scripts/bash/check-prerequisites.sh", ".specify/scripts/bash/resolve-template.sh", ".specify/scripts/bash/setup-plan.sh", ".specify/scripts/bash/setup-tasks.sh"];
const bash = (prefix: string) => `Bash(${prefix}:*)`;

export function toolPolicy(profile: PermissionProfile, opts: { protectedPaths?: string[]; bashAllow?: string[]; roots?: string[] } = {}): ToolPolicy {
  const protectedPaths = opts.protectedPaths ?? [];
  const roots = opts.roots ?? [];
  const readOnly = GIT_READ.map(bash); // file reads are allowed by default, confined to the worktree
  switch (profile) {
    case "read-only":
      return { tools: ["Read", "Grep", "Glob", "Bash"], allow: readOnly, deny: ["Edit", "Write", "NotebookEdit", ...ALWAYS_DENY_BASH.map(bash)] };
    case "spec-writer":
      // May create specification artefacts only: everything else is read-only. It runs SpecKit's helper scripts
      // but cannot edit them, the skills, or the templates (those are the instruction set it executes).
      return {
        tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
        allow: [...readOnly, ...editRules(["specs/**", ".specify/memory/**", ".specify/feature.json"], roots), ...SPECKIT_SCRIPTS.map(bash), bash("mkdir -p specs/")],
        deny: [...editRules(protectedPaths, roots), ...ALWAYS_DENY_BASH.map(bash)],
      };
    case "implementer":
      return {
        tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
        // NEVER a bare `Write`/`Edit`: that allows writing anywhere the user can (found live: an implementer wrote to
        // $HOME and to a sibling directory). Writes are scoped to the worktree by absolute path only.
        allow: [...readOnly, ...roots.map((r) => `Edit(${absRule(r, "**")})`), ...GIT_WRITE.map(bash), ...(opts.bashAllow ?? []).map(bash)],
        deny: [...editRules(protectedPaths, roots), ...ALWAYS_DENY_BASH.map(bash)],
      };
  }
}
