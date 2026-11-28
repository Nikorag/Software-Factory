import { ConfigError } from "../config/load.js";
import type { AgentRequest, AgentResult } from "../agents/types.js";
import { ENGINE_API_VERSION, type PluginEnv, type PluginInfo, type PluginInstance, type PluginRuntime, type ProbeResult, type ProviderPlugin } from "./types.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `run()` never throws, whatever a plugin does: an escaped exception becomes a structured `error` result. */
export function guardRuntime(rt: PluginRuntime): PluginRuntime {
  return {
    provider: rt.provider,
    listModels: rt.listModels?.bind(rt),
    async run(req: AgentRequest): Promise<AgentResult> {
      try { return await rt.run(req); }
      catch (e) { return { ok: false, text: "", denials: [], exitCode: null, durationMs: 0, failure: req.signal?.aborted ? "cancelled" : "error", error: `plugin ${rt.provider} failed: ${(e as Error).message}` }; }
    },
  };
}

export const compatible = (p: Pick<ProviderPlugin, "engineApi">): boolean => p.engineApi.min <= ENGINE_API_VERSION && ENGINE_API_VERSION <= p.engineApi.max;

/** Every plugin the factory knows: the built-ins and any passed in at composition time. Adding one touches nothing else. */
export class PluginRegistry {
  private readonly plugins = new Map<string, { plugin: ProviderPlugin<never>; builtin: boolean }>();
  private readonly runtimes = new Map<string, PluginRuntime>();
  constructor(private readonly env: PluginEnv = { env: process.env }) {}

  register<S>(plugin: ProviderPlugin<S>, builtin = false): this {
    if (!ID.test(plugin.id)) throw new ConfigError(`plugin id "${plugin.id}" must be lowercase letters, numbers and hyphens`);
    if (this.plugins.has(plugin.id)) throw new ConfigError(`plugin "${plugin.id}" is already registered`);
    this.plugins.set(plugin.id, { plugin: plugin as unknown as ProviderPlugin<never>, builtin });
    return this;
  }

  has(id: string): boolean { return this.plugins.has(id); }
  get(id: string): ProviderPlugin<never> | undefined { return this.plugins.get(id)?.plugin; }
  capabilities(id: string) { return this.get(id)?.capabilities; }

  /** Why a plugin cannot be used (not registered, incompatible engine API), or undefined when it can. */
  unavailable(id: string): string | undefined {
    const p = this.get(id);
    if (!p) return `plugin "${id}" is not installed (installed: ${[...this.plugins.keys()].join(", ")})`;
    if (!compatible(p)) return `plugin "${id}" ${p.version} needs engine API ${p.engineApi.min}-${p.engineApi.max}; this factory provides ${ENGINE_API_VERSION}`;
    return undefined;
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()].map(({ plugin: p, builtin }) => {
      const reason = this.unavailable(p.id);
      return { id: p.id, name: p.name, description: p.description, version: p.version, engineApi: p.engineApi, capabilities: p.capabilities, modelPresets: p.modelPresets ?? [], state: reason ? "incompatible" : "available", reason, builtin };
    });
  }

  /** Validates an instance's settings against its plugin. Returns the parsed settings, or throws a ConfigError saying what is wrong. */
  validate(id: string, inst: PluginInstance): unknown {
    const bad = this.unavailable(inst.plugin);
    if (bad) throw new ConfigError(`plugin instance "${id}": ${bad}`);
    const r = this.get(inst.plugin)!.settings.safeParse(inst.settings);
    if (!r.success) throw new ConfigError(`plugin instance "${id}" (${inst.plugin}) has invalid settings: ${r.error.issues.map((i) => `${i.path.join(".") || "(settings)"}: ${i.message}`).join("; ")}`);
    return r.data;
  }

  /** The runtime for an instance. Instances with identical plugin + settings share one runtime (and so one request queue). */
  runtime(id: string, inst: PluginInstance): PluginRuntime {
    const settings = this.validate(id, inst);
    const key = `${inst.plugin}\n${JSON.stringify(settings)}`;
    let rt = this.runtimes.get(key);
    if (!rt) this.runtimes.set(key, rt = guardRuntime(this.get(inst.plugin)!.create(settings as never, this.env)));
    return rt;
  }

  /** Validate an instance without a model call: settings schema first, then the plugin's own probe (reachability, model listing). */
  async check(id: string, inst: PluginInstance): Promise<ProbeResult> {
    let settings: unknown;
    try { settings = this.validate(id, inst); } catch (e) { return { ok: false, detail: (e as Error).message }; }
    const p = this.get(inst.plugin)!;
    if (!p.probe) return { ok: true, detail: "settings are valid" };
    try { return await p.probe(settings as never, this.env); } catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
}
