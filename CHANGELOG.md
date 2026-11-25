# Changelog

Updates: `software-factory update` (add `--check` to only look). Releases are git tags named `v<major>.<minor>.<patch>`; the installer and `update` follow the newest one.

## Unreleased

- **Bitbucket Cloud support** as an alternative to GitHub, chosen per project, with named token credentials (access tokens or Atlassian API tokens) in the keychain. See docs/bitbucket.md.

- **Jira support** (Jira Cloud, OAuth 2.0 3LO) as an alternative to Linear, chosen per profile. Statuses and labels are mapped to existing ones in Settings because Jira statuses cannot be created. See docs/jira.md.

- **Logs no longer grow without bound**: successful read requests (the dashboard's and menu bar app's polling) are logged at debug, not info; changes and non-2xx responses are still logged (paths only, no query strings), and server errors keep their stack. `factory.log`, `service.out` and the LaunchAgent's `launchd.out.log`/`launchd.err.log` are rotated by size (10 MB, 3 old copies kept) when the service starts and every 10 minutes. Project command logs (`logs/commands`) now follow `logRetentionDays` like agent logs.
- **Cheaper `/api/overview` and `/api/health`**: recent agent failures are counted in SQL over the last hour instead of loading the whole `agent_invocations` table; system info (which runs `memory_pressure`) is cached for 5 seconds.
- **Health probes**: overlapping checks share one in-flight probe; failures are re-checked after 30 seconds (successes after 5 minutes), so fixing e.g. `gh auth login` shows up quickly; an expired result is returned at once while one refresh runs behind it; `GET /api/health?refresh=1` re-probes now.
- **Menu bar app polls less**: every 5 s while jobs run or are queued, 10 s while idle with the window open, 30 s while idle with it closed (interruption checks: 10 s / 30 s / 60 s). The app menu reuses the tray's status instead of probing each profile again.

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
