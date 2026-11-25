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
- The job worktree is created idempotently by the first stage that needs files (`REQUIREMENTS_ANALYSIS`), not at `IMPLEMENTATION_PREPARATION`, because specifications are committed on the job branch. `IMPLEMENTATION_PREPARATION` (Milestone 7) will verify cleanliness, install dependencies and run baseline checks.
- Handlers that exist today: every stage from `DISCOVERED` through `FINAL_VALIDATION` (specification: Milestone 6, implementation: Milestone 7). A job that reaches a stage with no handler (`PULL_REQUEST_CREATION` onwards, Milestone 8) blocks with "no handler registered", which is the honest stop.
- `pnpm factory work` runs claimable jobs once with real agents. Production code never uses the simulated handlers.

## Implementation stages (Milestone 7)
| Stage | What happens |
|---|---|
| `IMPLEMENTATION_PREPARATION` | Requires a configured `commands.test` (else blocks: the factory will not implement or merge unverified work). Re-validates the spec. Optionally runs `commands.install` (the only step with network). Runs the project's checks as a **baseline** on the untouched default branch; if they already fail, blocks, because failures could not be attributed to the change. |
| `IMPLEMENTATION` | The implementer (Claude, `implementer` profile) runs Spec Kit's `implement` skill, verifying only through the sandboxed `factory-exec` tool and committing as it goes. The factory commits leftovers, scans history for secrets (stops for a human on a hit), then runs `converge`. If converge appended tasks, another pass resumes the **same session**; up to 3 passes, else `NEEDS_ATTENTION`. |
| `AUTOMATED_TESTING` | The factory itself runs build/typecheck/lint/test in the sandbox. Failures become findings (long logs condensed by Haiku) and go to remediation. |
| `LOCAL_MODEL_REVIEW` | Independent code review of the code-only diff by the `independent_review` route (Haiku). Security-sensitive changes (paths like auth/crypto/exec/sql, dependency manifests, workflows, or risky calls) also get a Claude `security-reviewer` pass. **Critical security findings stop for a human, never remediated**; high ones are remediated. |
| `CLAUDE_REVIEW` | Claude reviews the change and gives a verdict, with evidence, on each earlier finding (recorded as `code-review.verdict` decisions). |
| `REMEDIATION` | The implementer resumes its session with the latest blocking findings. It must reject invalid findings with evidence (recorded). The factory commits, re-scans for secrets, and the workflow re-runs `AUTOMATED_TESTING`, so a fix that breaks the build is caught by a real run. |
| `FINAL_VALIDATION` | Deterministic gates, independent of any reviewer: all checks re-run; clean tree; no protected-path changes; no secrets in history; no conflict markers; **no skipped/disabled tests and no deleted test files**; every task ticked; then the `final-reviewer` must show, for every FR/SC criterion, the code and a test that would fail without it. On success the factory writes an **evidence report** (checks, criteria with evidence, commits, rejected findings and reasons) to `<dataDir>/reports/<jobId>.md`, recorded as a `completion-report` artefact for the PR description (Milestone 8). |
Remediation is capped at `maxRemediationAttempts` (3) across all of these. Dry-run jobs skip implementation and the stages that depend on it.
