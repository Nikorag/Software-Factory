import { ConfigError } from "../config/load.js";
import { mcpServersOf, type LoadedConfig, type McpServer } from "../config/schema.js";
import type { SecretStore } from "../jira/auth.js";
import { keychainStore } from "../tracker/index.js";

/**
 * What one Claude Code run gets from MCP. `servers` is the `mcpServers` object for `--mcp-config`: it holds NO secret value, only `${NAME}`
 * references (Claude Code expands them from its own environment). `env` carries the values, for the Claude subprocess's environment only
 * (agentEnv's `extra`), under names scoped to the server so two servers' variables can never collide. Never on argv, in the DB or in a log.
 */
export interface McpGrant { names: string[]; servers: Record<string, Record<string, unknown>>; env: Record<string, string> }

export const mcpStore = (service: string): SecretStore => keychainStore(service, "SOFTWARE_FACTORY_MCP_");
/** The keychain account of one secret of one server. */
export const mcpAccount = (server: string, envName: string): string => `${server}/${envName}`;
const scoped = (server: string, envName: string): string => `SF_MCP_${server.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${envName}`;

/** Which secrets of a server are set (names only), for the settings API and the connection test. */
export const secretStatus = (s: Pick<McpServer, "name" | "env">, store: SecretStore): { name: string; set: boolean }[] =>
  s.env.map((name) => ({ name, set: Boolean(store.get(mcpAccount(s.name, name))) }));

/** The entry for one server in `--mcp-config`, plus the scoped environment its `${...}` references resolve against. */
export function mcpEntry(s: McpServer, store: SecretStore): { entry: Record<string, unknown>; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const ref: Record<string, string> = {};
  for (const name of s.env) {
    const v = store.get(mcpAccount(s.name, name));
    if (!v) throw new ConfigError(`MCP server "${s.name}": no value saved for ${name} (Settings → Integrations → MCP servers)`);
    env[scoped(s.name, name)] = v;
    ref[name] = `\${${scoped(s.name, name)}}`;
  }
  if (s.type === "stdio") return { entry: { type: "stdio", command: s.command, args: s.args, ...(s.env.length ? { env: ref } : {}) }, env };
  // http/sse: a header may say `${NAME}` for a variable the server lists in `env`; rewrite it to the scoped name.
  const headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, v.replace(/\$\{(\w+)\}/g, (m, n: string) => (ref[n] ?? m))]));
  return { entry: { type: s.type, url: s.url, ...(Object.keys(headers).length ? { headers } : {}) }, env };
}

/**
 * The grant for a project's runs: its own selection, else the profile's default. undefined when nothing is selected (no MCP).
 * Throws a ConfigError when a selected server's secret is missing, so a run never starts half-connected.
 */
export function resolveMcp(config: Pick<LoadedConfig, "factory" | "projects">, projectId: string | undefined, store: SecretStore): McpGrant | undefined {
  const project = projectId ? config.projects.projects.find((p) => p.id === projectId) : undefined;
  const names = [...new Set(mcpServersOf(config, project))];
  if (!names.length) return undefined;
  const grant: McpGrant = { names: [], servers: {}, env: {} };
  for (const name of names) {
    const def = config.factory.mcp.servers.find((s) => s.name === name);
    if (!def) throw new ConfigError(`MCP server "${name}" is selected but not defined in factory.yaml`);
    const { entry, env } = mcpEntry(def, store);
    grant.names.push(name); grant.servers[name] = entry; Object.assign(grant.env, env);
  }
  return grant;
}
