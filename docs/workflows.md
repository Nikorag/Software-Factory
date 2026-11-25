# Workflows

Stage list: `STAGES` in `src/config/schema.ts`. Transitions, remediation routing and which stages mutate: `src/core/workflow.ts`.
Per-stage timeout/retry policy: `config/workflows.yaml` (falls back to `defaults`).

## Handler contract
A stage handler is `(ctx) => Promise<StageResult>` and **must be idempotent** (it may be replayed after a crash).
Results: `ok`, `remediate` (findings to fix), `retry` (transient), `blocked`, `needs_attention`, `fail`. A thrown error or timeout counts as `retry`.
`ctx.signal` aborts on timeout, cancellation, emergency stop or lease loss.

## Transitions
- Happy path follows `STAGES`. Clean reviews skip remediation (`SPECIFICATION_REVIEW`→`SPECIFICATION_VALIDATION`, `CLAUDE_REVIEW`→`FINAL_VALIDATION`).
- `remediate` from spec review/validation → `SPECIFICATION_REMEDIATION`; from testing/reviews/final validation/CI → `REMEDIATION` → `AUTOMATED_TESTING` (everything is re-verified).
- Each remediation increments `remediationAttempts`; beyond `maxRemediationAttempts` (default 3) the job goes to `NEEDS_ATTENTION`.
- Transient failures retry with exponential backoff (`notBefore`) up to the stage's `maxRetries`, then `FAILED`.
- Held states (`BLOCKED`, `FAILED`, `CANCELLED`, `PAUSED`, `NEEDS_ATTENTION`) remember `heldFromStage`; `job:retry` resumes there with fresh counters.
- A stage with no registered handler blocks the job. Production never falls back to simulated handlers.

## Durability
Each attempt writes a `stage_executions` row (`jobId:stage:attempt` unique) before running; outcome and the stage transition commit together.
Jobs are leased (`leaseOwner`/`leaseExpiresAt`, renewed by a heartbeat). `recoverExpired` re-queues jobs whose lease lapsed and closes their dangling attempts as interrupted.

## Dry run
`dryRun` on a job, or globally in `factory.yaml`: read-only stages run; mutating stages (spec generation/remediation, workspace prep, implementation, remediation, PR, merge, Linear completion) are skipped and recorded in `decisions`.

## Controls
`pause` stops new jobs; running jobs hold at the next stage boundary. `stop` (emergency) also aborts active agents; those jobs hold as `PAUSED`.
`clear-stop` does not resume; run `resume` afterwards. Jobs held as `PAUSED` re-queue automatically once the factory is running again.
CLI: `factory jobs | job:cancel | job:retry | pause | resume | stop | clear-stop | simulate [--dry-run]`.

## Where things happen (as built)
- The job worktree is created idempotently by the first stage that needs files (`REQUIREMENTS_ANALYSIS`), not at `IMPLEMENTATION_PREPARATION`, because specifications are committed on the job branch. `IMPLEMENTATION_PREPARATION` will verify cleanliness, install dependencies and run baseline checks.
- Handlers: every stage from `DISCOVERED` to `LINEAR_COMPLETION` (specification: M6, implementation: M7, delivery: M8). Every stage now has a handler. A stage without one would block with "no handler registered".
- `pnpm factory work` runs claimable jobs once with real agents. Production code never uses the simulated handlers.

