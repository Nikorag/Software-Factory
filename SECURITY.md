# Security

- Report vulnerabilities privately to the repository owner.
- Secrets: environment variables or the OS keychain only. Never commit `.env`. The config loader rejects secret-like keys.
- GitHub auth is delegated to `gh`; Claude auth to the logged-in `claude` CLI. The factory stores neither.
- The HTTP API binds to 127.0.0.1 and rejects non-loopback peers. Control endpoints (Milestone 9) will additionally require a local token.
- Agents run in per-issue worktrees and must not modify `config/`, `.env*` or key material (`protectedPaths`).
- Emergency stop halts new jobs immediately; active jobs are signalled to terminate safely.

## Agent execution: what is enforced and what is not
Enforced (tested, including live against the real CLI): per-role permission profiles; deny rules for push, fetch, branch switching, `gh`, network tools and protected paths; reads confined to the job worktree; secrets excluded from the agent environment (allowlist); prompts kept off command lines; process-tree kill on timeout/cancel; and a factory-side diff check after every run.

**Residual risks (known, not yet mitigated):**
1. **No OS-level sandbox.** Agents run as your macOS user. The commands we allow (the project's own test/lint scripts) execute arbitrary project code, with network access, so a malicious or prompt-injected change to a `package.json` script, then run, could do anything your user can. The factory's checks catch protected-path edits but cannot see what a test script does at runtime. Planned hardening: run agents and test commands under `sandbox-exec` or a dedicated low-privilege user, and run the project's tests from factory code (not the agent) after diffing scripts.
2. **Untrusted text.** Ticket bodies, comments and repository contents are attacker-influenceable. Role prompts tell agents to treat them as data, but prompts are not a security control; the permission profiles are.
3. **Subscription limits** are shared with your interactive Claude Code use. A burst of jobs can exhaust them; the adapter reports `rate_limited` and the engine retries with backoff.
4. The factory never merges unless GitHub itself enforces required checks (see `docs/integrations.md`); private repositories on a free GitHub plan cannot, so they stay supervised.
