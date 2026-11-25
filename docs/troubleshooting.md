# Troubleshooting
- `doctor` reports "no server reachable" for local models: only happens if a route uses `provider: local`. Either start Bionic's API server (and set the route's model id) or route that task to `anthropic`/`haiku`.
- `typescript-eslint does not support TS 7`: TypeScript is pinned to 5.9.x on purpose.
- `pnpm doctor` is a pnpm builtin; use `pnpm factory doctor`.
