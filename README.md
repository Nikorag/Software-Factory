# Software Factory

A local-first, standalone TypeScript orchestrator that turns Linear tickets into merged GitHub pull requests,
using Claude Code as the engineering agent, GitHub SpecKit for specifications, and a local model (via Bionic)
for independent review. See [ARCHITECTURE.md](ARCHITECTURE.md).

**Status: Milestones 1–4 complete.** Config, logging, SQLite schema, doctor, loopback service skeleton, and the
durable job engine (state machine, retries, remediation cap, cancellation, crash recovery, dry-run, pause and
emergency stop), plus the project registry, read-only repository validation and isolated git worktrees, and Linear discovery with a durable write-back outbox. Real stage handlers, integrations and the dashboard are not built yet.
Try `pnpm factory simulate` (in-memory, no side effects).

## Quick start

```sh
npm install -g pnpm          # if pnpm is missing
pnpm install
pnpm factory doctor          # audit environment and integrations
pnpm factory config:check    # validate config/*.yaml
pnpm factory project:validate   # inspect enrolled repos (read-only)
pnpm factory linear:check       # verify LINEAR_API_KEY and configured statuses/labels (read-only)
pnpm factory serve           # loopback service on 127.0.0.1:4780 (GET /health)
pnpm typecheck && pnpm lint && pnpm test
```

Runtime data (database, logs, workspaces) lives in `~/.software-factory` (`dataDir` in `config/factory.yaml`).
Secrets are environment variables only (`LINEAR_API_KEY`); config files containing secret-like keys are rejected.

## Layout

`src/config` schema + loader · `src/db` Drizzle schema, migrations in `drizzle/` · `src/logging` pino with redaction ·
`src/doctor` environment checks · `src/server` Fastify (loopback only) · `docs/` guides and ADRs.
