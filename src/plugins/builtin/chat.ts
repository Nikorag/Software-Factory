import { z } from "zod";
import { LocalModelClient } from "../../agents/local.js";
import { validHubUrl } from "../../config/schema.js";
import { CHAT_API_CAPABILITIES } from "../capabilities.js";
import { ENGINE_API_VERSION, type PluginEnv, type ProviderPlugin } from "../types.js";

/** The NAME of an environment variable. A key value is never accepted in settings. */
export const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name (the key itself is never stored)").max(100);

const KEY_OVER_HTTP = "baseUrl must be https (http only for localhost) when an API key is configured, so the key is never sent in cleartext";

export interface ChatSettings { baseUrl: string; apiKeyEnv?: string }

interface ChatSpec {
  id: string; name: string; description: string; label: string; defaultBaseUrl: string; defaultApiKeyEnv?: string;
}

/**
 * One implementation for every OpenAI-style chat endpoint (`/chat/completions`, `/models`): the plugins differ only in
 * their default endpoint and key handling. Strictly sequential and read-only: it has no tools (`LocalModelClient`).
 */
export function chatPlugin(spec: ChatSpec): ProviderPlugin<ChatSettings> {
  const settings = z.object({
    baseUrl: z.string().url().default(spec.defaultBaseUrl),
    apiKeyEnv: spec.defaultApiKeyEnv ? EnvName.default(spec.defaultApiKeyEnv) : EnvName.optional(),
  }).strict().refine((s) => !s.apiKeyEnv || validHubUrl(s.baseUrl), { message: KEY_OVER_HTTP, path: ["baseUrl"] });
  const client = (s: ChatSettings, e: PluginEnv) => new LocalModelClient({ baseUrl: s.baseUrl, apiKeyEnv: s.apiKeyEnv, env: e.env, fetch: e.fetch, label: spec.label });
  return {
    id: spec.id, name: spec.name, description: spec.description, version: "1.0.0",
    engineApi: { min: ENGINE_API_VERSION, max: ENGINE_API_VERSION },
    capabilities: CHAT_API_CAPABILITIES,
    settings,
    create: (s, e) => client(s, e),
    async probe(s, e) {
      if (s.apiKeyEnv && !(e.env[s.apiKeyEnv])) return { ok: false, detail: `the environment variable ${s.apiKeyEnv} is not set` };
      try {
        const models = await client(s, e).listModels();
        return { ok: true, models, detail: models.length ? `reachable; ${models.length} model(s) listed` : "reachable but no models listed" };
      } catch (err) { return { ok: false, detail: (err as Error).message }; }
    },
  };
}
