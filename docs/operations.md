# Operations
`pnpm factory serve` runs the service. LaunchAgent, emergency stop UI and dashboard arrive in Milestone 9. Logs: `<dataDir>/logs/factory.log`; DB: `<dataDir>/database/factory.sqlite`.

## Workspaces
Layout: `<dataDir>/workspaces/<projectId>/<ISSUE-KEY>` on branch `factory/<ISSUE-KEY>`, created from `origin/<defaultBranch>` (fetched first; falls back to the local ref offline).
- **Isolation:** `WorktreeManager.create` only adds git metadata (a worktree entry and a branch) to the original repo; its working tree, HEAD and branch are never touched. Identifiers are validated (`[A-Za-z0-9_-]`), and paths must stay inside the workspaces root.
- **Ownership:** a worktree belongs to exactly one job (`worktrees.job_id`; path is unique). Creation is serialised per path and race-safe. A second job for the same issue is refused while the first worktree is `active` or `preserved`.
- **Crash recovery:** `create` is idempotent. It resumes a registered worktree untouched (uncommitted work survives), recreates one whose directory vanished, reuses a leftover branch, and refuses to adopt an unregistered directory.
- **Cleanup:** `remove` refuses (and preserves) dirty worktrees. It deletes the branch with `-d`; after a verified merge callers may pass `deleteBranch: "force"` (needed for squash merges). Failed jobs should call `preserve`.
- **Drift:** `reconcile(projectId)` reports DB rows with no directory (`missing`) and git worktrees with no row (`orphans`); it never deletes anything.
- **Submodules** are initialised recursively on creation.
