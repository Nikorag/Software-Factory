import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { totalmem } from "node:os";
import type { LoadedConfig } from "../config/schema.js";
import { findBinary } from "../speckit/tools.js";
import { resolveSecret } from "../service/secrets.js";
import { createLinearClient, type LinearClient } from "../linear/client.js";
import { createTrackerClient, trackerConfigured, trackerIdsInUse } from "../tracker/index.js";

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
    return [{ name: "local models", status: "fail", detail: `no server reachable at ${baseUrl} (start your local model server)` }];
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

const usesLocal = (c: LoadedConfig) => Object.values(c.models.routes).some((r) => r.provider === "local");

/** The local model server is only checked (and only required) when a route actually uses it. */
async function localChecks(config: LoadedConfig, fetchImpl: typeof fetch): Promise<CheckResult[]> {
  if (!usesLocal(config)) return [{ name: "local models", status: "ok", detail: "no route uses a local model (Claude only)" }];
  return [...(await checkLocalModels(config.models.local.baseUrl, fetchImpl)), ...(await checkLocalRoutes(config, fetchImpl))];
}

/** A reviewer that is the same model as the author is not independent. */
export function reviewerIndependence(config: LoadedConfig): CheckResult[] {
  const { specification: a, independent_review: r } = config.models.routes;
  return a.provider === r.provider && a.model === r.model
    ? [{ name: "reviewer independence", status: "warn", detail: `independent_review uses the same model as specification (${r.model}); pick a different one` }]
    : [{ name: "reviewer independence", status: "ok", detail: `${r.provider}/${r.model} reviews ${a.provider}/${a.model}` }];
}

/** Read-only: asks Linear who the key belongs to. Reports the account name, never the key. */
export async function checkLinear(config: LoadedConfig, clientOverride?: LinearClient, id: string = config.factory.tracker): Promise<CheckResult> {
  const conn = config.connections[id];
  if (!conn) return { name: id, status: "fail", detail: `no tracker connection "${id}"` };
  // The built-in connections keep their original names ("linear", "jira", "github-issues"); any other is named by its id.
  const name = id === "github" ? "github-issues" : id;
  if (conn.kind === "jira" || conn.kind === "github") {
    try {
      if (!clientOverride && !trackerConfigured(config, undefined, id)) return { name, status: "warn", detail: "not connected: set up the OAuth app and connect in Settings → Trackers" };
      const me = await (clientOverride ?? createTrackerClient(config, { id })).viewer();
      return { name, status: "ok", detail: `authenticated as ${me.name}` };
    } catch (e) { return { name, status: "fail", detail: (e as Error).message }; }
  }
  const key = resolveSecret({ envName: conn.apiKeyEnv, keychainService: conn.keychainService });
  if (!clientOverride && !key) return { name, status: "warn", detail: `${conn.apiKeyEnv} not set and no keychain entry "${conn.keychainService}"` };
  try {
    const me = await (clientOverride ?? createLinearClient({ apiKey: key!, maxRetries: 1 })).viewer();
    return { name, status: "ok", detail: `authenticated as ${me.name}` };
  } catch (e) {
    return { name, status: "fail", detail: (e as Error).message };
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
    ...(config.factory.workflow.planning_mode === "speckit" ? [await tool("specify (SpecKit)", findBinary("specify") ?? "specify", ["--version"], false)] : []), // only the speckit planning mode needs it
    ...(await localChecks(config, fetchImpl)),
    ...reviewerIndependence(config),
  ];
  for (const id of trackerIdsInUse(config)) results.push(await checkLinear(config, undefined, id)); // every tracker connection a project uses
  return results;
}
