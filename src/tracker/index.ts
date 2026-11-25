import { ConfigError } from "../config/load.js";
import type { LoadedConfig } from "../config/schema.js";
import { ACCOUNT, JiraAuth, type SecretStore } from "../jira/auth.js";
import { createJiraClient } from "../jira/client.js";
import { createLinearClient, type LinearClient } from "../linear/client.js";
import { resolveSecret, saveSecret } from "../service/secrets.js";

export const trackerName = (c: Pick<LoadedConfig, "factory">) => (c.factory.tracker === "jira" ? "Jira" : "Linear");

/** The profile's secrets for Jira, in its own keychain service: the OAuth client secret and the rotating refresh token. */
export const keychainStore = (service: string, envPrefix = "SOFTWARE_FACTORY_JIRA_"): SecretStore => ({
  get: (account) => resolveSecret({ envName: `${envPrefix}${account.toUpperCase().replace(/-/g, "_")}`, keychainService: service, keychainAccount: account }),
  set: (account, value) => saveSecret({ keychainService: service, keychainAccount: account }, value),
});

const cache = new Map<string, { sig: string; client: LinearClient }>();

/**
 * The tracker client for this profile. Linear: its API key. Jira: the OAuth app. The Jira client is kept between calls so its short-lived
 * access token is reused; it is rebuilt when the app or site changes.
 */
export function createTrackerClient(config: LoadedConfig, deps: { store?: SecretStore; fetch?: typeof fetch; apiBase?: string; authBase?: string } = {}): LinearClient {
  if (config.factory.tracker !== "jira") {
    const key = resolveSecret({ envName: config.linear.apiKeyEnv, keychainService: config.linear.keychainService });
    if (!key) throw new ConfigError(`${config.linear.apiKeyEnv} is not set and no keychain entry "${config.linear.keychainService}" was found`);
    return createLinearClient({ apiKey: key });
  }
  const j = config.jira;
  if (!j.clientId || !j.site) throw new ConfigError("Jira is not connected: set up the OAuth app and connect in Settings → Tracker");
  const store = deps.store ?? keychainStore(j.keychainService);
  const sig = `${j.keychainService}|${j.clientId}|${j.site.cloudId}`;
  const shared = !deps.store && !deps.fetch; // only the real keychain-backed client is kept between calls
  const hit = cache.get(sig);
  if (hit && shared) return hit.client;
  const auth = new JiraAuth({ clientId: j.clientId, store, fetch: deps.fetch, base: deps.authBase });
  if (!store.get(ACCOUNT.refreshToken)) throw new ConfigError("Jira is not connected: connect it in Settings → Tracker");
  const client = createJiraClient({ auth, cloudId: j.site.cloudId, siteUrl: j.site.url, fetch: deps.fetch, apiBase: deps.apiBase });
  if (shared) cache.set(sig, { sig, client });
  return client;
}

/** Is the tracker usable right now (a key exists / Jira is connected)? Cheap: no network. */
export function trackerConfigured(config: LoadedConfig, store?: SecretStore): boolean {
  if (config.factory.tracker !== "jira") return Boolean(resolveSecret({ envName: config.linear.apiKeyEnv, keychainService: config.linear.keychainService }));
  const s = store ?? keychainStore(config.jira.keychainService);
  return Boolean(config.jira.clientId && config.jira.site && s.get(ACCOUNT.refreshToken) && s.get(ACCOUNT.clientSecret));
}
