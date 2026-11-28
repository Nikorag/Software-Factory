# Provider plugins

A provider plugin is how the factory talks to a model or an implementation backend: the Claude Code CLI, the OpenAI API, an OpenAI-compatible server such as LM Studio, and anything you add. The workflow engine only ever calls the router and runner; it never knows which plugin answers. Read [model-routing.md](model-routing.md) for configuration and [ADR 0018](adr/0018-plugin-providers.md) for why.

## The contract (`src/plugins/types.ts`)

```ts
interface ProviderPlugin<S> {
  id: string; name: string; description?: string; version: string;
  engineApi: { min: number; max: number };        // engine API versions it works with (ENGINE_API_VERSION is 1)
  capabilities: PluginCapabilities;
  modelPresets?: string[];                         // one-click model names in the dashboard (optional)
  settings: z.ZodType<S>;                          // validates and defaults an instance's settings; reject unknown keys with .strict()
  create(settings: S, env: { env; fetch? }): PluginRuntime;   // no I/O here
  probe?(settings: S, env): Promise<{ ok: boolean; detail: string; models?: string[] }>;  // optional, no model call
}
interface PluginRuntime extends Agent {            // Agent: run(req: AgentRequest): Promise<AgentResult>
  listModels?(timeoutMs?: number): Promise<string[]>;
}
```

- **Run.** `run(req)` takes the existing `AgentRequest` (role, permission `profile`, prompt, `cwd`, `model`, `systemPrompt`, `jsonSchema`, `timeoutMs`, `signal`, …) and returns the existing `AgentResult` (`ok`, `text`, `structured`, `failure`, `error`, `exitCode`, `durationMs`, `sessionId`, `logFile`, `usage`, `denials`). Execution metadata is those fields.
- **Errors.** Classify with `AgentFailure`: `timeout`, `cancelled`, `auth`, `rate_limited`, `transient`, `invalid_output`, `error`. `transient`, `timeout` and `rate_limited` are retried by the engine; `auth` and `invalid_output` need a person. **`run()` must not throw**: return a failed result. (The registry also wraps every runtime so an escaped exception becomes `{ ok: false, failure: "error" }`.)
- **Cancellation and timeout.** Stop when `req.signal` aborts (return `failure: "cancelled"`) and when `req.timeoutMs` elapses (`failure: "timeout"`). Kill what you started.
- **Capabilities** (`PluginCapabilities`): `kind` (`cli` or `api`), `tools` (reads files and runs commands in the worktree), `writesWorktree`, `structuredOutput`, `streaming` (optional; the engine never relies on it), `listsModels`, `readOnly`, `usesApiKey`. Declare them honestly: the factory uses them, not names.
  - `specification`, `implementation` and `prompt_generation` require `tools`.
  - A plugin without `tools` and `writesWorktree` only serves the read-only profile; the runner refuses other roles before calling it. Enforce it yourself too.
  - A plugin with `tools` gets the read-only worktree check after every read-only run.
  - The independent-reviewer fallback applies to `kind: "api"` plugins.
- **Permission profiles.** A tool-using plugin must honour `req.profile` (`read-only`, `spec-writer`, `implementer`), `protectedPaths`, `readPaths`, `access`, `bashAllow` and `bashAny`. The runner re-verifies protected paths and read-only runs afterwards, but the plugin is the first line. `src/agents/permissions.ts` shows how Claude Code's rules are built; do not weaken them.

## Security rules

- **Secrets by env-var name only.** Settings carry the *name* of a variable (`apiKeyEnv`), validated as a variable name. Read the value from `env.env` at request time. Never store it in settings or config (the loader rejects keys such as `apiKey` and `token`), and never log it, put it in an error, a result, the database or an API response.
- **HTTPS for keyed endpoints.** If your settings send a key to a URL, apply the same rule as the built-ins: https, or http only for localhost (`validHubUrl`).
- **No code from config.** Config can name a plugin and supply settings; it cannot load code. Plugins are registered in code (below).
- **Probes must not make a model call.** `probe` may check settings, reachability and model listing; the dashboard's Validate button calls it.
- **Sequential backends stay sequential.** A plugin for local inference should queue requests, as `LocalModelClient` does.

## Writing a plugin

```ts
import { z } from "zod";
import { ENGINE_API_VERSION, type ProviderPlugin } from "../plugins/types.js";

export const codexPlugin: ProviderPlugin<{ bin: string }> = {
  id: "codex", name: "Codex", version: "0.1.0",
  engineApi: { min: ENGINE_API_VERSION, max: ENGINE_API_VERSION },
  capabilities: { kind: "cli", tools: true, writesWorktree: true, structuredOutput: false, streaming: false, listsModels: false, readOnly: true, usesApiKey: false },
  settings: z.object({ bin: z.string().default("codex") }).strict(),
  create: (s) => ({
    provider: "codex",
    async run(req) {
      // spawn s.bin in req.cwd with req.prompt, honour req.signal / req.timeoutMs / req.profile,
      // and return an AgentResult: never throw.
      return { ok: true, text: "…", denials: [], exitCode: 0, durationMs: 1 };
    },
  }),
};
```

For an OpenAI-style endpoint do not write a client: add an instance of `openai-compatible` (LM Studio, llama.cpp, Ollama) or `openai`. They share `chatPlugin` in `src/plugins/builtin/chat.ts`; a new hosted service with different defaults is one `chatPlugin({ … })` call.

## Registering a plugin

Plugins are registered at composition time. Built-ins are registered by `createRegistry()` in `src/plugins/builtin/index.ts`. A plugin of your own is passed in; nothing else changes (no engine, workflow definition or other plugin is edited):

```ts
const ctx = createContext(config, { plugins: [codexPlugin] });   // src/app/context.ts
```

Then define an instance and use it in `models.yaml`:

```yaml
plugins:
  codex: { plugin: codex, settings: { bin: codex } }
routes:
  implementation: { plugin: codex, model: default }
```

The registry rejects a duplicate id or a malformed id, lists the plugin with its version and compatibility (an `engineApi` range that excludes the current engine API shows as `incompatible` with the reason), and validates each instance's settings before building it. The dashboard's Plugins tab shows it and offers only compatible steps.

**Dynamic loading** of plugins from disk or npm is not supported yet, on purpose (see the ADR). It is a follow-up.

## Testing a plugin

Follow `tests/plugins.test.ts`:

- **Discovery and settings**: register it with `createRegistry({ extra: [plugin] })`; assert it is listed with its capabilities; `registry.validate(id, { plugin, settings })` for valid, invalid and unknown settings; an out-of-range `engineApi` is `incompatible`.
- **Execution**: `registry.runtime(id, instance).run(req)` for success, structured output, each `AgentFailure` path, timeout (`timeoutMs`), cancellation (`AbortController`), and that nothing throws. For HTTP backends use a local `createServer` as the existing tests do; never the network.
- **Capabilities**: route it through `ModelRouter(models, {}, undefined, registry)` and check that a tool step is rejected when `tools` is false, and that the runner refuses a non-read-only role on a read-only plugin.
- **Secrets**: run with a key in the environment and assert the value appears in no result, log or database row.
- **Workflow**: `ScriptedAgent` (`tests/helpers/scripted-agent.ts`) stands in for a plugin in end-to-end flows; pass it as `createContext(config, { agents: { <instance id>: agent } })`.
