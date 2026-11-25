import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { totalmem } from "node:os";
import type { LoadedConfig } from "../config/schema.js";

const run = promisify(execFile);

export type CheckStatus = "ok" | "warn" | "fail";
export interface CheckResult { name: string; status: CheckStatus; detail: string }

async function cmd(bin: string, args: string[], timeout = 10_000): Promise<string> {
  const { stdout, stderr } = await run(bin, args, { timeout });
  return (stdout || stderr).trim();
}

async function tool(name: string, bin: string, args: string[], required = true): Promise<CheckResult> {
  try {
    return { name, status: "ok", detail: (await cmd(bin, args)).split("\n")[0] ?? "" };
  } catch {
    return { name, status: required ? "fail" : "warn", detail: `${bin} not found or failed` };
  }
}

export async function checkGitHubAuth(): Promise<CheckResult> {
  try {
    await cmd("gh", ["auth", "status"]); // output deliberately discarded: it can include account details
    return { name: "gh auth", status: "ok", detail: "authenticated" };
  } catch {
    return { name: "gh auth", status: "fail", detail: "run `gh auth login`" };
  }
}

/**
 * Probe an OpenAI-compatible endpoint. Reports what the server actually says;
 * never assumes a model exists. Read-only GET.
 */
export async function checkLocalModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<CheckResult[]> {
  try {
    const res = await fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [{ name: "local models", status: "fail", detail: `GET ${baseUrl}/models -> HTTP ${res.status}` }];
    const body = (await res.json()) as { data?: { id: string }[] };
    const ids = (body.data ?? []).map((m) => m.id);
    return [{ name: "local models", status: ids.length ? "ok" : "warn", detail: ids.length ? ids.join(", ") : "server up but no models listed" }];
  } catch {
    return [{ name: "local models", status: "fail", detail: `no server reachable at ${baseUrl} (start the Bionic API server)` }];
  }
}

export async function runDoctor(config: LoadedConfig, fetchImpl: typeof fetch = fetch): Promise<CheckResult[]> {
  const memGb = Math.round(totalmem() / 1024 ** 3);
  const results: CheckResult[] = [
    { name: "node", status: Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "fail", detail: process.version },
    { name: "memory", status: memGb >= 24 ? "ok" : "warn", detail: `${memGb} GB unified` },
    await tool("pnpm", "pnpm", ["-v"]),
    await tool("git", "git", ["--version"]),
    await tool("gh", "gh", ["--version"]),
    await checkGitHubAuth(),
    await tool("claude", "claude", ["--version"]),
    await tool("specify (SpecKit)", "specify", ["version"], false),
    ...(await checkLocalModels(config.models.local.baseUrl, fetchImpl)),
  ];
  if (!process.env.LINEAR_API_KEY) {
    results.push({ name: "LINEAR_API_KEY", status: "warn", detail: "not set (needed from Milestone 4)" });
  }
  return results;
}
