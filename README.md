# Software Factory

A local-first, standalone TypeScript orchestrator that turns Linear tickets into merged GitHub pull requests,
using Claude Code as the engineering agent, GitHub SpecKit for specifications, and a local model (via Bionic)
for independent review. See [ARCHITECTURE.md](ARCHITECTURE.md).

**Status: Milestones 1–9 complete.** Config, logging, SQLite schema, doctor, loopback service skeleton, and the
durable job engine (state machine, retries, remediation cap, cancellation, crash recovery, dry-run, pause and
emergency stop), plus the project registry, read-only repository validation and isolated git worktrees, Linear discovery with a durable write-back outbox, the Claude Code and local-model adapters with enforced permission profiles, and the Spec Kit specification pipeline (ticket → reviewed, validated spec). Autonomous implementation (sandboxed checks, independent and Claude reviews, remediation loop, evidence report) is built. PR-only delivery (push, open the PR, watch CI, wait for a human to merge; the factory never merges) is built. The service (scheduler that polls Linear and runs jobs), the local dashboard with token-gated controls, an emergency stop that terminates agents immediately, health and resource monitoring, and a LaunchAgent are built: see docs/operations.md.
Try `pnpm factory simulate` (in-memory, no side effects).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Nikorag/Software-Factory/main/install.sh | bash
software-factory start      # starts the factory and opens the setup wizard in your browser
```

macOS only (project commands run inside `sandbox-exec`). Needs git and Node 22+; the installer adds pnpm if missing. It needs no sudo, asks for no credentials, installs no login item, and prints everything it will do first (`bash install.sh --dry-run`). Read it before piping it: `curl -fsSL <url> | less`.

The setup wizard checks Claude Code, GitHub (`gh`), Spec Kit and the sandbox, connects Linear (your key is verified, then stored in the macOS keychain), and adds your first project. **Settings** in the dashboard adds and edits projects, their test commands, and runs the clone, validate, check and Spec Kit onboarding steps. Your own settings live in `~/.software-factory/config`; the shipped defaults in `config/` are generic. Delivery is pull-request only: the factory never merges.

The dashboard needs no token: changes are accepted from the dashboard's own page (same origin) and, for the CLI and scripts, with the bearer token in `~/.software-factory/control-token`. See [ADR 0007](docs/adr/0007-tokenless-dashboard.md) for the trade-off.

## Quick start (from a checkout)

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
pnpm web:build              # build the dashboard (web/dist); required once before `serve`, and after UI changes
pnpm web:dev                # dashboard dev server on :5173, proxying the API of a running `serve`
pnpm typecheck && pnpm lint && pnpm test
```

Runtime data (database, logs, workspaces) lives in `~/.software-factory` (`dataDir` in `config/factory.yaml`).
Secrets are environment variables only (`LINEAR_API_KEY`); config files containing secret-like keys are rejected.

## Layout

`src/config` schema + loader · `src/db` Drizzle schema, migrations in `drizzle/` · `src/logging` pino with redaction ·
`src/doctor` environment checks · `src/server` Fastify (loopback only) · `web/` React + shadcn/ui dashboard · `docs/` guides and ADRs.
