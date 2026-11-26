# ADR 0009: One tracker interface, Linear or Jira per profile

**Decision.** The factory already talked to Linear through a small interface (`LinearClient`: list and read tickets, set a status, add or remove a label, comment, link a PR). Jira implements that same interface (`src/jira/client.ts`), so discovery, the Board, the outbox and every pipeline stage are unchanged. Which tracker a profile uses is `factory.tracker` (`linear` | `jira`); profiles are isolated factories (ADR 0008), so one can be on each.

**Concept mapping.** Linear team = Jira project (key); Linear project = Jira component; workflow state = status; label = label (a plain string, its id is its name).

**Names, not ids.** Everything above the client sees only status and label *names*. For Jira those names come from a user-made **mapping** (`jira.yaml`), exposed to the rest of the system as the same `config.linear` object the Linear config produces. An unmapped status or label is the empty string, and the outbox skips it rather than failing.

**Why a mapping and not creation.** Linear lets the factory create the statuses and labels it needs (with confirmation). Jira's statuses belong to admin-owned workflows, so the factory never creates them: it maps to existing ones and reports transitions that do not exist.

**Auth.** Jira uses an OAuth 2.0 (3LO) app the user creates. Tokens rotate, so refreshes are serialised and the new refresh token is persisted before use. Secrets live in a per-profile keychain service, never in config.

**Consequences.** Jira-specific code is confined to `src/jira/`, the OAuth and mapping routes, and a few tracker-aware UI labels. A third tracker would implement the same interface.

**Addendum: GitHub Issues.** The third tracker (`factory.tracker: github`, see `docs/github-issues.md`) is the "third tracker" this ADR anticipated. Repository = team, milestone = project, and because an issue is only open or closed, workflow statuses are prefixed labels (the factory creates them, like Linear; "Done" also closes the issue). It authenticates with the profile's `gh` login, so it needs no secret and no keychain entry; its code is confined to `src/github-issues/`, the mapping routes and the Settings component.