## Implementation stages
| Stage | What happens |
|---|---|
| `IMPLEMENTATION_PREPARATION` | Requires a configured `commands.test` (else blocks: the factory will not implement or merge unverified work). Re-validates the spec. Optionally runs `commands.install` (the only step with network). Runs the project's checks as a **baseline** on the untouched default branch; if they already fail, blocks, because failures could not be attributed to the change. |
| `IMPLEMENTATION` | The implementer (Claude, `implementer` profile) runs Spec Kit's `implement` skill, verifying only through the sandboxed `factory-exec` tool and committing as it goes. The factory commits leftovers, scans history for secrets (stops for a human on a hit), then runs `converge`. If converge appended tasks, another pass resumes the **same session**; up to 3 passes, else `NEEDS_ATTENTION`. |
| `AUTOMATED_TESTING` | The factory itself runs build/typecheck/lint/test in the sandbox. Failures become findings (long logs condensed by Haiku) and go to remediation. |
| `LOCAL_MODEL_REVIEW` | Independent code review of the code-only diff by the `independent_review` route (Haiku). Security-sensitive changes (paths like auth/crypto/exec/sql, dependency manifests, workflows, or risky calls) also get a Claude `security-reviewer` pass. **Critical security findings stop for a human, never remediated**; high ones are remediated. |
| `CLAUDE_REVIEW` | Claude reviews the change and gives a verdict, with evidence, on each earlier finding (recorded as `code-review.verdict` decisions). |
| `REMEDIATION` | The implementer resumes its session with the latest blocking findings. It must reject invalid findings with evidence (recorded). The factory commits, re-scans for secrets, and the workflow re-runs `AUTOMATED_TESTING`, so a fix that breaks the build is caught by a real run. |
| `FINAL_VALIDATION` | Deterministic gates, independent of any reviewer: all checks re-run; clean tree; no protected-path changes; no secrets in history; no conflict markers; **no skipped/disabled tests and no deleted test files**; every task ticked; then the `final-reviewer` must show, for every FR/SC criterion, the code and a test that would fail without it. On success the factory writes an **evidence report** (checks, criteria with evidence, commits, rejected findings and reasons) to `<dataDir>/reports/<jobId>.md`, recorded as a `completion-report` artefact for the PR description. |
Remediation is capped at `maxRemediationAttempts` (3) across all of these. Dry-run jobs skip implementation and the stages that depend on it.

## Delivery stages: PR-only by decision
**The factory raises pull requests and never merges them.** This is configuration (`mergeMode: pr-only`, the only value the schema accepts) *and* structure: `GitHubClient` has no merge method, `src/delivery` contains no merge call, and a test asserts it. A human merges.
| Stage | What happens |
|---|---|
| `PULL_REQUEST_CREATION` | Pushes `factory/<KEY>` to `origin` (explicit `branch:branch` refspec, never forced, never the default branch, refused outside `factory/*`; HTTPS auth as the project's `github.account`) and opens a PR whose body is the **evidence report** plus a footer saying it is not auto-merged. Idempotent: a retry or post-remediation update reuses the open PR and pushes new commits. A closed/merged PR for the branch, or a non-fast-forward push (someone else changed the remote branch), stops for a human. Links the PR in Linear (`attachmentLinkGitHubPR`) and comments. |
| `CI_VALIDATION` | Polls the PR's checks. **Pending: waits** (no retries consumed; gives up after 60 min). **No checks at all** (a repo without PR CI, e.g. Zonto Kart): waits a 3-minute grace, records `ci.none`, carries on. **A failing GitHub Actions check** goes to `REMEDIATION` with its log tail (same agent session); the fix is re-verified locally, pushed, and CI re-runs. **A failing external check** (Vercel, another CI; seen on a real PR) cannot be read or fixed, so it is reported to the human in a Linear comment, never looped on. |
| `MERGE_VALIDATION` | Informational: mergeability, review decision, what branch protection requires. Merge conflicts or a closed PR stop for a human (the factory does not rewrite history). Posts "ready for human review" to Linear. |
| `MERGING` | **Does not merge.** Polls the PR every 10 minutes (`wait`, spending nothing) until a human merges it (continue), closes it (job `FAILED` with that reason, worktree kept), or 14 days pass (`NEEDS_ATTENTION`). |
| `LINEAR_COMPLETION` | After the human merge: comments in Linear, removes the finished worktree (local branch force-deleted: safe, the merge was just verified; the remote branch is left to GitHub's own setting) and the job completes, which moves the issue to Done. |
`wait` is a first-class stage result: it re-queues the job for later without failing and without spending the retry budget, so CI and human review can take as long as they take.
Linear status during delivery stays "Ready for review" (the unused "Merging" status is no longer required: the factory never merges).
