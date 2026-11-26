# Security

- Report vulnerabilities privately to the repository owner.
- Secrets: environment variables or the OS keychain only. Never commit `.env`. The config loader rejects secret-like keys.
- GitHub auth is delegated to `gh`; Claude auth to the logged-in `claude` CLI. The factory stores neither.
- The HTTP API binds to 127.0.0.1 and rejects non-loopback peers. Control endpoints will additionally require a local token.
- Agents run in per-issue worktrees and must not modify `config/`, `.env*` or key material (`protectedPaths`).
- Emergency stop halts new jobs immediately; active jobs are signalled to terminate safely.

## Agent execution: what is enforced and what is not
Enforced (tested, including live against the real CLI): per-role permission profiles; deny rules for push, fetch, branch switching, `gh`, network tools and protected paths; reads confined to the job worktree; path rules anchored to the absolute worktree path so a shell `cd` cannot move them; **writes confined to the worktree** (a bare `Write`/`Edit` allow permits writing anywhere the user can, which a live test caught: it is never granted; verified live for direct writes, shell redirection and `cp`); secrets excluded from the agent environment (allowlist); prompts kept off command lines; process-tree kill on timeout/cancel; and a factory-side diff check after every run.

**Project code execution (mitigated).** Project commands (install, build, test, lint, typecheck) run only through the factory, under macOS `sandbox-exec`: **no network** (loopback included; installs excepted), **writes only inside the worktree** and temp dirs, **no reading of file contents under `$HOME`** except the worktree and toolchain dirs (so `~/.ssh`, `~/.aws`, `~/.claude`, `~/.software-factory` and other repositories cannot be read or exfiltrated), and a scrubbed environment with no tokens. All of this is verified against the real sandbox in `tests/exec.test.ts`. The factory refuses to run project code unconfined unless `factory.sandbox.required: false`. Agents never run project commands directly: their only route is `factory-exec test|lint|typecheck|build`, a wrapper whose command text comes from the factory's own spec file (outside the worktree), so it cannot be used to run anything else.

**Residual risks (known, not yet mitigated):**
1. **The agent process itself (Claude Code) is not OS-sandboxed.** It needs the network to reach Anthropic and runs as your user. It is confined by permission rules instead (reads and writes limited to the worktree by absolute path; no shell commands except git and `factory-exec`; protected paths denied), each verified live, plus a factory-side diff check after every run. A flaw in Claude Code's own permission system would not be caught by the OS. Mitigation ideas: run the agent as a dedicated low-privilege user.
   - **`install` runs with network access** and executes package install scripts from the repository: the one place project code gets network. It is confined to writing the worktree and package caches and cannot read credentials, but a malicious dependency could still phone home with what it can see. Leave `commands.install` unset to disable it (the factory then expects dependencies to be vendored or pre-installed).
2. **Untrusted text.** Ticket bodies, comments and repository contents are attacker-influenceable. Role prompts tell agents to treat them as data, but prompts are not a security control; the permission profiles are.
3. **Subscription limits** are shared with your interactive Claude Code use. A burst of jobs can exhaust them; the adapter reports `rate_limited` and the engine retries with backoff.
4. The factory never merges unless GitHub itself enforces required checks (see `docs/integrations.md`); private repositories on a free GitHub plan cannot, so they stay supervised.

## Dependency scanning
Every push, pull request and a weekly schedule run [Syft](https://github.com/anchore/syft) to build an SBOM (CycloneDX, attached to the run as `sbom.cdx.json`) and [Grype](https://github.com/anchore/grype) to scan it for known vulnerabilities. High and Critical findings fail the `Security` workflow; results also appear in the repository's Security tab. This covers known CVEs in dependencies only: it is not an audit of this project's own code.

## Secrets
Every commit on a job branch is scanned for credentials (private keys, AWS/GitHub/Linear/Anthropic/Slack/Stripe/Google keys, JWTs, quoted credential assignments), across the **whole branch history**, not just the final diff. A hit stops the job for a human and never goes to automated remediation: a later commit cannot remove a secret from history, and history is what gets pushed. The finding never echoes the secret.

## Delivery
The factory cannot merge: delivery is PR-only by decision (`mergeMode: pr-only`), the GitHub client has no merge operation, and a test asserts that no merge capability exists in the client, the delivery handlers or the push helper. Pushes go through one function (`pushBranch`): explicit `factory/*` refspec, never forced, never the default branch; a non-fast-forward rejection stops for a human. Agents never push (their git `push`, `fetch`, `remote`, `config`, `gh`, curl and ssh are denied); the factory pushes, with the GitHub token held only in that one git process's environment. A PR for a branch that is already closed or merged is never reopened or replaced.

## Dashboard access (tokenless by design)

The dashboard accepts changes from its own page without a token (same-origin, loopback-only, `Host`/`Origin` checked), so a website you visit cannot drive it. Another process on your machine, or another user of a shared Mac, can send the same headers and so can pause the factory, answer held jobs and edit project commands (which run in the sandbox). Run it on a machine you alone use, or keep the token requirement by reverting ADR 0007. See [ADR 0007](docs/adr/0007-tokenless-dashboard.md).

## The installer

`install.sh` is meant to be piped to bash, so it is deliberately small and readable: no sudo, no credentials, no login item, wrapped in a function so a truncated download never runs, and `--dry-run` prints every action. Pin a release with `FACTORY_REF=<tag>` rather than `main`.
