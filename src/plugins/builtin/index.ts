import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { ClaudeCodeAgent } from "../../agents/claude.js";
import { PluginRegistry } from "../registry.js";
import { CLAUDE_CODE_CAPABILITIES } from "../capabilities.js";
import { ENGINE_API_VERSION, type PluginEnv, type ProviderPlugin } from "../types.js";
import { chatPlugin } from "./chat.js";

const exec = promisify(execFile);

/** Claude Code CLI on the user's subscription login. Wraps `ClaudeCodeAgent` unchanged; its permission profiles live there. */
export function claudeCodePlugin(o: { bin?: string } = {}): ProviderPlugin<Record<string, never>> {
  return {
    id: "claude-code", name: "Claude Code", description: "The locally installed Claude Code CLI (your subscription login, no API key). Model: default, an alias (haiku, sonnet, opus) or a full id.",
    version: "1.0.0", engineApi: { min: ENGINE_API_VERSION, max: ENGINE_API_VERSION },
    capabilities: CLAUDE_CODE_CAPABILITIES, modelPresets: ["default", "haiku", "sonnet", "opus"],
    settings: z.object({}).strict() as z.ZodType<Record<string, never>>,
    create: (_s, _e: PluginEnv) => new ClaudeCodeAgent({ bin: o.bin }),
    async probe() {
      const bin = o.bin ?? "claude";
      try { const { stdout } = await exec(bin, ["--version"], { timeout: 10_000 }); return { ok: true, detail: stdout.trim().split("\n")[0] ?? "installed" }; }
      catch { return { ok: false, detail: `${bin} not found or failed (install Claude Code and run \`claude\` then /login)` }; }
    },
  };
}

export const openAiCompatiblePlugin = (): ProviderPlugin<{ baseUrl: string; apiKeyEnv?: string }> => chatPlugin({
  id: "openai-compatible", name: "OpenAI-compatible server", label: "local model", defaultBaseUrl: "http://127.0.0.1:1234/v1",
  description: "Any OpenAI-compatible chat endpoint: LM Studio, llama.cpp, Ollama, a hosted gateway. Read-only (no tools). Optional apiKeyEnv names the environment variable holding a bearer key.",
});

export const openAiPlugin = (): ProviderPlugin<{ baseUrl: string; apiKeyEnv?: string }> => chatPlugin({
  id: "openai", name: "OpenAI API", label: "OpenAI API", defaultBaseUrl: "https://api.openai.com/v1", defaultApiKeyEnv: "OPENAI_API_KEY",
  description: "The OpenAI API (key from the OPENAI_API_KEY environment variable by default). Read-only (no tools). baseUrl may point at an alternative endpoint.",
});

/** The registry every factory starts with, plus any plugins passed in at composition time. */
export function createRegistry(o: { claudeBin?: string; extra?: ProviderPlugin<unknown>[]; env?: PluginEnv } = {}): PluginRegistry {
  const r = new PluginRegistry(o.env)
    .register(claudeCodePlugin({ bin: o.claudeBin }), true)
    .register(openAiCompatiblePlugin(), true)
    .register(openAiPlugin(), true);
  for (const p of o.extra ?? []) r.register(p);
  return r;
}
