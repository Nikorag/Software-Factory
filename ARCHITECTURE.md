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

## Hub reporting (optional, off by default)
`src/hub/` reports progress to a central hub only after `factory hub connect` (hub URL in `factory.hub`, API key in the keychain / `FACTORY_HUB_KEY`). A reporter pass inside the service (every 30s, errors never reach the engine) sends a heartbeat, a changed-only sync of projects/jobs/workflow names, and stage and decision events from a whitelist of metadata fields, with deterministic event ids (`stage_execution:<id>`, `decision:<id>`) and a durable cursor in `<dataDir>/hub-state.json`. Failures back off exponentially; a rejected key (401) stops reporting until a new one is connected. Separately, and only if `factory.hub.remoteAccess` is on, `src/hub/tunnel.ts` long-polls the hub for relayed dashboard requests and runs them in-process against this server (`inject()`), after `src/hub/remote-policy.ts`, a default-deny route allow-list covered by a test over every registered route, has approved them; changing requests are recorded as `hub-remote` decisions. See [Hub client](docs/hub-client.md).

## Durability model
- `jobs.stage` is advanced only by a transaction that also appends to `stage_executions`.
- `stage_executions.idempotency_key` (`jobId:stage:attempt`) is unique, so a replayed step cannot double-record.
- A partial unique index allows at most one active job per (project, issue).
- `jobs.lease_*` supports crash recovery: an expired lease means the job can be safely resumed.
- `factory_state` holds global pause / emergency stop so they survive restarts.
- `decisions` records every autonomous decision with actor and rationale; `agent_invocations` records every agent run (logs on disk).

## Safety invariants (enforced in code, not prompts)
Loopback-only HTTP with Host/Origin checks and a bearer token for controls; no secrets in config (keychain/env only); log redaction; protected paths enforced as permission denies and re-verified on every diff; project code sandboxed; no default-branch pushes, no force-push, **no merge capability at all** (PR-only); one agent per worktree; remediation capped at 3 per phase (spec, code, CI); secrets scanned across branch history; an emergency stop that terminates running agents immediately.

## Decisions
See `docs/adr/`.
