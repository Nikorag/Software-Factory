# Model routing

`config/models.yaml` maps each task (`classification`, `specification`, `implementation`, `independent_review`, `final_review`, `prompt_generation`) to a **plugin instance** and a model. Changing it needs no code change. `ModelRouter` (`src/agents/router.ts`) resolves a task to its instance, checks what that plugin can do, and injects the model id. The engine never learns which backend runs a task: see [plugins.md](plugins.md) and [ADR 0018](adr/0018-plugin-providers.md).

```
Workflow engine → router / runner → plugin → execution backend
                                    (claude-code, openai, openai-compatible, …)
```

## Plugins and instances

A **plugin** is code (built in, or registered at composition time). A **plugin instance** is a named configuration of one plugin: its id plus its settings. Define an instance once under `plugins:` and refer to it from any number of routes:

```yaml
plugins:
  lm-studio: { plugin: openai-compatible, settings: { baseUrl: "http://127.0.0.1:1234/v1" } }
  gpt:       { plugin: openai }                       # api.openai.com, key from OPENAI_API_KEY
  gateway:   { plugin: openai, settings: { baseUrl: "https://llm.example.test/v1", apiKeyEnv: GATEWAY_KEY } }
routes:
  classification:     { plugin: lm-studio, model: qwen2.5-7b-instruct }
  specification:      { plugin: claude-code, model: default }
  implementation:     { plugin: claude-code, model: default }
  independent_review: { plugin: gpt, model: gpt-4o-mini }
  final_review:       { plugin: claude-code, model: default }
```

Two instances always exist without being listed: `claude-code` (the Claude Code CLI) and `local` (an `openai-compatible` instance at `local.baseUrl`). A `plugins:` entry of the same id replaces them.

Built-in plugins:

| Plugin | Executes | Tools | Settings |
|---|---|---|---|
| `claude-code` | the locally installed Claude Code CLI, on your subscription login | yes (file + shell, per-role permission profiles) | none. Model: `default`, an alias (`haiku`, `sonnet`, `opus`) or a full id |
| `openai-compatible` | any OpenAI-style chat endpoint: LM Studio, llama.cpp, Ollama, a gateway | no (read-only) | `baseUrl` (default `http://127.0.0.1:1234/v1`), optional `apiKeyEnv` |
| `openai` | the OpenAI API | no (read-only) | `baseUrl` (default `https://api.openai.com/v1`), `apiKeyEnv` (default `OPENAI_API_KEY`) |

LM Studio and llama.cpp are *configurations* of `openai-compatible`, not separate code. `openai` and `openai-compatible` share one client; only the default endpoint and key handling differ.

Settings → Plugins lists every plugin with its version, compatibility, capabilities and state (and why one is unavailable), lets you add instances, and validates one **without a model call**: it checks the settings and, where the plugin can, that the server answers (`GET /models`). Settings → Workflow then offers each step only the instances that can do it, and only the model fields that plugin supports.

## Capabilities decide where a plugin fits

`specification`, `implementation` and `prompt_generation` read and write the repository, so their route must use a plugin that declares **tool access**. Config validation rejects anything else with `specification, implementation and prompt_generation need file and shell tools…` (project overrides too). A plugin from outside the built-ins is judged by the router the first time it routes. Reviewers stay read-only: the runner refuses a non-read-only role on a plugin that cannot write the worktree, and re-checks that a tool-using plugin left the worktree untouched after a read-only run.

## Older files keep working (migration on read)

Files written before plugins use `provider:`. They load unchanged, are **never rewritten**, and route identically:

| Old | Means |
|---|---|
| `{ provider: anthropic, model }` | the `claude-code` instance |
| `{ provider: local, model }` | the `local` instance (`local.baseUrl`) |
| `{ provider: local, model, baseUrl, apiKeyEnv }` | an `openai-compatible` instance with that endpoint and key variable |

Project overrides (`overrides.models` in `projects.yaml`) and the independent reviewer (`null` = skip, absent = follow the global one, `independentReviewFallback`) keep their meaning. Saving from the dashboard writes the new `plugin:` form for the routes you edit. A route that names a missing instance fails with a clear `ConfigError` (at load for `models.yaml`, when routing for a project override); `doctor` reports it.

Default routing, all through your Claude subscription, no local model required:

| Task | Model | Why |
|---|---|---|
| `classification` | `haiku` | fast, cheap, advisory |
| `prompt_generation` | `haiku` | `haiku_prompt` mode: reads the repo and writes the implementer's prompt (it does not implement). Needs a tool-capable plugin |
| `independent_review` | unset (skipped) | optional: any plugin, a *different* model from the author (see below) |
| `specification`, `implementation`, `final_review` | `default` (Claude Code's choice) | the heavy engineering work |

### Independent reviewer (optional)

With only Claude there is nothing independent to review with, so `independent_review` is **unset by default and the step is skipped** (no model call; a `review.skipped` decision shows on the job's timeline). The Claude review and the security review still run. To use one, point it at an instance:

```yaml
independent_review: { plugin: gpt, model: gpt-4o-mini }
```

- The endpoint and key belong to the instance, set once. The older inline form (`{ provider: local, model, baseUrl, apiKeyEnv }`) still works.
- `apiKeyEnv` is the **name** of an environment variable holding the key (set it where the service runs). Requests send `Authorization: Bearer <key>`. The key is never written to `models.yaml`, the database, logs or any API response. A key setting that is not a variable name, or a `baseUrl` that is plain http to a non-local host while a key is set, is rejected. If the variable is missing the request fails with a message naming the variable, and the fallback below applies.
- The reviewer is read-only: it has no tools.
- If the reviewer is unavailable, `independentReviewFallback` applies: `claude` (a fresh reviewer on `final_review`, recorded as `review.degraded`) or `block`. This applies to a reviewer on an **API-kind** plugin (a server that can be down); a CLI plugin's failure is just a failure. It keys off the plugin's declared kind, not its name.
- Clear it (remove the line, or `null`; in Settings use "Clear") to skip. A project can override or clear it for itself.

`doctor` warns if the reviewer is the same model as `specification` (same instance and model); an unset reviewer is not a failure. It also reports plugin instances that are undefined, not installed, incompatible or misconfigured, and checks that each model-serving instance is reachable and lists the configured model.

## OpenAI-style plugin rules (`openai`, `openai-compatible`)
- **Strictly sequential**: one request at a time (a FIFO queue in the client), because a local model cannot share unified memory with parallel requests. Instances with identical settings share one client and so one queue. Queued requests can be cancelled.
- Structured output: requests a strict `json_schema` `response_format`; if the server rejects it, falls back to instructing JSON in the prompt; invalid JSON is re-asked up to twice, then `invalid_output`. `<think>…</think>` blocks are stripped.
- Failures are classified: `transient` (unreachable, 5xx, 429), `timeout`, `cancelled`, `invalid_output`, `error` (including HTTP 4xx and a missing key variable). `run()` never throws.
- **Verification**: the adapter is tested against a simulated OpenAI-shaped server. Run `software-factory doctor` with your server running to verify the endpoint and model ids. A real OpenAI call is not part of the automated tests.

## Claude Code rules
See `docs/integrations.md`.
