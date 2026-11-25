# Setup

Prerequisites verified by `pnpm factory doctor`: Node ≥ 22, pnpm, git, gh (authenticated), claude (logged in).

| Need | Command |
|---|---|
| pnpm | `npm install -g pnpm` |
| SpecKit CLI (Milestone 6) | `uv tool install specify-cli` (per https://github.com/github/spec-kit; re-verify at integration time) |
| Linear (Milestone 4) | `export LINEAR_API_KEY=...` |
| Local model | Optional and off by default (Claude Haiku does classification and review). Only if you route a task to `provider: local`: start Bionic's API server, load a model, and set the route's model id in `config/models.yaml` |

Bionic is LM Studio-derived and ships an `lms` CLI at `~/.lmstudio/bin/lms` (`lms server status`, `lms ls`). Its API is not yet verified; run `doctor` after starting it.
