# Changelog

Updates: `software-factory update` (add `--check` to only look). Releases are git tags named `v<major>.<minor>.<patch>`; the installer and `update` follow the newest one.

## Unreleased

- **Service lifecycle fixes.** Agent processes can no longer outlive the service: every process group is recorded under `<dataDir>/run/agents`, a shutdown waits for them (and SIGKILLs stragglers), a crash kills them, and leftovers from a killed service are reaped at the next start before any job is recovered. A second Ctrl-C/SIGTERM escalates instead of exiting mid-shutdown. The lock records the holder's start time, so a reused pid after a reboot no longer blocks the service (or its LaunchAgent) forever, and `shutdown` and the app's "Stop the Factory and Quit" never signal an unrelated process: they ask the service over its control API and boot out a loaded LaunchAgent so the stop sticks. The LaunchAgent runs at normal priority (no `Background` throttling of Claude and test suites), can be installed per profile, hands over cleanly from a `start`ed copy, and exits 0 instead of restart-looping when a healthy factory already runs. The menu bar app notifies you when a factory stops unexpectedly.

- **Bitbucket Cloud support** as an alternative to GitHub, chosen per project, with named token credentials (access tokens or Atlassian API tokens) in the keychain. See docs/bitbucket.md.

- **Jira support** (Jira Cloud, OAuth 2.0 3LO) as an alternative to Linear, chosen per profile. Statuses and labels are mapped to existing ones in Settings because Jira statuses cannot be created. See docs/jira.md.

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
