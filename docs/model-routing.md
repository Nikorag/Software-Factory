# Model routing

`config/models.yaml` maps each task (`classification`, `specification`, `implementation`, `independent_review`, `final_review`) to a provider and model. Changing it needs no code change. `ModelRouter` (`src/agents/router.ts`) dispatches by provider and injects the model id.

| Provider | Adapter | Used for | Tools |
|---|---|---|---|
| `anthropic` | `ClaudeCodeAgent`: the `claude` CLI, your logged-in subscription, no API key | specification, implementation, final review | yes, under a permission profile |
| `local` | `LocalModelClient`: OpenAI-compatible HTTP (Bionic / LM Studio style) | classification, independent review | none: read-only requests only |

`specification` and `implementation` must be `anthropic` (config validation enforces it). A `local` route whose model is `UNCONFIGURED-*` is refused at call time with a pointer to `pnpm factory doctor`, which lists what the server actually has loaded and checks each local route against it. Model id `default` on an `anthropic` route means "let Claude Code pick".

## Local model rules
- **Strictly sequential**: one request at a time (a FIFO queue in the client), because 32 GB of unified memory cannot host parallel local inference. Queued requests can be cancelled.
- Structured output: requests a strict `json_schema` `response_format`; if the server rejects it, falls back to instructing JSON in the prompt; invalid JSON is re-asked up to twice, then `invalid_output`. `<think>…</think>` blocks are stripped.
- Failures are classified: `transient` (unreachable, 5xx, 429), `timeout`, `cancelled`, `invalid_output`, `error`.
- **Unverified**: Bionic's API server has not been reachable yet (server off, Qwen downloads incomplete), so the adapter is tested against a simulated OpenAI-shaped server only. Start Bionic's server and run `pnpm factory doctor` to verify the endpoint and model ids.

## Claude Code rules
See `docs/integrations.md`.
