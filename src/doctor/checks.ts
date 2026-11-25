import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { totalmem } from "node:os";
import type { LoadedConfig } from "../config/schema.js";
import { createLinearClient, type LinearClient } from "../linear/client.js";

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

/** Each route that uses the local model must name a model the server really reports. */
export async function checkLocalRoutes(config: LoadedConfig, fetchImpl: typeof fetch = fetch): Promise<CheckResult[]> {
  const local = Object.entries(config.models.routes).filter(([, r]) => r.provider === "local");
  if (local.length === 0) return [];
  let ids: string[] = [];
  try {
    const res = await fetchImpl(`${config.models.local.baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
    ids = res.ok ? (((await res.json()) as { data?: { id: string }[] }).data ?? []).map((m) => m.id) : [];
  } catch { /* reported by checkLocalModels */ }
  return local.map(([task, r]) => {
    if (/^UNCONFIGURED/i.test(r.model)) return { name: `route ${task}`, status: "warn" as const, detail: "local model id not configured in config/models.yaml" };
    return ids.includes(r.model)
      ? { name: `route ${task}`, status: "ok" as const, detail: `${r.model} is available` }
      : { name: `route ${task}`, status: "fail" as const, detail: `${r.model} is not reported by the local server${ids.length ? ` (has: ${ids.join(", ")})` : ""}` };
  });
}

/** Read-only: asks Linear who the key belongs to. Reports the account name, never the key. */
export async function checkLinear(config: LoadedConfig, clientOverride?: LinearClient): Promise<CheckResult> {
  const key = process.env[config.linear.apiKeyEnv];
  if (!clientOverride && !key) return { name: "linear", status: "warn", detail: `${config.linear.apiKeyEnv} not set` };
  try {
    const me = await (clientOverride ?? createLinearClient({ apiKey: key!, maxRetries: 1 })).viewer();
    return { name: "linear", status: "ok", detail: `authenticated as ${me.name}` };
  } catch (e) {
    return { name: "linear", status: "fail", detail: (e as Error).message };
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
    ...(await checkLocalRoutes(config, fetchImpl)),
  ];
  results.push(await checkLinear(config));
  return results;
}
