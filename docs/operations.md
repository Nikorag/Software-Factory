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

## Factory-managed clones
A project with `github.repo` and no `repository` is cloned to `<dataDir>/projects/<id>` by `pnpm factory project:sync` and owned by the factory; your own checkouts are never used for these. `project:sync` is idempotent and refuses to touch a directory that is not a clone of the configured repo.
Network access (clone, fetch, later push) authenticates over HTTPS as the project's `github.account`: the token is read from `gh`'s keyring and handed to the single git process through `GIT_CONFIG_*` environment variables, so it is never in `ps` output, the repo's `.git/config`, the database or logs (verified after the first real clone). Clone origins are plain `https://github.com/<owner>/<repo>.git`.
Projects with an explicit `repository:` (e.g. `zonto-hub`) keep using that checkout as the *origin of worktrees*; its working tree is never touched.

## Live verification
`FACTORY_LIVE=1 pnpm vitest run tests/live` runs the real `claude` and `specify` (uses subscription quota; a full pipeline is about 4-6 minutes and ~9 agent calls). `tests/live/speckit.live.test.ts` takes a ticket through a validated, committed specification and writes a per-agent timing report (`FACTORY_LIVE_REPORT=<path>`). Last verified: 259 agent-seconds, one remediation cycle, Haiku for classification and review.
