# Troubleshooting
- `doctor` reports "no server reachable" for local models: only happens if a route uses `provider: local`. Either start Bionic's API server (and set the route's model id) or route that task to `anthropic`/`haiku`.
- `typescript-eslint does not support TS 7`: TypeScript is pinned to 5.9.x on purpose.
- `pnpm doctor` is a pnpm builtin; use `pnpm factory doctor`.
- **`npm ci` fails with EPERM on `~/.npm`** (or a tool says "operation not permitted"): the sandbox denied a write. Installs may write package caches; other commands may write only the worktree and temp dirs. Run `pnpm factory project:check <id>` and read `<dataDir>/logs/check/<id>/<step>.log`. If a legitimate tool needs another directory, add it to `factory.sandbox.writeAllow`/`readAllow`.
- **`tsx` fails with `listen EPERM …pipe`:** fixed (Unix sockets in temp dirs are allowed); update to the latest factory.
- **"another factory service is already running":** a service holds `<dataDir>/factory.lock`. Stop it (`launchctl bootout …` or `kill <pid>`); a lock from a crashed process is taken over automatically.
- **Linear says unauthorised under the LaunchAgent:** the service has no shell environment: create the keychain entry (`security add-generic-password -a "$USER" -s software-factory-linear -w`) and click "Always Allow" on the first prompt.
- **A project job blocks immediately:** read the dashboard job's last error: typically no `commands.test`, the baseline checks failing on the default branch, or Spec Kit not onboarded (merge the onboarding PR).
- **Dashboard controls are disabled:** open it with `pnpm factory dashboard --open` so the token reaches the page.
