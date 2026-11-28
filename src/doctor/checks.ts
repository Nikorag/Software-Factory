import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { totalmem } from "node:os";
import type { LoadedConfig } from "../config/schema.js";
import { LocalModelClient } from "../agents/local.js";
import { createRegistry } from "../plugins/builtin/index.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { instanceOfRoute } from "../plugins/routes.js";
import { instancesInUse, type InstanceUse } from "../plugins/usage.js";
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

/** The settings of a plugin instance that lists models (an OpenAI-style endpoint), or why it cannot be used. */
function modelServer(u: InstanceUse, registry: PluginRegistry): { baseUrl: string; apiKeyEnv?: string } | { error: string } | null {
  if (!u.instance || !registry.capabilities(u.instance.plugin)?.listsModels) return null;
  try { return registry.validate(u.id, u.instance) as { baseUrl: string; apiKeyEnv?: string }; } catch (e) { return { error: (e as Error).message }; }
}

/** Each route on a plugin that lists models must name a model its server really reports. */
export async function checkLocalRoutes(config: LoadedConfig, fetchImpl: typeof fetch = fetch, registry: PluginRegistry = createRegistry()): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const u of instancesInUse(config.models)) {
    const s = modelServer(u, registry);
    if (!s) continue;
    if ("error" in s) { out.push(...u.tasks.map((t) => ({ name: `route ${t.task}`, status: "fail" as const, detail: s.error }))); continue; }
    let ids: string[] = [];
    try { ids = await new LocalModelClient({ baseUrl: s.baseUrl, apiKeyEnv: s.apiKeyEnv, fetch: fetchImpl }).listModels(); } catch { /* reported by checkLocalModels */ }
    for (const { task, model } of u.tasks) {
      if (/^UNCONFIGURED/i.test(model)) out.push({ name: `route ${task}`, status: "warn", detail: "local model id not configured in config/models.yaml" });
      else out.push(ids.includes(model)
        ? { name: `route ${task}`, status: "ok", detail: `${model} is available` }
        : { name: `route ${task}`, status: "fail", detail: `${model} is not reported by the server of plugin instance ${u.id}${ids.length ? ` (has: ${ids.join(", ")})` : ""}` });
    }
  }
  return out;
}

/**
 * Every plugin instance a route uses must exist, be installed and compatible, and have valid settings; those that serve models
 * are probed (read-only GET /models) and only checked (and only required) when a route actually uses them.
 */
export async function pluginChecks(config: LoadedConfig, fetchImpl: typeof fetch, registry: PluginRegistry): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const uses = instancesInUse(config.models);
  for (const u of uses) {
    const where = u.tasks.map((t) => t.task).join(", ");
    if (!u.instance) { out.push({ name: `plugin ${u.id}`, status: "fail", detail: `used by ${where} but not defined under \`plugins:\` in config/models.yaml` }); continue; }
    const bad = registry.unavailable(u.instance.plugin);
    if (bad) { out.push({ name: `plugin ${u.id}`, status: "fail", detail: bad }); continue; }
    try { registry.validate(u.id, u.instance); } catch (e) { out.push({ name: `plugin ${u.id}`, status: "fail", detail: (e as Error).message }); }
  }
  const servers = uses.map((u) => ({ u, s: modelServer(u, registry) })).filter((x): x is { u: InstanceUse; s: { baseUrl: string; apiKeyEnv?: string } } => !!x.s && !("error" in x.s));
  if (!uses.some((u) => u.instance && registry.capabilities(u.instance.plugin)?.listsModels)) out.push({ name: "local models", status: "ok", detail: "no route uses a model server (Claude Code only)" });
  for (const { s } of servers) out.push(...(await checkLocalModels(s.baseUrl, fetchImpl)));
  return [...out, ...(await checkLocalRoutes(config, fetchImpl, registry))];
}

/** A reviewer that is the same model as the author is not independent. */
export function reviewerIndependence(config: LoadedConfig): CheckResult[] {
  const { specification: a, independent_review: r } = config.models.routes;
  if (!r) return [{ name: "reviewer independence", status: "ok", detail: "no independent reviewer set: the independent review step is skipped" }];
  const [ai, ri] = [instanceOfRoute(config.models, a).id, instanceOfRoute(config.models, r).id];
  return ai === ri && a.model === r.model
    ? [{ name: "reviewer independence", status: "warn", detail: `independent_review uses the same model as specification (${r.model}); pick a different one` }]
    : [{ name: "reviewer independence", status: "ok", detail: `${ri}/${r.model} reviews ${ai}/${a.model}` }];
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

export async function runDoctor(config: LoadedConfig, fetchImpl: typeof fetch = fetch, registry: PluginRegistry = createRegistry()): Promise<CheckResult[]> {
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
    ...(await pluginChecks(config, fetchImpl, registry)),
    ...reviewerIndependence(config),
  ];
  for (const id of trackerIdsInUse(config)) results.push(await checkLinear(config, undefined, id)); // every tracker connection a project uses
  return results;
}
