import { createHash } from "node:crypto";
import { BUILTIN_CAPABILITIES, TOOL_TASKS } from "./capabilities.js";
import type { PluginInstance } from "./types.js";

/**
 * Route resolution: a route names a plugin INSTANCE (`{ plugin: <instance id>, model }`). Routes written the old way
 * (`{ provider: anthropic | local, model, baseUrl?, apiKeyEnv? }`) are migrated here, on read, to the instance they always meant.
 * Nothing is rewritten on disk and behaviour is identical.
 */

/** What a legacy `provider:` meant. */
/** The instance ids every profile has: Claude Code, and the shared local server (`local.baseUrl`). A `plugins:` entry of the same id wins. */
export const CLAUDE_INSTANCE = "claude-code";
export const LOCAL_INSTANCE = "local";

export interface RouteLike { plugin?: string; provider?: string; model: string; baseUrl?: string; apiKeyEnv?: string }
export interface ModelsLike { local: { baseUrl: string }; plugins?: Record<string, PluginInstance> }
export interface ResolvedRoute { instance: string; plugin: string; model: string }

/** Every instance a route may name: the two built-in defaults, then the user's `plugins:` block. */
export const instancesOf = (m: ModelsLike): Record<string, PluginInstance> => ({
  [CLAUDE_INSTANCE]: { plugin: "claude-code", settings: {} },
  [LOCAL_INSTANCE]: { plugin: "openai-compatible", settings: { baseUrl: m.local.baseUrl } },
  ...(m.plugins ?? {}),
});

/** A legacy local route with its own endpoint (the independent reviewer) becomes an anonymous openai-compatible instance. */
const endpointId = (baseUrl: string, apiKeyEnv?: string) => `openai-compatible-${createHash("sha1").update(`${baseUrl}\n${apiKeyEnv ?? ""}`).digest("hex").slice(0, 8)}`;

/** Which instance a route means, and its settings. Throws no error: `undefined` instance = the route names one that is not defined. */
export function instanceOfRoute(m: ModelsLike, r: RouteLike): { id: string; instance?: PluginInstance } {
  if (r.provider !== undefined) {
    if (r.provider === "local" && r.baseUrl) return { id: endpointId(r.baseUrl, r.apiKeyEnv), instance: { plugin: "openai-compatible", settings: { baseUrl: r.baseUrl, ...(r.apiKeyEnv ? { apiKeyEnv: r.apiKeyEnv } : {}) } } };
    const id = r.provider === "local" ? LOCAL_INSTANCE : CLAUDE_INSTANCE;
    return { id, instance: instancesOf(m)[id] };
  }
  return { id: r.plugin ?? "", instance: instancesOf(m)[r.plugin ?? ""] };
}

/** Whether a route's plugin declares tool access. Unknown plugins count as capable here: the registry judges them at run time. */
export function routeHasTools(m: ModelsLike, r: RouteLike): boolean {
  const inst = instanceOfRoute(m, r).instance;
  const caps = inst ? BUILTIN_CAPABILITIES[inst.plugin] : undefined;
  return caps ? caps.tools : true;
}

export const TOOL_TASK_MESSAGE = "specification, implementation and prompt_generation need file and shell tools, so they must use provider `anthropic` (Claude Code) or another plugin that declares tool access";
export const isToolTask = (t: string): boolean => (TOOL_TASKS as readonly string[]).includes(t);
