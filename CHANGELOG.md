# Changelog

Updates: `software-factory update` (add `--check` to only look). Releases are git tags named `v<major>.<minor>.<patch>`; the installer and `update` follow the newest one.

## Unreleased

- **One "Peek" button per step, with a tab per agent session.** A step with many agent runs (16 for a long Implement) showed a button for every run. It is now a single "Peek · 16 sessions" ("Watch live" while one is running) that opens the session window with a tab for each run (arrow keys move between them; the latest, or a live one, opens first). The window's close button now sits in its title bar, and a "Wrap lines" tick box (on by default, remembered) removes the need to scroll sideways.
- **Long lists of a step's events are folded** ("Show 14 details"). Decisions made after a "You retried" entry were all being attached to it, which is what produced the wall of text under it; they now go to the step that was running. `human.deferred` reads "Left for you".
- **The live/conversation window looks like a Claude Code session.** Dark terminal styling, the prompt as a highlighted block, `⏺` messages and `Read(path)` / `Bash(command)` tool calls with their result on a `⎿` line (first line shown, "… +N lines" to expand), a "✻ Working… (3m 05s · ↓ 48k tokens)" line while a run is live, and a powerline status bar like Claude Code's: ticket, agent role, worktree path, branch, model, tool calls, context used / left (estimated against a 200k window, 1M for `[1m]` models) and elapsed time. The conversation API now also returns the run's `cwd`, start time and duration, and the transcript carries each model call's prompt size.
- **Deleting a job can remove its worktree too.** A job whose worktree is still on disk used to be undeletable ("its worktree ... still exists"). The delete dialog now shows the worktree and offers to delete it with the job (ticked by default). Uncommitted changes in it are never thrown away silently: the first attempt is refused, and a second, explicit "Discard changes and delete" is needed. The local branch goes with it when a PR was raised (it is safe on the remote) or git says it is merged; an unmerged, never-pushed branch is kept. API: `DELETE /api/jobs/:id?removeWorktree=1[&discardChanges=1]`.
- **Friendly stage names everywhere.** Stage ids like `LOCAL_MODEL_REVIEW` no longer show in the dashboard: the jobs list, progress strip, board, job page, history, decisions and timeline use the flow chart's names ("Independent review", "Fix findings", "Needs attention"), including inside error and decision messages. The ids stay in the API, database and logs.
- **Flow chart:** the status spinner/tick no longer overlaps a long step title ("Independent review"); it now sits on the bottom-right corner of the box, and titles that are too long for the box are squeezed to fit.
- **Service lifecycle fixes.** Agent processes can no longer outlive the service: every process group is recorded under `<dataDir>/run/agents`, a shutdown waits for them (and SIGKILLs stragglers), a crash kills them, and leftovers from a killed service are reaped at the next start before any job is recovered. A second Ctrl-C/SIGTERM escalates instead of exiting mid-shutdown. The lock records the holder's start time, so a reused pid after a reboot no longer blocks the service (or its LaunchAgent) forever, and `shutdown` and the app's "Stop the Factory and Quit" never signal an unrelated process: they ask the service over its control API and boot out a loaded LaunchAgent so the stop sticks. The LaunchAgent runs at normal priority (no `Background` throttling of Claude and test suites), can be installed per profile, hands over cleanly from a `start`ed copy, and exits 0 instead of restart-looping when a healthy factory already runs. The menu bar app notifies you when a factory stops unexpectedly.
- **Safer updates.** `software-factory update` now refuses while jobs are running (`--wait` waits for them, `--force` goes ahead), stops every running profile and the LaunchAgent, backs up each profile's SQLite database (`VACUUM INTO`, newest 5 kept in `<data dir>/database/backups/`), and restarts what was running afterwards. If installing the new version fails it rolls back to the previous commit and reinstalls it; an interrupted update is finished by the next `update` instead of being reported as "up to date". The LaunchAgent is re-rendered for the new code.
- **No version-specific paths outside the install.** The launcher, the LaunchAgent and the app's "Start all profiles" go through `app/bin/factory`, which resolves Node and tsx each time, so a tsx bump or a Node switch no longer breaks them. "Start all profiles" now shows why starting failed instead of failing silently, and `start` exits non-zero when a profile does not start. Existing installs: re-run the installer once to get the new launcher (the old one keeps working).
- **Node switches**: the install records the Node its native SQLite module was built for and uses it; if that Node is gone, the module is rebuilt automatically for the one in use (and `update` checks it too).
- A compiled `dist/` is no longer preferred at runtime: the factory always runs its TypeScript source through tsx (the code finds `package.json`, migrations, config and the dashboard relative to the source tree, so `pnpm build` output broke startup).
- **Installer**: full clone (not a tag-only shallow clone), so `update` and re-runs can see `origin/main`; existing tag installs are repaired by `update` and by re-running the installer, which also refuses an install with local changes instead of carrying them along.
- **No more fix-cycle loops on work only a human can do** (ADR 0012). Tasks tagged `[HUMAN]`, and anything an agent defers (`deferred` in the implementer, remediation and converge output), are listed on the PR under "Needs human verification" instead of blocking. A finding re-raised after being rejected with nothing changed is deferred rather than cycled again; reviewers see what earlier cycles raised and decided, and a branch whose code did not change is not re-tested or re-reviewed. The implementation pass loop stops when a pass changes nothing and converge appends nothing. Retries are told why the last attempt failed and resume the implementer's session (falling back to a fresh one if it expired); the implementer now sees the ticket and human answers; a committed secret stops the job before another agent run. CI's no-checks grace window and time limit restart from each push.
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
