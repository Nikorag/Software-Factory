# Architecture

## Shape
One Node.js process (the factory) owns orchestration. Claude Code, `git`, `gh`, SpecKit and the local model server
are external processes it launches and supervises. Single SQLite file (WAL) is the durable source of truth for
execution state; Linear remains the source of truth for tickets, GitHub for code.

```
Linear (poll) → scheduler → job state machine → stage handlers → adapters
                                  │                               ├─ ClaudeCodeAdapter (CLI subprocess)
                               SQLite (WAL)                       ├─ LocalModelAdapter (OpenAI-compatible HTTP)
                                  │                               ├─ GitHub (gh CLI)  ├─ Git worktrees
                            Fastify (127.0.0.1)                   └─ SpecKit (via Claude Code)
```

## Durability model
- `jobs.stage` is advanced only by a transaction that also appends to `stage_executions`.
- `stage_executions.idempotency_key` (`jobId:stage:attempt`) is unique, so a replayed step cannot double-record.
- A partial unique index allows at most one active job per (project, issue).
- `jobs.lease_*` supports crash recovery: an expired lease means the job can be safely resumed.
- `factory_state` holds global pause / emergency stop so they survive restarts.
- `decisions` records every autonomous decision with actor and rationale; `agent_invocations` records every agent run (logs on disk).

## Safety invariants (enforced in code, not prompts)
Loopback-only HTTP (bind and per-request check); no secrets in config; log redaction; protected paths list;
remediation cap (default 3). Later milestones enforce: no default-branch pushes, no force-push, no merge on red CI,
one agent per worktree.

## Decisions
See `docs/adr/`.
