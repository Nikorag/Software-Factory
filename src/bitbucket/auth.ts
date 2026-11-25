import type { BitbucketConfig } from "../config/schema.js";
import type { SecretStore } from "../jira/auth.js";
import { keychainStore } from "../tracker/index.js";

export const BB_API = "https://api.bitbucket.org/2.0";
export const BB_HOST = "https://bitbucket.org/";

export class BitbucketAuthError extends Error {
  constructor(message: string) { super(message); this.name = "BitbucketAuthError"; }
}

/** A credential ready to use. `access-token`: a repository/project/workspace access token. `api-token`: an Atlassian account API token. */
export interface BbCredential { kind: "access-token" | "api-token"; email?: string; token: string }

/** REST: an access token is a Bearer token; an API token is HTTP Basic with the Atlassian account email (Atlassian's documented scheme). */
export const authHeader = (c: BbCredential): string => (c.kind === "api-token" ? `Basic ${Buffer.from(`${c.email}:${c.token}`).toString("base64")}` : `Bearer ${c.token}`);

/** Git over HTTPS uses a fixed username with the token as the password. */
export const gitUser = (c: BbCredential): string => (c.kind === "api-token" ? "x-bitbucket-api-token-auth" : "x-token-auth");

/**
 * Environment that authenticates git's HTTPS operations to Bitbucket for one child process. GIT_CONFIG_* env vars (not arguments) so the token
 * never shows in `ps`, and nothing is written to the repository's config. Mirrors the GitHub equivalent.
 */
export function gitEnv(c: BbCredential): NodeJS.ProcessEnv {
  const basic = Buffer.from(`${gitUser(c)}:${c.token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", // do not consult other stored credentials
    GIT_CONFIG_KEY_1: `http.${BB_HOST}.extraheader`, GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

export const bbStore = (service: string): SecretStore => keychainStore(service, "SOFTWARE_FACTORY_BITBUCKET_TOKEN_");

/** The named credential, with its token from the keychain (or SOFTWARE_FACTORY_BITBUCKET_TOKEN_<NAME>). Says exactly what is missing. */
export function resolveCredential(config: { bitbucket: BitbucketConfig }, name: string, store: SecretStore = bbStore(config.bitbucket.keychainService)): BbCredential {
  const meta = config.bitbucket.credentials[name];
  if (!meta) throw new BitbucketAuthError(`no Bitbucket credential named "${name}": add it in Settings → Integrations → Bitbucket`);
  const token = store.get(name);
  if (!token) throw new BitbucketAuthError(`the Bitbucket credential "${name}" has no token saved: paste it in Settings → Integrations → Bitbucket`);
  return { kind: meta.kind, email: meta.email, token };
}
