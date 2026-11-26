import { rmSync } from "node:fs";
import { deleteSecret, saveSecret } from "../service/secrets.js";
import { HubClient, HubError, type FetchLike } from "./client.js";
import { HUB_KEY_ENV, hubKey, hubKeySource, looksLikeHubKey, normalizeHubUrl, readHubSettings, writeHubSettings } from "./settings.js";
import { readState, stateFile } from "./reporter.js";

export interface ConnectDeps { configDir: string; dataDir: string; fetch?: FetchLike; env?: NodeJS.ProcessEnv; save?: (key: string) => void; version?: string }

/**
 * Validates the key against the hub (a heartbeat), stores it (keychain, never a file), then switches reporting on.
 * Nothing is enabled if the hub rejects the key or the key cannot be stored.
 */
export async function connectHub(input: { url: string; key: string }, d: ConnectDeps): Promise<{ url: string }> {
  const url = normalizeHubUrl(input.url);
  const key = input.key.trim();
  if (!looksLikeHubKey(key)) throw new Error("that does not look like a hub API key (expected sfh_…): copy it again from the hub");
  try { await new HubClient({ url, key, fetch: d.fetch, timeoutMs: 10_000 }).heartbeat(d.version, {}); }
  catch (e) {
    if (e instanceof HubError && e.rejected) throw new Error("the hub rejected this key. Check it was copied in full and has not been revoked.");
    throw new Error(`could not reach the hub at ${url}: ${(e as Error).message}`);
  }
  // A key supplied through the environment is read from the environment by the service, so it is not copied into the keychain.
  if ((d.env ?? process.env)[HUB_KEY_ENV] !== key) {
    try { (d.save ?? ((k) => saveSecret(hubKeySource(), k)))(key); }
    catch (e) { throw new Error(`could not store the key (${(e as Error).message}). Set ${HUB_KEY_ENV} in the service's environment instead, then run this again.`); }
  }
  rmSync(stateFile(d.dataDir), { force: true }); // fresh cursor for a fresh connection
  writeHubSettings({ enabled: true, url }, d.configDir);
  return { url };
}

export function disconnectHub(d: { configDir: string; dataDir: string; deleteKey?: () => void }): void {
  writeHubSettings({ enabled: false }, d.configDir);
  (d.deleteKey ?? (() => deleteSecret(hubKeySource())))();
  rmSync(stateFile(d.dataDir), { force: true });
}

export interface HubStatus { enabled: boolean; url: string; keyPresent: boolean; keyRejected: boolean; lastSuccessAt: string | null; lastError: string | null; pendingRetryAt: string | null }
/** Never includes the key itself. */
export function hubStatus(d: { configDir: string; dataDir: string; getKey?: () => string | undefined }): HubStatus {
  const s = readHubSettings(d.configDir), st = readState(d.dataDir);
  return {
    enabled: s.enabled, url: s.url, keyPresent: Boolean((d.getKey ?? hubKey)()), keyRejected: st.keyRejected,
    lastSuccessAt: st.lastSuccessAt ? new Date(st.lastSuccessAt).toISOString() : null, lastError: st.lastError,
    pendingRetryAt: st.nextAttemptAt > Date.now() ? new Date(st.nextAttemptAt).toISOString() : null,
  };
}
