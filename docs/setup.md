# Setup

The installer checks all of this for you and says how to fix anything missing (`bash install.sh --check`). `software-factory doctor` re-checks it at any time.

| Need | Install |
|---|---|
| macOS | Project commands run inside `sandbox-exec`; there is no Linux or Windows support yet |
| git | `xcode-select --install` |
| Node.js 22+ | `brew install node` |
| Claude Code, signed in | `curl -fsSL https://claude.ai/install.sh | bash`, then run `claude` and `/login` with your subscription (no API key) |
| GitHub CLI, signed in | `brew install gh`, then `gh auth login` (once per GitHub account you want to use) |
| uv (provides Python for Spec Kit) | `brew install uv` |
| Spec Kit (only for `workflow.planning_mode: speckit`) | `uv tool install specify-cli` ([github/spec-kit](https://github.com/github/spec-kit)) |
| Linear API key | Linear → Settings → Account → Security & access → Personal API keys. The setup wizard stores it in your macOS keychain |

## Optional: a local model

Off by default: Claude Haiku does classification and review. Only if you route a task to `provider: local` (Settings → Workflow): start any OpenAI-compatible server (LM Studio, llama.cpp, Ollama), load a model, set the route's model id, and run `software-factory doctor` to verify it.
