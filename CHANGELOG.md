# Changelog

Updates: `software-factory update` (add `--check` to only look). Releases are git tags named `v<major>.<minor>.<patch>`; the installer and `update` follow the newest one.

## Unreleased

- **Safer updates.** `software-factory update` now refuses while jobs are running (`--wait` waits for them, `--force` goes ahead), stops every running profile and the LaunchAgent, backs up each profile's SQLite database (`VACUUM INTO`, newest 5 kept in `<data dir>/database/backups/`), and restarts what was running afterwards. If installing the new version fails it rolls back to the previous commit and reinstalls it; an interrupted update is finished by the next `update` instead of being reported as "up to date". The LaunchAgent is re-rendered for the new code.
- **No version-specific paths outside the install.** The launcher, the LaunchAgent and the app's "Start all profiles" go through `app/bin/factory`, which resolves Node and tsx each time, so a tsx bump or a Node switch no longer breaks them. "Start all profiles" now shows why starting failed instead of failing silently, and `start` exits non-zero when a profile does not start. Existing installs: re-run the installer once to get the new launcher (the old one keeps working).
- **Node switches**: the install records the Node its native SQLite module was built for and uses it; if that Node is gone, the module is rebuilt automatically for the one in use (and `update` checks it too).
- A compiled `dist/` is no longer preferred at runtime: the factory always runs its TypeScript source through tsx (the code finds `package.json`, migrations, config and the dashboard relative to the source tree, so `pnpm build` output broke startup).
- **Installer**: full clone (not a tag-only shallow clone), so `update` and re-runs can see `origin/main`; existing tag installs are repaired by `update` and by re-running the installer, which also refuses an install with local changes instead of carrying them along.

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
