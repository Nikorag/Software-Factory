# Changelog

Updates: `software-factory update` (add `--check` to only look). Releases are git tags named `v<major>.<minor>.<patch>`; the installer and `update` follow the newest one.

## Unreleased

- **Engine robustness**:
  - Fix cycles are budgeted per phase. The specification, the code reviews and CI each get `maxRemediationAttempts`, so a hard spec can no longer use up the fixes the code needs (the counter used to be shared and never reset).
  - Stage timeouts can no longer cut a stage's own work short. Every workflow (feature, bugfix, maintenance) gets built-in per-stage timeouts derived from the agent timeouts, `commandTimeoutSeconds` and, for implementation, the configured number of passes. A shorter value in `workflows.yaml`, including an older copy in `~/.software-factory/config`, is raised to it.
  - After the Mac sleeps, the engine no longer re-queues jobs it is still running: it renews its own leases first and only recovers jobs nobody is running.
  - Cancelling a held job, then retrying it, resumes the real work instead of leaving a job stuck "running" in a held stage. Jobs already stuck that way are released when next claimed.
  - Retrying an archived job unarchives it. A retry records the error it clears and the job's lifetime fix cycles, and a later "fix cycles exhausted" stop says how many cycles and retries the job has had.
  - Cancel, emergency stop and timeouts wait (up to 15 s) for the agent to actually stop before the job is released, and the job is not run again until it has, so a quick retry cannot start a second agent in the same worktree.
- **Answering a held job's questions works end to end.** Answering a specification's open questions now runs the spec-writer with the questions and your answer (it used to skip remediation, leave the spec unchanged and block on the same questions again, or re-send already-fixed review findings). Answering in the ticket and retrying also goes through remediation once; if the questions are still unresolved the job blocks again instead of looping. Every answer is stored with the questions it answers and the stage that asked, and agents see question → answer pairs (the requirements analyst treats them as resolved).

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
