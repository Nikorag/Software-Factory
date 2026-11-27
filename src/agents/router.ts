import type { ModelsConfig } from "../config/schema.js";
import { ConfigError } from "../config/load.js";
import { LocalModelClient } from "./local.js";
import type { Agent, AgentRequest, AgentResult } from "./types.js";

export type TaskKind = keyof ModelsConfig["routes"];
export interface Route { provider: "local" | "anthropic"; model: string; baseUrl?: string; apiKeyEnv?: string }

/** Maps a task (classification, specification, …) to a provider and model purely from config. */
export class ModelRouter {
  constructor(
    private readonly cfg: Pick<ModelsConfig, "routes">, private readonly agents: Record<"local" | "anthropic", Agent>,
    /** A project's own model choices (settings > Projects > Overrides). Anything it leaves out follows the global routes. */
    private readonly overrides?: (projectId: string) => Partial<ModelsConfig["routes"]> | undefined,
    /** Builds the client for a route with its own endpoint (the independent reviewer). Defaults to a LocalModelClient. */
    private readonly endpoint: (r: Route) => Agent = (r) => new LocalModelClient({ baseUrl: r.baseUrl!, apiKeyEnv: r.apiKeyEnv }),
  ) {}
  private readonly endpoints = new Map<string, Agent>();

  /** The independent reviewer for a project, or null when none is set (null in a project override also means none). */
  reviewer(projectId?: string): Route | null {
    const o = projectId ? this.overrides?.(projectId)?.independent_review : undefined;
    return (o !== undefined ? o : this.cfg.routes.independent_review) ?? null;
  }

  private agentFor(r: Route): Agent {
    if (r.provider !== "local" || !r.baseUrl) return this.agents[r.provider];
    const key = `${r.baseUrl}\n${r.apiKeyEnv ?? ""}`;
    let a = this.endpoints.get(key);
    if (!a) this.endpoints.set(key, a = this.endpoint(r));
    return a;
  }

  route(task: TaskKind, projectId?: string): Route {
    const r = task === "independent_review" ? this.reviewer(projectId) : ((projectId ? this.overrides?.(projectId)?.[task] : undefined) ?? this.cfg.routes[task]);
    if (!r) throw new ConfigError("no independent reviewer is configured");
    if (r.provider === "local" && /^UNCONFIGURED/i.test(r.model)) {
      throw new ConfigError(`models.yaml: route "${task}" uses the local model but no model id is configured. Run \`pnpm factory doctor\` to see what the server has loaded.`);
    }
    return r;
  }

  async run(task: TaskKind, req: Omit<AgentRequest, "model">, projectId?: string): Promise<AgentResult & { route: Route }> {
    const route = this.route(task, projectId);
    const result = await this.agentFor(route).run({ ...req, model: route.model });
    return { ...result, route };
  }
}
