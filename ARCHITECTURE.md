# Architecture

## Shape
One Node.js process (`factory serve`) owns orchestration. Claude Code, `git`, `gh`, Spec Kit and (optionally) a local model server are external processes it launches and supervises. A single SQLite file (WAL) is the durable source of truth for execution state; Linear remains the source of truth for tickets and GitHub for code.

```
 Linear ─poll─▶ discovery ─▶ jobs (SQLite) ◀─ worker loop ◀─ scheduler ◀─ LaunchAgent / CLI
   ▲                              │
   │ outbox (durable writes)      ▼
   └───────────────────  engine: persisted state machine (20 stages + held states)
                                  │ stage handlers
        intake · specification (Spec Kit) · implementation · delivery (PR-only)
                                  │
   agents: ClaudeCodeAgent (per-role permission profiles) · LocalModelClient (optional)
   project code: sandbox-exec (no network, worktree-only writes, no credential reads) via factory-exec
   git: isolated worktrees, one agent per worktree, guarded push (factory/* only, never forced)
                                  │
 Dashboard/API (127.0.0.1, token-gated controls) ◀── reads the same SQLite ── metrics/health probes
```
Layers: `src/core` (engine, jobs, control), `src/linear`, `src/repo`, `src/github`, `src/agents`, `src/speckit`, `src/implement`, `src/delivery`, `src/exec` (sandbox), `src/service` (scheduler, lock, secrets, metrics, launchd), `src/server` (API) + `web/` (React + shadcn/ui dashboard, built to `web/dist`), `src/app` (composition root).

## Workflow engine
Separate responsibilities: **definitions** (`src/workflows/definition.ts`: declarative stages, gates, routes) · **library** (`library.ts`: versioned, reusable) · **assignments + resolver** (`resolver.ts`: label → project → default) · **engine** (`src/core/engine.ts`: orchestration, persistence, retries, transitions, limits and the safety backstop) · **stage registry** (`stage-types.ts` metadata; `typed-handlers.ts` and the existing handlers do the work) · **gate evaluator** (`gates.ts`, pure and deterministic) · **model router** (`src/agents/router.ts`, refined, never bypassed, by a stage's model). A job runs the workflow snapshot frozen onto it at creation. See [Configurable workflows](docs/configurable-workflows.md).

## Durability model
- `jobs.stage` is advanced only by a transaction that also appends to `stage_executions`.
- `stage_executions.idempotency_key` (`jobId:stage:attempt`) is unique, so a replayed step cannot double-record.
- A partial unique index allows at most one active job per (project, issue).
- `jobs.workflow_snapshot_json` freezes the workflow a job runs; `stage_executions.gate_json` / `route_json` record each attempt's gate result and routing decision.
- `jobs.lease_*` supports crash recovery: an expired lease means the job can be safely resumed.
- `factory_state` holds global pause / emergency stop so they survive restarts.
- `decisions` records every autonomous decision with actor and rationale; `agent_invocations` records every agent run (logs on disk).

## Safety invariants (enforced in code, not prompts)
Loopback-only HTTP with Host/Origin checks and a bearer token for controls; no secrets in config (keychain/env only); log redaction; protected paths enforced as permission denies and re-verified on every diff; project code sandboxed; no default-branch pushes, no force-push, **no merge capability at all** (PR-only); one agent per worktree; remediation capped at 3 per phase (spec, code, CI) and never above 10 whatever a workflow says; mandatory safety stages (eligibility, independent/security review, final validation) enforced by the engine itself, not only by workflow validation; secrets scanned across branch history; an emergency stop that terminates running agents immediately.

## Decisions
See `docs/adr/`.
