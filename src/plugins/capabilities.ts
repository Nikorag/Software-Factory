import type { PluginCapabilities } from "./types.js";

/** Capabilities of the built-in plugins as plain data, so config validation can gate routes without building a registry. */
export const CLAUDE_CODE_CAPABILITIES: PluginCapabilities = {
  kind: "cli", tools: true, writesWorktree: true, structuredOutput: true, streaming: false, listsModels: false, readOnly: true, usesApiKey: false,
};

/** A chat-completions client: no tools, read-only, sequential. */
export const CHAT_API_CAPABILITIES: PluginCapabilities = {
  kind: "api", tools: false, writesWorktree: false, structuredOutput: true, streaming: false, listsModels: true, readOnly: true, usesApiKey: true,
};

export const BUILTIN_CAPABILITIES: Record<string, PluginCapabilities> = {
  "claude-code": CLAUDE_CODE_CAPABILITIES,
  "openai-compatible": CHAT_API_CAPABILITIES,
  openai: CHAT_API_CAPABILITIES,
};

/** The tasks that need file and shell tools (they read the repository or write files). Everything else is read-only text in, JSON out. */
export const TOOL_TASKS = ["specification", "implementation", "prompt_generation"] as const;
