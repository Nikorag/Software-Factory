import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMap, parseDocument } from "yaml";
import { BUNDLED_CONFIG_DIR, defaultConfigDir, loadConfig } from "../config/load.js";
import { seedHomeConfig } from "../config/store.js";
import { validHubUrl } from "../config/schema.js";
import { resolveSecret, type SecretSource } from "../service/secrets.js";

export const HUB_KEY_ENV = "FACTORY_HUB_KEY";
const KEY_RE = /^sfh_[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,100}$/;

export const looksLikeHubKey = (k: string) => KEY_RE.test(k);

/** One key per profile, so a "home" and a "work" profile can report to different hubs/factories. */
export const hubKeySource = (profile = process.env.FACTORY_PROFILE ?? "default"): SecretSource => ({ envName: HUB_KEY_ENV, keychainService: "software-factory-hub", keychainAccount: `hub:${profile}` });
export const hubKey = (): string | undefined => resolveSecret(hubKeySource());

/** Normalises to an origin (no path, no trailing slash). Throws a readable error unless https (or localhost). */
export function normalizeHubUrl(input: string): string {
  if (!validHubUrl(input)) throw new Error("the hub URL must be https:// (plain http is only allowed for localhost)");
  return new URL(input).origin;
}

export interface HubSettings { enabled: boolean; url: string; reportIntervalSeconds: number; remoteAccess: boolean }

/** Read fresh (not from the startup snapshot) so `factory hub connect` takes effect in a running service without a restart. */
export function readHubSettings(configDir?: string): HubSettings {
  const dir = configDir && resolve(configDir) !== resolve(BUNDLED_CONFIG_DIR) ? configDir : defaultConfigDir();
  const { hub } = loadConfig(dir).factory;
  return { enabled: hub.enabled, url: hub.url, reportIntervalSeconds: hub.reportIntervalSeconds, remoteAccess: hub.remoteAccess };
}

/** Writes the hub block of the user's own factory.yaml (seeding it from the shipped defaults first), keeping comments. */
export function writeHubSettings(patch: { enabled?: boolean; url?: string; remoteAccess?: boolean }, configDir: string): string {
  const dir = resolve(configDir) === resolve(BUNDLED_CONFIG_DIR) ? seedHomeConfig() : configDir;
  const file = join(dir, "factory.yaml");
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  if (patch.enabled !== undefined) doc.setIn(["hub", "enabled"], patch.enabled);
  if (patch.remoteAccess !== undefined) doc.setIn(["hub", "remoteAccess"], patch.remoteAccess);
  if (patch.url !== undefined) doc.setIn(["hub", "url"], patch.url);
  writeFileSync(file, doc.toString());
  return dir;
}
