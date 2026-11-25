# Using Bitbucket instead of GitHub (per project)

Each **project** chooses where its code is hosted (Settings → Projects → *Hosted on*), so one profile can have GitHub projects and Bitbucket projects side by side. Bitbucket Cloud only (Bitbucket Data Center / Server use different APIs and are not supported). The issue tracker (Linear or Jira) is a separate choice and works with either host.

## Credentials: a token, not OAuth

A Bitbucket project authenticates with a **token** you create and paste in once (Settings → Integrations → Bitbucket). It is stored in the macOS keychain, never in a file. We did not use OAuth: it would need an OAuth consumer, a callback URL on the profile's loopback port and refresh handling, and it grants the whole user's access. A token is simpler and can be limited to one repository.

Two kinds are supported (Atlassian documents both):

| Kind | Where you create it | Reaches | REST auth | Git user |
|---|---|---|---|---|
| **Access token** (recommended) | Repository (or, on Premium, project or workspace) → *Repository settings → Security → Access tokens* | just that repository (or project/workspace) | `Bearer` | `x-token-auth` |
| **API token** | Atlassian account → *Security → API tokens → Create with scopes → Bitbucket* | everything your account can reach, limited by the scopes you pick | Basic: account email + token | `x-bitbucket-api-token-auth` |

Permissions to give it: repositories **read and write** (clone, push the `factory/*` branch) and pull requests **read and write** (open the PR, read its state and CI, comment). Add repository **admin** only if you want the factory to read branch restrictions for the "protected branch" check (without it that check just says "unavailable"). Check the exact scope names in Atlassian's picker.

App passwords are not an option: Atlassian stopped creating them in September 2025 and disables existing ones in June 2026.

Access tokens expire (at most a year after creation) and API tokens can be given an expiry. When one expires, the dashboard shows the request that failed with "the token was rejected or has expired"; replace it in Settings and nothing else needs touching.

**Credentials are named** (`default`, `widgets-repo`, ...) and a project picks one, so a token scoped to one repository serves only that project. Each profile has its own set and its own keychain service.

## Setting up a project

1. Add a credential (Integrations → Bitbucket) and **Test access** from the project editor to confirm it can see the repository.
2. In the project's editor choose **Hosted on: Bitbucket**, enter `workspace/repository-slug`, and pick the credential. Everything else (commands, onboarding, Linear/Jira binding, Board) is the same as for GitHub.

## How it differs from GitHub

- **No `gh`.** The factory talks to Bitbucket's REST API directly; the GitHub CLI is only needed for GitHub projects (the installer treats it as a warning, not a requirement).
- **Pull requests:** opened as `factory/<ticket>` into the default branch with the same evidence report as the description. The source branch is never deleted by the factory. **It still never merges**: there is no merge call anywhere in the Bitbucket client, and a test checks it.
- **CI** is read from the PR's commit statuses (Bitbucket Pipelines and any other build reporting there). A failed Pipelines step's log is fetched, best effort, so the fix step can see why it failed.
- **Merge readiness:** Bitbucket's API has no single "mergeable" flag, so the factory reports it as unknown and does not block on it (conflicts show in Bitbucket's own PR page). Review state comes from the reviewers' approvals and requested changes.
- **Branch protection** is read from branch restrictions (push, force-push, delete, merge restrictions, required builds and approvals) and used for the same "full autonomy needs a protected branch" rule.
- **CI file detection** looks for `bitbucket-pipelines.yml`.

## Status

Built against Atlassian's documented Bitbucket Cloud 2.0 API and authentication (including the token kinds above) and tested against a stand-in server that models the endpoints. It has **not** yet been run against a live Bitbucket workspace. The parts most worth checking first: the git username for your token kind, the pull-request `statuses` endpoint, branch restrictions, and the Pipelines log lookup.
