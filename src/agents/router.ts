import type { ModelsConfig } from "../config/schema.js";
import { ConfigError } from "../config/load.js";
import type { Agent, AgentRequest, AgentResult } from "./types.js";

export type TaskKind = keyof ModelsConfig["routes"];
export interface Route { provider: "local" | "anthropic"; model: string }
/** A workflow stage's model choice: each part is optional and falls back to the configured route. */
export interface StageModel { provider?: "local" | "anthropic" | undefined; model?: string | undefined }

function refine(task: TaskKind, base: Route, o?: StageModel): Route {
  if (!o || (!o.provider && !o.model)) return base;
  const provider = o.provider ?? base.provider;
  if (provider !== base.provider && !o.model) throw new ConfigError(`a workflow stage asks for provider "${provider}" for the ${task} task but names no model: name the model id too`);
  return { provider, model: o.model ?? base.model };
}

/** Maps a task (classification, specification, …) to a provider and model purely from config. */
export class ModelRouter {
  constructor(
    private readonly cfg: Pick<ModelsConfig, "routes">, private readonly agents: Record<"local" | "anthropic", Agent>,
    /** A project's own model choices (settings > Projects > Overrides). Anything it leaves out follows the global routes. */
    private readonly overrides?: (projectId: string) => Partial<ModelsConfig["routes"]> | undefined,
  ) {}

  /**
   * `stageModel`: a workflow stage's own choice. It refines the route the config (or the project) gave the task rather than replacing the
   * router: it may change the model, and the provider only together with a model id of that provider.
   */
  route(task: TaskKind, projectId?: string, stageModel?: StageModel): Route {
    const base = (projectId ? this.overrides?.(projectId)?.[task] : undefined) ?? this.cfg.routes[task];
    const r = refine(task, base, stageModel);
    if (r.provider === "local" && /^UNCONFIGURED/i.test(r.model)) {
      throw new ConfigError(`models.yaml: route "${task}" uses the local model but no model id is configured. Run \`pnpm factory doctor\` to see what the server has loaded.`);
    }
    return r;
  }

  async run(task: TaskKind, req: Omit<AgentRequest, "model">, projectId?: string, stageModel?: StageModel): Promise<AgentResult & { route: Route }> {
    const route = this.route(task, projectId, stageModel);
    const result = await this.agents[route.provider].run({ ...req, model: route.model });
    return { ...result, route };
  }
}
