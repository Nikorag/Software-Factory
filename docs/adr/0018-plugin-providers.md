# ADR 0018: Model and implementation providers are plugins

Supersedes the `anthropic | local` provider switch described in [ADR 0005](0005-claude-haiku-for-independent-review.md) and [ADR 0016](0016-optional-independent-reviewer.md). Their decisions about *what* runs where (Haiku for classification, an optional independent reviewer, the read-only reviewer rule) stand.

## Context
The router mapped each task to `provider: anthropic | local`. Claude Code was assumed for anything with tools, the runner and stage kit tested the provider name (`=== "anthropic"`, `=== "local"`), and the "must be anthropic" rule was a hard-coded refine. Adding Codex, LM Studio or the OpenAI API would have meant another enum member and another switch in the engine.

## Decision
Engine → router/runner → **plugin** → execution backend. The engine knows only the plugin contract (`src/plugins/types.ts`).

- **Contract.** A plugin declares id, name, version, the engine API range it supports, a zod settings schema, and **capabilities** (execution kind `cli | api`, tool access, writes the worktree, structured output, streaming, model listing, read-only, uses an API key). It runs a request through the existing `AgentRequest → AgentResult` shape (failures classified by `AgentFailure`, duration/exit code/session/log file as metadata) and honours `AbortSignal` and `timeoutMs`. It may list models and probe its backend without a model call.
- **Instances.** Configuration is a named instance (plugin id + settings), defined once under `plugins:` and referenced by routes: `{ plugin: <instance>, model }`. `claude-code` and `local` exist by default.
- **Registry.** `PluginRegistry` holds the built-ins (`claude-code`, `openai-compatible`, `openai`) and any plugin passed to `createContext({ plugins })`. It validates settings, reports why a plugin is unavailable (incompatible engine API, invalid settings), shares one runtime between instances with identical settings (preserving the sequential local queue), and guarantees `run()` never throws.
- **Capabilities, not names.** Route validation requires tool access for `specification`, `implementation` and `prompt_generation`. The runner forbids non-read-only roles on plugins that cannot write the worktree and runs the read-only worktree check for any plugin with tools. The independent-reviewer fallback keys off the plugin's execution kind (an API endpoint can be down; a CLI agent's failure is a failure). No engine code names a provider.
- **Migration on read.** Legacy `provider:` routes (global, project overrides, the reviewer with `baseUrl`/`apiKeyEnv`) resolve to the instance they always meant at routing time. Nothing is rewritten and routing is identical. `agent_invocations.agent` now records `<instance>/<role>`; older rows stay readable.
- **No dynamic loading.** Plugins are registered in code at composition time. Loading code named in config (from disk or npm) would execute arbitrary code from a file that people and the dashboard edit. Config only names a plugin and supplies settings; secrets are env-var names, never values.

## Consequences
Adding a provider is one module and one registration; the engine, workflow definitions and other plugins are untouched. `openai` and `openai-compatible` share a client. The dashboard lists plugins, edits instances and validates them; step pickers show only compatible instances. Remote (hub) sessions may read plugin state but not change instances or trigger validation.

## Follow-ups
Loading plugins from disk or npm (needs a trust and signing story), Codex / LM Studio-specific / AGY plugins, streaming output in the dashboard, and per-plugin settings forms driven by the plugin's schema (the UI currently derives `baseUrl` and key-variable fields from capabilities).
