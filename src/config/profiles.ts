import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { BUNDLED_CONFIG_DIR } from "./load.js";

/**
 * Profiles are isolated factory instances: each has its own config, database, clones, worktrees, logs, port and Linear key, and they run
 * side by side. "default" is the original install (its home is the root itself), so existing data needs no migration.
 * The registry (profiles.json, in the root) is the only thing they share: it lets each one list the others.
 */
export interface Profile { name: string; home: string; port: number }
export const DEFAULT_PROFILE = "default";
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const FIRST_EXTRA_PORT = 4781;

export const factoryRoot = (): string => process.env.FACTORY_ROOT ?? join(homedir(), ".software-factory");
const registryFile = (root: string) => join(root, "profiles.json");

function readPort(home: string): number {
  try { return Number((parse(readFileSync(join(home, "config", "factory.yaml"), "utf8")) as { server?: { port?: number } })?.server?.port) || 4780; } catch { return 4780; }
}

function load(root: string): Profile[] {
  let extra: Profile[] = [];
  try { extra = (JSON.parse(readFileSync(registryFile(root), "utf8")) as { profiles?: Profile[] }).profiles ?? []; } catch { /* no registry yet */ }
  return [{ name: DEFAULT_PROFILE, home: root, port: readPort(root) }, ...extra.filter((p) => p.name !== DEFAULT_PROFILE)];
}

/** Every profile, the default one first. Also (re)writes the registry so other processes (the desktop app) can read the ports. */
export function listProfiles(root = factoryRoot()): Profile[] {
  const all = load(root);
  save(root, all);
  return all;
}

function save(root: string, all: Profile[]): void {
  mkdirSync(root, { recursive: true });
  const file = registryFile(root);
  const text = `${JSON.stringify({ profiles: all }, null, 2)}\n`;
  try { if (readFileSync(file, "utf8") === text) return; } catch { /* write it */ }
  writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file);
}

export class ProfileError extends Error {}

export function getProfile(name: string, root = factoryRoot()): Profile {
  const p = listProfiles(root).find((x) => x.name === name);
  if (!p) throw new ProfileError(`no such profile "${name}" (profiles: ${listProfiles(root).map((x) => x.name).join(", ")})`);
  return p;
}

/** Creates a profile: its own home, config seeded from the shipped defaults, the next free port, and its own keychain entry for the Linear key. */
export function addProfile(name: string, root = factoryRoot(), defaults = BUNDLED_CONFIG_DIR): Profile {
  if (!NAME.test(name)) throw new ProfileError("a profile name is 1-31 characters: lowercase letters, numbers and hyphens, starting with a letter or number");
  const all = listProfiles(root);
  if (all.some((p) => p.name === name)) throw new ProfileError(`profile "${name}" already exists`);
  const used = new Set(all.map((p) => p.port));
  let port = FIRST_EXTRA_PORT;
  while (used.has(port)) port++;
  const home = join(root, "profiles", name);
  const cfg = join(home, "config");
  mkdirSync(cfg, { recursive: true });
  for (const f of ["models.yaml", "workflows.yaml", "projects.yaml"]) if (!existsSync(join(cfg, f)) && existsSync(join(defaults, f))) writeFileSync(join(cfg, f), readFileSync(join(defaults, f)));
  writeFileSync(join(cfg, "factory.yaml"), `# Profile "${name}": its own data, projects, Linear key and port.\nserver: { port: ${port} }\n`);
  writeFileSync(join(cfg, "linear.yaml"), `# This profile's Linear key has its own keychain entry and its own environment variable, so a LINEAR_API_KEY exported in your shell\n# (for another profile) is never picked up here.\napiKeyEnv: LINEAR_API_KEY_${name.toUpperCase().replace(/-/g, "_")}\nkeychainService: software-factory-linear-${name}\n`);
  writeFileSync(join(cfg, "jira.yaml"), `# Used when this profile's tracker is Jira (factory.yaml: tracker: jira). Its OAuth client secret and tokens are in this profile's own keychain entry.\nkeychainService: software-factory-jira-${name}\n`);
  writeFileSync(join(cfg, "bitbucket.yaml"), `# Bitbucket Cloud credentials for this profile (projects choose one by name). The tokens themselves are in this profile's own keychain service.\nkeychainService: software-factory-bitbucket-${name}\n`);
  const p: Profile = { name, home, port };
  save(root, [...all, p]);
  return p;
}

/** Forgets a profile. Its data directory is left on disk (delete it yourself if you want it gone). The default profile cannot be removed. */
export function removeProfile(name: string, root = factoryRoot()): void {
  if (name === DEFAULT_PROFILE) throw new ProfileError("the default profile cannot be removed");
  const all = listProfiles(root);
  if (!all.some((p) => p.name === name)) throw new ProfileError(`no such profile "${name}"`);
  save(root, all.filter((p) => p.name !== name));
}

/** Points this process at a profile: everything that follows (config, database, keychain service) is that profile's. */
export function activateProfile(name: string, root = factoryRoot()): Profile {
  const p = getProfile(name, root);
  process.env.FACTORY_ROOT = root;
  process.env.FACTORY_HOME = p.home;
  process.env.FACTORY_PROFILE = p.name;
  return p;
}
