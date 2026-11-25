# Software Factory

A local-first, standalone TypeScript orchestrator that turns Linear tickets into merged GitHub pull requests,
using Claude Code as the engineering agent, GitHub SpecKit for specifications, and a local model (via Bionic)
for independent review. See [ARCHITECTURE.md](ARCHITECTURE.md).

**Status: Milestones 1–9 complete.** Config, logging, SQLite schema, doctor, loopback service skeleton, and the
durable job engine (state machine, retries, remediation cap, cancellation, crash recovery, dry-run, pause and
emergency stop), plus the project registry, read-only repository validation and isolated git worktrees, Linear discovery with a durable write-back outbox, the Claude Code and local-model adapters with enforced permission profiles, and the Spec Kit specification pipeline (ticket → reviewed, validated spec). Autonomous implementation (sandboxed checks, independent and Claude reviews, remediation loop, evidence report) is built. PR-only delivery (push, open the PR, watch CI, wait for a human to merge; the factory never merges) is built. The service (scheduler that polls Linear and runs jobs), the local dashboard with token-gated controls, an emergency stop that terminates agents immediately, health and resource monitoring, and a LaunchAgent are built: see docs/operations.md.
Try `pnpm factory simulate` (in-memory, no side effects).

## Quick start

```sh
npm install -g pnpm          # if pnpm is missing
pnpm install
pnpm factory doctor          # audit environment and integrations
pnpm factory config:check    # validate config/*.yaml
pnpm factory project:sync       # clone factory-managed repos (idempotent)
pnpm factory project:validate   # inspect enrolled repos (read-only)
pnpm factory linear:check       # verify LINEAR_API_KEY and configured statuses/labels (read-only)
pnpm factory project:onboard <id>   # add Spec Kit + constitution on a local review branch
pnpm factory project:check <id> # prove a project's test commands work (sandboxed, throwaway worktree)
pnpm factory work               # run claimable jobs once (real agents, uses your subscription)
pnpm factory serve           # scheduler + dashboard on 127.0.0.1:4780 (add --no-scheduler for dashboard only)
pnpm factory dashboard --open  # open the dashboard (carries the control token)
pnpm typecheck && pnpm lint && pnpm test
```

Runtime data (database, logs, workspaces) lives in `~/.software-factory` (`dataDir` in `config/factory.yaml`).
Secrets are environment variables only (`LINEAR_API_KEY`); config files containing secret-like keys are rejected.

## Layout

`src/config` schema + loader · `src/db` Drizzle schema, migrations in `drizzle/` · `src/logging` pino with redaction ·
`src/doctor` environment checks · `src/server` Fastify (loopback only) · `docs/` guides and ADRs.
