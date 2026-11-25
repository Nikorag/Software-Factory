# Operations

## Running it
```sh
pnpm factory serve                 # scheduler + dashboard/API on 127.0.0.1:4780 (foreground)
pnpm factory serve --no-scheduler  # dashboard and API only: polls nothing, runs nothing, spends no Claude quota
pnpm factory serve --dry-run       # discover and plan only; every mutating stage is skipped and recorded
pnpm factory dashboard --open      # opens the dashboard with the control token in the #fragment
pnpm factory work                  # one-off: run claimable jobs once in the foreground (no polling)
```
Only one service runs per data directory (`<dataDir>/factory.lock`; a stale lock from a crash is taken over). `SIGINT`/`SIGTERM` shut down gracefully: loops stop, running agents are told to stand down, and their jobs are **re-queued exactly where they were** (no attempt spent), so the next start resumes them.

## What the service does
Three independent loops, so a long job never starves polling or write-back:
- **worker**: claims and runs jobs one at a time (`maxConcurrentJobs`, default 1, because local resources are limited);
- **discovery**: every `pollIntervalSeconds` (default 60) polls Linear for eligible issues, creates jobs, then flushes the Linear write-back outbox. Failures back off up to 10 minutes and are shown on the dashboard; they never stop the worker;
- **validation**: at start and every 6 hours it clones any missing managed repositories and re-validates every enrolled project.
Pause and emergency stop are honoured by all three (write-back keeps flushing while paused: it only reflects state that already exists).

## Dashboard (http://127.0.0.1:4780)
Overview (state, counts, running/queued/finished jobs, this machine's memory/disk/load, scheduler and Linear backlog, dependency health), Jobs (filter by status/project), Job detail (20-stage progression with the held stage marked, full stage history, decisions, agent runs with a log viewer, artefacts, worktree, Linear write-back status, PR link), Projects (autonomy, Linear binding, which commands exist, validation, branch protection), Health. Everything shown is read from the persisted database and log files.
**Security model.** Loopback peers only; the `Host` header must be `127.0.0.1:<port>`/`localhost:<port>` (defeats DNS rebinding); a cross-site `Origin` is refused; **every mutating call needs the bearer token** in `<dataDir>/control-token` (mode 600). `pnpm factory dashboard` prints a URL carrying the token in the `#fragment`, which the browser never sends to the server and the page removes from the address bar. Reading needs no token. The page has a strict CSP (no inline script/style, no third-party origins), and everything derived from tickets, agents or logs is rendered as text only (tested with hostile data).

## Emergency stop and pause
- **Pause** (`pnpm factory pause` or the button): nothing new starts; running jobs finish their current stage and hold.
- **Emergency stop** (`pnpm factory stop`, the red button, or `POST /api/control/stop`): nothing new starts **and every running agent is terminated immediately** (process group killed); the jobs are held as `PAUSED`. Measured in tests: under 2 seconds with a 60-second heartbeat. The CLI commands talk to the running service so they act at once; with no service running they record the state for the next start.
- **Clear stop** does not resume work: the factory stays paused until you explicitly **resume**. Held jobs then re-queue automatically.
Every control action is recorded in `decisions` with its actor.

## LaunchAgent (start at login, restart on crash)
```sh
pnpm factory launchd:install          # writes ~/Library/LaunchAgents/com.software-factory.agent.plist
pnpm factory launchd:install --load   # ...and starts it now
pnpm factory launchd:status
pnpm factory launchd:uninstall
```
**Installing means it starts automatically at every login** (`RunAtLoad`) and then polls Linear and runs jobs by itself; keep it uninstalled until you are ready for that. It restarts only after a crash (a clean exit is not restarted), runs at low priority, logs to `<dataDir>/logs/launchd.*.log`, and contains **no secrets**: the Linear key is read from the macOS keychain (`security add-generic-password -a "$USER" -s software-factory-linear -w`; the service name is `linear.keychainService`), GitHub and Claude use their own stored logins. The first keychain read from the service may show a prompt: choose "Always Allow".

## Monitoring
`GET /api/overview` and the Health page show: Claude Code login, Linear and GitHub authentication, sandbox and Spec Kit availability (local model only if a route uses one), macOS memory pressure and free percentage, disk, load, job counts, the Linear outbox backlog, and **rate-limit/auth/timeout failures from the last hour** (Claude subscription limits are shared with your interactive use). Probes are read-only, cached for 5 minutes, and use no model tokens.

## Data layout (`~/.software-factory`)
`database/factory.sqlite` (all durable state; back this up), `projects/<id>` (factory-managed clones), `workspaces/<id>/<KEY>` (job worktrees; failed ones are preserved), `reports/<job>.md` (evidence reports), `jobs/<job>/` (sandbox profiles, the `factory-exec` wrapper), `logs/` (service, agents, commands, checks), `control-token`, `factory.lock`.

## Recovery
Crash, reboot or power loss: restart the service. Expired leases are detected, interrupted stage attempts are closed as interrupted, and the job is re-queued at its stage; handlers are idempotent, so completed work (commits, pushed branches, PRs, Linear writes) is never repeated. Linear or GitHub outages queue writes in the outbox and retry; the job keeps going.

## Workspaces, onboarding, verification
- `pnpm factory project:check <id>`: prove a project's commands work (throwaway worktree, real sandbox).
- `pnpm factory project:onboard <id> [--pr]`: add Spec Kit and a constitution on a local review branch; `--pr` pushes it and opens a PR (never merges).
- Worktrees: created from the freshly fetched default branch; the original checkout is never touched; `reconcile` reports drift without deleting; finished worktrees are removed after a human merge, failed ones are preserved.
- Live verification: `FACTORY_LIVE=1 pnpm vitest run tests/live` uses real Claude/Spec Kit (several minutes; subscription quota).

## Before you let it run unattended
1. `pnpm factory doctor` and the dashboard Health page are green; `pnpm factory linear:check` is clean.
2. Every project you intend to use has a **verified** test command (`project:check`) and has had its onboarding PR merged.
3. Start with `serve --dry-run`, then a single labelled ticket on a low-risk project while watching the dashboard.
4. Delivery is PR-only: nothing merges without you. Projects stay `autonomy: supervised`.
