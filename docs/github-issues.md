# GitHub Issues as the tracker

A profile can use **GitHub Issues** instead of Linear or Jira (`factory.yaml`: `tracker: github`, or Settings → Issue tracker). It implements the same tracker interface, so discovery, the Board, the outbox and every pipeline stage behave as they do on the other two.

## Sign-in

There is no app, key or OAuth flow. The tracker runs `gh api` as the profile's GitHub account (`factory.githubAccount`, or the active `gh` login), exactly as pull requests do. That account needs read and write access to **issues** in each linked repository. Nothing secret is stored in config.

## How GitHub's model maps

| Factory concept | GitHub |
| --- | --- |
| Team | Repository, `owner/name` (this is the project's "Issues repository") |
| Project | Milestone (optional; by title or number) |
| Ticket id | `owner/name#123` |
| Ticket key | `name-123` (safe as a branch and worktree name) |
| Label | Label (its id is its name; created on first use) |
| Workflow status | A label that starts with `statusPrefix` (default `status: `), e.g. `status: In progress` |
| Comment | Issue comment, carrying a hidden `software-factory-ref` id so a retry never posts twice |
| Link pull request | A comment linking the PR (once per PR; GitHub also cross-references it) |

An issue is only open or closed, so statuses are labels. The factory keeps **exactly one** status label on an issue. Moving to the *Done* status also **closes** the issue; moving to any other status **reopens** it. An open issue with no status label shows as "Open", a closed one as "Done". Pull requests are never treated as tickets.

## Configuration (`github-issues.yaml`)

```yaml
statusPrefix: "status: "
statuses: { readyForSpecification: Ready for specification, done: Done, ... }   # same keys as linear.yaml
labels:   { enabled: factory:enabled, blocked: factory:blocked, ... }
```

Rename any of them in Settings → Issue tracker → GitHub Issues. As with Linear, the factory can **create** the missing status and ordinary labels in each linked repository (it never edits or deletes anything); a status that was never created is reported as a permanent, explained failure rather than guessed.

## Differences worth knowing

- Settings only audits repositories that a project is linked to (an account can see hundreds); the rest just fill the repository picker.
- Board search accepts `123`, `#123` or `name-123`.
- Rate limits and 5xx errors are retried; 401/403 are reported as an auth failure ("run `gh auth login`").
- Switching tracker is refused while jobs are active, and projects must be re-linked afterwards, as for Jira (ADR 0009).
