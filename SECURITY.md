# Security

- Report vulnerabilities privately to the repository owner.
- Secrets: environment variables or the OS keychain only. Never commit `.env`. The config loader rejects secret-like keys.
- GitHub auth is delegated to `gh`; Claude auth to the logged-in `claude` CLI. The factory stores neither.
- The HTTP API binds to 127.0.0.1 and rejects non-loopback peers. Control endpoints (Milestone 9) will additionally require a local token.
- Agents run in per-issue worktrees and must not modify `config/`, `.env*` or key material (`protectedPaths`).
- Emergency stop halts new jobs immediately; active jobs are signalled to terminate safely.
