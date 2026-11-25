import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const tokens = new Map<string, Promise<string | null>>();

/**
 * Environment for running `gh` as a specific account, without switching the machine's active gh login.
 * The token is read from gh's own credential store at call time and lives only in the child's environment:
 * it is never written to config, the database or logs. With no account, gh uses its active login.
 */
export async function ghEnv(account?: string): Promise<NodeJS.ProcessEnv> {
  if (!account) return { ...process.env, GH_PROMPT_DISABLED: "1" };
  let t = tokens.get(account);
  if (!t) {
    t = exec("gh", ["auth", "token", "--user", account], { timeout: 10_000 }).then((r) => r.stdout.trim() || null, () => null);
    tokens.set(account, t);
  }
  const token = await t;
  if (!token) throw new GhAccountError(account);
  return { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: "1" };
}

export class GhAccountError extends Error {
  constructor(readonly account: string) {
    super(`gh has no login for account "${account}" (run \`gh auth login\`)`);
    this.name = "GhAccountError";
  }
}

export const forgetGhTokens = () => tokens.clear();

/**
 * Environment that authenticates git's HTTPS operations to github.com as `account`, for one child process.
 * Uses GIT_CONFIG_* env vars (not command-line args) so the token never appears in `ps`, and nothing is
 * written to the repository's config. With no account, returns undefined and git uses its normal credentials.
 */
export async function gitAuthEnv(account?: string, tokenFor: (a: string) => Promise<string> = async (a) => (await ghEnv(a)).GH_TOKEN!): Promise<NodeJS.ProcessEnv | undefined> {
  if (!account) return undefined;
  const basic = Buffer.from(`x-access-token:${await tokenFor(account)}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", // don't consult other stored credentials
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}
