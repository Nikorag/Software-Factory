import type { ModelsConfig } from "../config/schema.js";
import { ConfigError } from "../config/load.js";
import { createRegistry } from "../plugins/builtin/index.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { CLAUDE_INSTANCE, instanceOfRoute, isToolTask, type ResolvedRoute, type RouteLike } from "../plugins/routes.js";
import type { PluginCapabilities } from "../plugins/types.js";
import type { Agent, AgentRequest, AgentResult } from "./types.js";

export type TaskKind = keyof ModelsConfig["routes"];
/** Where a task runs: the plugin instance (and its plugin) plus the model. The engine only ever sees this, never a backend. */
export type Route = ResolvedRoute;

/** Maps a task (classification, specification, …) to a plugin instance and model purely from config. */
export class ModelRouter {
  constructor(
    private readonly cfg: Pick<ModelsConfig, "routes"> & Partial<Pick<ModelsConfig, "plugins" | "local">>,
    /** Ready-made agents by plugin instance id (tests substitute scripted ones). Instances not listed are built by the plugin registry. */
    private readonly agents: Record<string, Agent> = {},
    /** A project's own model choices (settings > Projects > Overrides). Anything it leaves out follows the global routes. */
    private readonly overrides?: (projectId: string) => Partial<ModelsConfig["routes"]> | undefined,
    readonly registry: PluginRegistry = createRegistry(),
  ) {}

  private get models() { return { local: this.cfg.local ?? { baseUrl: "http://127.0.0.1:1234/v1" }, plugins: this.cfg.plugins ?? {} }; }

  /** The independent reviewer for a project, or null when none is set (null in a project override also means none). */
  reviewer(projectId?: string): RouteLike | null {
    const o = projectId ? this.overrides?.(projectId)?.independent_review : undefined;
    return (o !== undefined ? o : this.cfg.routes.independent_review) ?? null;
  }

  private raw(task: TaskKind, projectId?: string): RouteLike {
    const r = task === "independent_review" ? this.reviewer(projectId) : ((projectId ? this.overrides?.(projectId)?.[task] : undefined) ?? this.cfg.routes[task]);
    if (!r) throw new ConfigError("no independent reviewer is configured");
    return r;
  }

  /** What the plugin behind a route can do (so callers never need to know which plugin it is). */
  capabilities(route: Route): PluginCapabilities {
    const caps = this.registry.capabilities(route.plugin);
    if (!caps) throw new ConfigError(`plugin "${route.plugin}" is not installed`);
    return caps;
  }

  /**
   * Whether the independent reviewer for a project may fall back to a fresh reviewer when it is unavailable. Keyed off the
   * plugin's declared execution kind: an API endpoint can be down or unconfigured, a CLI agent's failure is just a failure.
   * An instance that is not defined or not installed counts as an unavailable endpoint.
   */
  reviewerCanFallBack(projectId?: string): boolean {
    const r = this.reviewer(projectId);
    if (!r) return false;
    const { instance } = instanceOfRoute(this.models, r);
    const caps = instance ? this.registry.capabilities(instance.plugin) : undefined;
    return caps ? caps.kind === "api" : true;
  }

  route(task: TaskKind, projectId?: string): Route {
    const r = this.raw(task, projectId);
    const { id, instance } = instanceOfRoute(this.models, r);
    if (!instance) throw new ConfigError(`models.yaml: route "${task}" uses plugin instance "${id}", which is not defined under \`plugins:\``);
    const bad = this.registry.unavailable(instance.plugin);
    if (bad) throw new ConfigError(`models.yaml: route "${task}": ${bad}`);
    if (isToolTask(task) && !this.registry.capabilities(instance.plugin)!.tools) {
      throw new ConfigError(`models.yaml: route "${task}" needs a plugin with file and shell tools; "${instance.plugin}" is read-only`);
    }
    if (this.registry.capabilities(instance.plugin)!.kind === "api" && /^UNCONFIGURED/i.test(r.model)) {
      throw new ConfigError(`models.yaml: route "${task}" uses the local model but no model id is configured. Run \`pnpm factory doctor\` to see what the server has loaded.`);
    }
    return { instance: id, plugin: instance.plugin, model: r.model };
  }

  /** The agent for a route: a substituted one, else the registry's runtime for the instance (validated: a bad setting is a ConfigError). */
  private agentFor(task: TaskKind, route: Route, projectId?: string): Agent {
    const given = this.agents[route.instance] ?? (route.instance === CLAUDE_INSTANCE ? this.agents.anthropic : undefined); // `anthropic` is the pre-plugin key for the Claude Code instance
    if (given) return given;
    const { instance } = instanceOfRoute(this.models, this.raw(task, projectId));
    try { return this.registry.runtime(route.instance, instance!); }
    catch (e) { throw e instanceof ConfigError ? e : new ConfigError((e as Error).message); }
  }

  async run(task: TaskKind, req: Omit<AgentRequest, "model">, projectId?: string): Promise<AgentResult & { route: Route }> {
    const route = this.route(task, projectId);
    const result = await this.agentFor(task, route, projectId).run({ ...req, model: route.model });
    return { ...result, route };
  }
}
