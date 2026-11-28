import type { ModelsConfig } from "../config/schema.js";
import { instanceOfRoute } from "./routes.js";
import type { PluginInstance } from "./types.js";

export interface InstanceUse { id: string; instance?: PluginInstance; tasks: { task: string; model: string }[] }

/** The plugin instances the global routes use (each once), with the tasks and models that use it. `instance` is undefined when a route names one that is not defined. */
export function instancesInUse(models: Pick<ModelsConfig, "routes" | "local" | "plugins">): InstanceUse[] {
  const out = new Map<string, InstanceUse>();
  for (const [task, r] of Object.entries(models.routes)) {
    if (!r) continue;
    const { id, instance } = instanceOfRoute(models, r);
    const use = out.get(id) ?? { id, instance, tasks: [] };
    use.tasks.push({ task, model: r.model });
    out.set(id, use);
  }
  return [...out.values()];
}
