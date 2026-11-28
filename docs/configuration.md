# Configuration
Your settings are YAML files in `~/.software-factory/config/` (`~/.software-factory/profiles/<name>/config/` for another profile): `factory.yaml`, `models.yaml`, `projects.yaml`, `linear.yaml`, `workflows.yaml`. They are validated by Zod (`src/config/schema.ts`). Normally you never edit them by hand: **Settings** in the app writes them (comments preserved). A file you have not changed falls back to the shipped default in `config/`. Override the directory with `FACTORY_CONFIG_DIR`. Validate with `software-factory config:check`.

Useful keys: `workflow.planning_mode` (`haiku_prompt`, the default, or `speckit`: how a ticket becomes an implementation; chosen per profile, so one profile can use Spec Kit while another does not), `workflow.max_conflict_resolutions` (0-10, default 3: automatic merge-conflict resolutions per job before a human is asked), `factory.maxConcurrentJobs` (1-8), `factory.maxRemediationAttempts` (0-10: fix cycles per phase: specification, code review, CI), `factory.maxImplementationPasses` (1-10: implement-then-check-against-the-spec rounds, default 3), `factory.githubAccount` (this profile's default `gh` login), `factory.logRetentionDays`, and per project `overrides: { maxConcurrentJobs, maxRemediationAttempts, maxImplementationPasses, models }`. Model ids are never hardcoded; routes map a task (classification, specification, implementation, independent_review, final_review, prompt_generation) to a provider (`local` | `anthropic`) and model string. `independent_review` is optional and unset by default (the independent review is skipped); set it to an OpenAI-compatible endpoint with `baseUrl`, `model` and an optional `apiKeyEnv` (the name of an environment variable holding the key, never the key itself). A project can override it, or set it to `null` to skip for that project. See [model-routing](model-routing.md).


`factory.hub` (`enabled`, `url`, `reportIntervalSeconds`, `remoteAccess`) is **off by default** and is managed by `factory hub connect` / `disconnect` / `remote-access`: it reports job progress (metadata only) to a central hub, and `remoteAccess` (a separate, also-off switch) lets the hub's web dashboard operate this factory through a default-deny route policy. The API key is never in a config file. See [Hub client](hub-client.md).

## MCP servers (off unless configured)
`factory.yaml` defines the MCP servers the profile's agents may use; nothing is available otherwise.
```yaml
mcp:
  keychainService: software-factory-mcp   # a new profile gets software-factory-mcp-<name>
  defaultServers: [github]                # what every project gets unless it selects its own
  servers:
    - name: github                        # letters, numbers, hyphens: tools become mcp__github__<tool>
      command: npx                        # stdio server: command + args; env lists variable NAMES only
      args: ["-y", "some-mcp-server"]
      env: [GITHUB_TOKEN]
    - name: docs                          # or type: http / sse with a url (headers may use ${VAR} for a name in env)
      type: http
      url: https://mcp.example.com/mcp
```
In the project editor (**Overrides → MCP servers for agents**) tick **Follow the profile default** (the default), or untick it and choose servers from those defined here; choosing none gives that project no MCP. Saving a project that names a server not defined in `factory.yaml` is refused with an error naming it. In `projects.yaml` a project selects servers with `overrides: { mcpServers: [docs] }`; that beats `defaultServers` (`[]` = none for that project), and leaving it out follows the profile. Secret values are entered in **Settings → Integrations → MCP servers** (or `PUT /api/mcp/servers/<name>` with `secrets`), stored in the profile's keychain service, and never written to a config file; config rejects a server with no name, no command/url, or an inline secret. Servers can only be defined here: a repository's `.software-factory.yml` cannot define or select them, because a server is an arbitrary command. Only Claude Code runs get MCP; the `local` provider gets none.

