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
