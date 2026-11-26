import { ConfigError } from "../config/load.js";
import { connectionLabel, connectionNames, trackerIdOf, type LinearConfig, type LoadedConfig, type TrackerConnection } from "../config/schema.js";
import { ACCOUNT, JiraAuth, type SecretStore } from "../jira/auth.js";
import { createJiraClient } from "../jira/client.js";
import { createGithubIssuesClient } from "../github-issues/client.js";
import type { GhExec } from "../github/client.js";
import { createLinearClient, type LinearClient } from "../linear/client.js";
import { resolveSecret, saveSecret } from "../service/secrets.js";

type Cfg = Pick<LoadedConfig, "factory" | "connections">;

/** The connection with this id (default: the profile's default tracker). */
export function connectionOf(c: Cfg, id: string = c.factory.tracker): TrackerConnection {
  const conn = c.connections[id];
  if (!conn) throw new ConfigError(`there is no tracker connection "${id}"`);
  return conn;
}
/** The status and label names of a connection (the default's are the live, shared `config.linear`). */
export const trackerNames = (c: LoadedConfig, id: string = c.factory.tracker): LinearConfig => (id === c.factory.tracker ? c.linear : connectionNames(connectionOf(c, id)));
/** Display name of a connection: "Linear", "Jira", "GitHub Issues" for the built-in ones, else the label you gave it. */
export const trackerName = (c: Cfg, id: string = c.factory.tracker) => { const conn = c.connections[id]; return conn ? connectionLabel(id, conn) : id; };

/** Env var prefix for a Jira connection's secrets (the built-in one keeps its original names). */
const jiraEnvPrefix = (id: string) => (id === "jira" ? "SOFTWARE_FACTORY_JIRA_" : `SOFTWARE_FACTORY_JIRA_${id.toUpperCase().replace(/-/g, "_")}_`);

/** A Jira connection's secrets, in its own keychain service: the OAuth client secret and the rotating refresh token. */
export const keychainStore = (service: string, envPrefix = "SOFTWARE_FACTORY_JIRA_"): SecretStore => ({
  get: (account) => resolveSecret({ envName: `${envPrefix}${account.toUpperCase().replace(/-/g, "_")}`, keychainService: service, keychainAccount: account }),
  set: (account, value) => saveSecret({ keychainService: service, keychainAccount: account }, value),
});
/** The secret store for one Jira connection. */
export const jiraStoreFor = (config: Cfg, id: string): SecretStore => {
  const c = connectionOf(config, id);
  if (c.kind !== "jira") throw new ConfigError(`"${id}" is not a Jira connection`);
  return keychainStore(c.keychainService, jiraEnvPrefix(id));
};

export interface ClientDeps { store?: SecretStore; fetch?: typeof fetch; apiBase?: string; authBase?: string; gh?: GhExec; id?: string }
const cache = new Map<string, LinearClient>();

/**
 * The tracker client for one connection (default: the profile's default). Linear: its API key. Jira: the connection's OAuth app. GitHub: the
 * `gh` login. A Jira client is kept between calls so its short-lived access token is reused; it is rebuilt when the app or site changes.
 */
export function createTrackerClient(config: LoadedConfig, deps: ClientDeps = {}): LinearClient {
  const id = deps.id ?? config.factory.tracker;
  const c = connectionOf(config, id);
  if (c.kind === "github") return createGithubIssuesClient({ account: c.account ?? config.factory.githubAccount, statusPrefix: c.statusPrefix, statuses: c.statuses, run: deps.gh }); // authentication is the gh login, exactly as for pull requests
  if (c.kind === "linear") {
    const key = resolveSecret({ envName: c.apiKeyEnv, keychainService: c.keychainService });
    if (!key) throw new ConfigError(`${c.apiKeyEnv} is not set and no keychain entry "${c.keychainService}" was found${id === "linear" ? "" : ` (tracker "${id}")`}`);
    return createLinearClient({ apiKey: key });
  }
  if (!c.clientId || !c.site) throw new ConfigError(`Jira${id === "jira" ? "" : ` "${id}"`} is not connected: set up the OAuth app and connect in Settings → Trackers`);
  const store = deps.store ?? keychainStore(c.keychainService, jiraEnvPrefix(id));
  const sig = `${id}|${c.keychainService}|${c.clientId}|${c.site.cloudId}`;
  const shared = !deps.store && !deps.fetch; // only the real keychain-backed client is kept between calls
  const hit = cache.get(sig);
  if (hit && shared) return hit;
  const auth = new JiraAuth({ clientId: c.clientId, store, fetch: deps.fetch, base: deps.authBase });
  if (!store.get(ACCOUNT.refreshToken)) throw new ConfigError(`Jira${id === "jira" ? "" : ` "${id}"`} is not connected: connect it in Settings → Trackers`);
  const client = createJiraClient({ auth, cloudId: c.site.cloudId, siteUrl: c.site.url, fetch: deps.fetch, apiBase: deps.apiBase });
  if (shared) cache.set(sig, client);
  return client;
}

/** Is this connection usable right now (a key exists / Jira is connected)? Cheap: no network. */
export function trackerConfigured(config: LoadedConfig, store?: SecretStore, id: string = config.factory.tracker): boolean {
  const c = connectionOf(config, id);
  if (c.kind === "github") return true; // gh holds the credentials; a missing login shows up as an error from the tracker check
  if (c.kind === "linear") return Boolean(resolveSecret({ envName: c.apiKeyEnv, keychainService: c.keychainService }));
  const s = store ?? keychainStore(c.keychainService, jiraEnvPrefix(id));
  return Boolean(c.clientId && c.site && s.get(ACCOUNT.refreshToken) && s.get(ACCOUNT.clientSecret));
}

/**
 * Everything that has to talk to "the tracker" asks a TrackerSet, because each project may live in a different connection (and a profile
 * can have several Linears and Jiras). `override` is a test double: one client for every connection.
 */
export interface TrackerSet {
  /** The connection id a project uses: its own, else the profile's default. */
  idOf(project?: { tracker?: string | undefined } | null): string;
  client(id: string): LinearClient;
  /** The status and label names of a connection. */
  names(id: string): LinearConfig;
  label(id: string): string;
}
export function trackerSet(config: LoadedConfig, deps: ClientDeps = {}, override?: LinearClient): TrackerSet {
  return {
    idOf: (p) => trackerIdOf(config, p),
    client: (id) => override ?? createTrackerClient(config, { ...deps, id }),
    names: (id) => trackerNames(config, id),
    label: (id) => trackerName(config, id),
  };
}

/** Ids of the connections that matter right now: the default, and any an enabled project uses. */
export function trackerIdsInUse(config: LoadedConfig): string[] {
  return [...new Set([config.factory.tracker, ...config.projects.projects.filter((p) => p.enabled).map((p) => trackerIdOf(config, p))])].filter((id) => config.connections[id]);
}
