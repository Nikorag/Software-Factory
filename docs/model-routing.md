# Model routing

`config/models.yaml` maps each task (`classification`, `specification`, `implementation`, `independent_review`, `final_review`, `prompt_generation`) to a provider and model. Changing it needs no code change. `ModelRouter` (`src/agents/router.ts`) dispatches by provider and injects the model id.

Default routing (`config/models.yaml`), all through your Claude subscription, no local model required:

| Task | Model | Why |
|---|---|---|
| `classification` | `haiku` | fast, cheap, advisory |
| `prompt_generation` | `haiku` | `haiku_prompt` mode: reads the repo and writes the implementer's prompt (it does not implement). Optional in models.yaml; must be `anthropic` |
| `independent_review` | `haiku` | a *different* model from the author, so the reviewer is not marking its own work |
| `specification`, `implementation`, `final_review` | `default` (Claude Code's choice) | the heavy engineering work |

A local Qwen model was judged too slow on this machine, so it is not the default. The `local` provider (`LocalModelClient`, OpenAI-compatible, strictly sequential) is still supported for anyone who wants it, but nothing uses it unless a route says `provider: local`.

Model names: `default` lets Claude Code choose; an alias (`haiku`, `sonnet`, `opus`) tracks that family's latest (verified: `haiku` resolves to `claude-haiku-5-5`); a full id pins it. `pnpm factory doctor` warns if `independent_review` is the same model as `specification`.

`specification`, `implementation` and `prompt_generation` must be `anthropic` (config validation enforces it).

## Local model rules (only if you route to `local`)
- **Strictly sequential**: one request at a time (a FIFO queue in the client), because a local model cannot share unified memory with parallel requests. Queued requests can be cancelled.
- Structured output: requests a strict `json_schema` `response_format`; if the server rejects it, falls back to instructing JSON in the prompt; invalid JSON is re-asked up to twice, then `invalid_output`. `<think>…</think>` blocks are stripped.
- Failures are classified: `transient` (unreachable, 5xx, 429), `timeout`, `cancelled`, `invalid_output`, `error`.
- **Verification**: the adapter is tested against a simulated OpenAI-shaped server. Run `software-factory doctor` with your server running to verify the endpoint and model ids.

## Claude Code rules
See `docs/integrations.md`.
