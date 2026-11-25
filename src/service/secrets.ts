import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

export interface SecretSource { envName: string; keychainService?: string; keychainAccount?: string }
type Runner = (file: string, args: string[]) => string;
const cache = new Map<string, string>();

/**
 * Environment first, then the macOS keychain. A LaunchAgent has no shell environment, so the background service reads the
 * Linear key from the keychain entry the user already created (`security add-generic-password -s software-factory-linear`).
 * The value is held in memory only: never written to config, the database, or logs.
 */
export function resolveSecret(src: SecretSource, deps: { env?: NodeJS.ProcessEnv; run?: Runner } = {}): string | undefined {
  const fromEnv = (deps.env ?? process.env)[src.envName];
  if (fromEnv) return fromEnv;
  if (!src.keychainService || process.platform !== "darwin") return undefined;
  const account = src.keychainAccount ?? userInfo().username;
  if (!deps.run && process.env.FACTORY_NO_KEYCHAIN) return undefined; // the test suite must never read the developer's real keychain
  const key = `${src.keychainService}\0${account}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const run: Runner = deps.run ?? ((f, a) => execFileSync(f, a, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }));
    const v = run("/usr/bin/security", ["find-generic-password", "-a", account, "-s", src.keychainService, "-w"]).trim();
    if (v) { cache.set(key, v); return v; }
  } catch { /* not in the keychain, or access denied */ }
  return undefined;
}
export const forgetSecrets = () => cache.clear();
