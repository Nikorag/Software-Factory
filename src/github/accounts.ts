import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface GhAccount { login: string; active: boolean }

/** The GitHub accounts `gh` is logged in to (never their tokens). Parsed from `gh auth status`, which lists each login. */
export function parseGhAccounts(text: string): GhAccount[] {
  const out: GhAccount[] = [];
  let cur: GhAccount | null = null;
  for (const line of text.split("\n")) {
    const m = /Logged in to \S+ account (\S+)/.exec(line);
    if (m) { cur = { login: m[1]!, active: false }; out.push(cur); continue; }
    if (cur && /Active account:\s*true/i.test(line)) cur.active = true;
  }
  return out;
}

export async function listGhAccounts(run: (f: string, a: string[]) => Promise<string> = async (f, a) => { const r = await exec(f, a, { timeout: 10_000 }).catch((e) => e as { stdout?: string; stderr?: string }); return `${r.stdout ?? ""}\n${r.stderr ?? ""}`; }): Promise<GhAccount[]> {
  return parseGhAccounts(await run("gh", ["auth", "status"]));
}
