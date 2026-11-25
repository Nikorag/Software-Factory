# Changelog

Updates: `software-factory update` (add `--check` to only look). Releases are git tags named `v<major>.<minor>.<patch>`; the installer and `update` follow the newest one.

## 0.1.0

First release.
- Linear tickets become pull requests: Spec Kit specification, sandboxed implementation, independent and Claude reviews, a fix loop capped at 3, PR-only delivery (the factory never merges).
- Dashboard (React + shadcn/ui): live pipeline flow chart, controls, answer-and-resume for held jobs.
- Setup wizard and Settings UI: integrations, Linear key (keychain), projects and their commands, background clone/validate/check/onboard actions.
- `curl | bash` installer and `software-factory update`.
