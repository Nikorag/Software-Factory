import type { PermissionProfile } from "./types.js";

export interface ToolPolicy { tools: string[]; allow: string[]; deny: string[] }

// Verified against Claude Code 2.1.332 (see docs/integrations.md):
//  - a deny rule beats a broad allow;
//  - path scoping uses `Edit(<glob>)`, which governs both the Edit and Write tools;
//  - a bare `Write` / `Edit` allow is needed to enable those tools at all;
//  - `Bash(git:*)` allow plus `Bash(git push:*)` deny permits git but not push;
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
const bash = (prefix: string) => `Bash(${prefix}:*)`;

export function toolPolicy(profile: PermissionProfile, opts: { protectedPaths?: string[]; bashAllow?: string[] } = {}): ToolPolicy {
  const protectedPaths = opts.protectedPaths ?? [];
  const readOnly = GIT_READ.map(bash); // file reads are allowed by default, confined to the worktree
  switch (profile) {
    case "read-only":
      return { tools: ["Read", "Grep", "Glob", "Bash"], allow: readOnly, deny: ["Edit", "Write", "NotebookEdit", ...ALWAYS_DENY_BASH.map(bash)] };
    case "spec-writer":
      // May create specification artefacts only: everything else is read-only.
      return {
        tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
        allow: [...readOnly, "Edit(specs/**)", "Edit(.specify/**)"],
        deny: [...protectedPaths.map((p) => `Edit(${p})`), ...ALWAYS_DENY_BASH.map(bash)],
      };
    case "implementer":
      return {
        tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
        allow: [...readOnly, "Write", "Edit", ...GIT_WRITE.map(bash), ...(opts.bashAllow ?? []).map(bash)],
        deny: [...protectedPaths.map((p) => `Edit(${p})`), ...ALWAYS_DENY_BASH.map(bash)],
      };
  }
}
