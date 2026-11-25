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
