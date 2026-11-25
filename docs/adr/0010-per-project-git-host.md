# ADR 0010: The git host is chosen per project (GitHub or Bitbucket)

**Decision.** `ProjectConfig.host` is `github` (default) or `bitbucket`. A `Hosts` dispatcher (`src/host`) answers, per project: the repository slug, the clone URL, the git credentials, the pull-request client and the branch-protection reader. Every caller that used GitHub directly (clone, push, fetch, delivery, onboarding PR, validation) goes through it. GitHub keeps using the `gh` CLI as the project's account; Bitbucket uses a REST client (`src/bitbucket`) that implements the same pull-request interface, so the delivery stages are unchanged.

**Credentials: a token, not OAuth.** Named credentials (an access token or an Atlassian API token) live in a per-profile keychain service; a project names the one it uses. OAuth was rejected: it needs a registered consumer, a loopback callback and refresh handling, and grants the user's whole access, where a repository access token can be limited to one repository. App passwords are not an option (shut down by Atlassian).

**Invariants kept.** No merge operation exists in the Bitbucket client (a structural test covers it and the host module); only `factory/*` branches are pushed, never forced; the source branch is never auto-deleted; secrets reach only the child process environment.

**Consequences.** Adding another host means implementing the same four things. The `gh` CLI is now only required for GitHub projects.
