import type { z } from "zod";
import type { Agent, AgentRequest, AgentResult } from "../agents/types.js";

/**
 * The plugin contract. The workflow engine talks to a provider only through this: Engine -> router/runner -> plugin -> backend.
 * A plugin is code the factory ships (or that is passed in at composition time); it is NEVER loaded from config, because
 * loading would run arbitrary code. Config only names a plugin and supplies its settings (see `PluginInstance`).
 */

/** Bumped when this contract changes incompatibly. A plugin declares the range of engine API versions it works with. */
export const ENGINE_API_VERSION = 1;

/** How a plugin executes: a local command-line tool (Claude Code, Codex...) or direct model inference over an API. */
export type ExecutionKind = "cli" | "api";

/** What a plugin can do. The engine reads these instead of assuming every provider is the same. */
export interface PluginCapabilities {
  kind: ExecutionKind;
  /** Can read files and run commands in the worktree (needed by specification, implementation and prompt_generation). */
  tools: boolean;
  /** Can change files in the worktree. Only meaningful with `tools`. A plugin without it only ever serves the read-only profile. */
  writesWorktree: boolean;
  /** Can return schema-constrained output (`AgentRequest.jsonSchema`). */
  structuredOutput: boolean;
  /** Can stream incremental output. Optional: the engine never relies on it. */
  streaming: boolean;
  /** Can list the models/targets it offers (`listModels`). */
  listsModels: boolean;
  /** Serves the read-only profile (reviews, classification). Every built-in does. */
  readOnly: boolean;
  /** Needs a secret, named by an environment variable in its settings. The value is never stored. */
  usesApiKey: boolean;
}

export interface EngineRange { min: number; max: number }

/** A running provider: an `Agent` plus optional model discovery. `run()` must never throw: failures come back as `AgentResult.failure`. */
export interface PluginRuntime extends Agent {
  listModels?(timeoutMs?: number): Promise<string[]>;
}

export interface PluginEnv { env: NodeJS.ProcessEnv; fetch?: typeof fetch }

export interface ProbeResult {
  /** Settings are usable and (where the plugin can tell without a model call) the backend is reachable. */
  ok: boolean;
  detail: string;
  /** Models the backend reports, when it can list them. */
  models?: string[];
}

export interface ProviderPlugin<S = unknown> {
  /** Stable id: what a plugin instance's `plugin:` field names. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  /** The engine API versions this plugin works with (inclusive). */
  readonly engineApi: EngineRange;
  readonly capabilities: PluginCapabilities;
  /** Model names worth offering as one-click choices (e.g. Claude Code's aliases). Free text is always allowed too. */
  readonly modelPresets?: readonly string[];
  /** Validates (and fills defaults for) an instance's settings. Unknown settings are rejected. */
  readonly settings: z.ZodType<S>;
  /** Builds the runtime for validated settings. Must not do I/O. */
  create(settings: S, env: PluginEnv): PluginRuntime;
  /**
   * Checks the settings and, where possible, reachability, WITHOUT a model call (e.g. GET /models, `claude --version`).
   * Optional: without it a plugin is only validated against its settings schema.
   */
  probe?(settings: S, env: PluginEnv): Promise<ProbeResult>;
}

/** A named, reusable configuration of one plugin. Workflow routes reference the instance id, so a provider is configured once. */
export interface PluginInstance { plugin: string; settings: Record<string, unknown> }

export type PluginState = "available" | "incompatible" | "misconfigured";
export interface PluginInfo {
  id: string; name: string; description?: string; version: string; engineApi: EngineRange; capabilities: PluginCapabilities;
  modelPresets: readonly string[];
  state: PluginState;
  /** Why the plugin is not available (incompatible engine API, invalid settings). */
  reason?: string;
  builtin: boolean;
}

export type { AgentRequest, AgentResult };
