# Changelog

Updates: `software-factory update` (add `--check` to only look). Releases are git tags named `v<major>.<minor>.<patch>`; the installer and `update` follow the newest one.

## Unreleased

- **Bitbucket Cloud support** as an alternative to GitHub, chosen per project, with named token credentials (access tokens or Atlassian API tokens) in the keychain. See docs/bitbucket.md.

- **Jira support** (Jira Cloud, OAuth 2.0 3LO) as an alternative to Linear, chosen per profile. Statuses and labels are mapped to existing ones in Settings because Jira statuses cannot be created. See docs/jira.md.

- **Dashboard reliability**:
  - Agent runs that were stopped by a signal (timeout, cancel, emergency stop), failed in the local model, or were cut short by a service restart no longer show "Watch live" forever. The API now returns an explicit `finished` flag, and the conversation view stops polling for those runs.
  - Polling no longer overlaps and cannot show stale data. Each request is aborted when a newer one starts and old responses are dropped. Polling pauses while the tab is hidden and backs off after errors.
  - "Connection lost — last updated Xs ago" appears whenever polling fails, and controls are disabled until the connection is back.
  - Double-clicking Retry, Answer or another action sends one request only.
  - Live tables keep their page when rows come and go.
  - The conversation view keeps retrying after a failed request, and moves past log lines over 1 MB.
  - A project with active jobs cannot be removed (409, with the reason shown in Settings).
  - Ticket links on the Board accept only http(s) URLs.
  - Archived jobs say that retrying restores them from the archive.
  - Human answers in the timeline show the answer rather than the list of questions.
  - The Health page has a Re-check button.

## 0.2.0

- **Manual mode and the Board**: choose tickets from a board of your Linear tickets (search by number, key or title) instead of labelling them; the mode is set per profile and can be overridden per project.
- Tickets of projects that are not fully onboarded are skipped, and each project shows an onboarding checklist.

- **Profiles**: separate, isolated factories (own projects, Linear, GitHub account, data, port) that run side by side; `software-factory profile add|list|remove`, a switcher in the app, and a default GitHub account per profile.
- **Desktop app**: `software-factory` starts every profile in the background, opens an Electron window and frees the terminal; `software-factory shutdown` stops it.
- **Watch Claude work**: every agent run's conversation, live, in the dashboard.
- **Settings**: concurrent jobs, fix-cycle limit and a model per workflow step, with per-project overrides; real job concurrency.
- **Installer** checks every requirement (Claude Code, Spec Kit, Python/uv, gh, both signed in) and stops before changing anything if one is missing.
- Update-available notice; agent log retention.

## 0.1.0

First release.
- Linear tickets become pull requests: Spec Kit specification, sandboxed implementation, independent and Claude reviews, a fix loop capped at 3, PR-only delivery (the factory never merges).
- Dashboard (React + shadcn/ui): live pipeline flow chart, controls, answer-and-resume for held jobs.
- Setup wizard and Settings UI: integrations, Linear key (keychain), projects and their commands, background clone/validate/check/onboard actions.
- `curl | bash` installer and `software-factory update`.
