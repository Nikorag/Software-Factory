import type { ModelsConfig } from "../config/schema.js";
import { ConfigError } from "../config/load.js";
import type { Agent, AgentRequest, AgentResult } from "./types.js";

export type TaskKind = keyof ModelsConfig["routes"];
export interface Route { provider: "local" | "anthropic"; model: string }

/** Maps a task (classification, specification, …) to a provider and model purely from config. */
export class ModelRouter {
  constructor(private readonly cfg: Pick<ModelsConfig, "routes">, private readonly agents: Record<"local" | "anthropic", Agent>) {}

  route(task: TaskKind): Route {
    const r = this.cfg.routes[task];
    if (r.provider === "local" && /^UNCONFIGURED/i.test(r.model)) {
      throw new ConfigError(`models.yaml: route "${task}" uses the local model but no model id is configured. Run \`pnpm factory doctor\` to see what the server has loaded.`);
    }
    return r;
  }

  async run(task: TaskKind, req: Omit<AgentRequest, "model">): Promise<AgentResult & { route: Route }> {
    const route = this.route(task);
    const result = await this.agents[route.provider].run({ ...req, model: route.model });
    return { ...result, route };
  }
}
