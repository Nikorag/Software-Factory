import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ConfigError } from "../config/load.js";
import type { LoadedConfig } from "../config/schema.js";
import { applyPlugins, PluginInstances, updatePluginInstances } from "../config/store.js";
import { instancesOf } from "../plugins/routes.js";
import { instancesInUse } from "../plugins/usage.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { writableDir } from "./settings-routes.js";

export interface PluginRouteDeps { config: LoadedConfig; registry: PluginRegistry }

const Draft = z.object({ plugin: z.string().min(1), settings: z.record(z.string(), z.unknown()).default({}) });

/**
 * The plugin page's API: what is installed, what each instance is configured as (and whether that is valid), and a validate
 * action that checks settings and reachability WITHOUT a model call. Settings carry env-var NAMES only, never key values.
 */
export function registerPluginRoutes(app: FastifyInstance, d: PluginRouteDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const fail = (reply: FastifyReply, e: unknown) => reply.code(e instanceof ConfigError || e instanceof z.ZodError ? 400 : 409).send({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message });

  app.get("/api/plugins", async () => {
    const used = new Map(instancesInUse(d.config.models).map((u) => [u.id, u.tasks.map((t) => t.task)]));
    const instances = Object.entries(instancesOf(d.config.models)).map(([id, inst]) => {
      let error: string | undefined;
      try { d.registry.validate(id, inst); } catch (e) { error = (e as Error).message; }
      return { id, plugin: inst.plugin, settings: inst.settings, builtin: !(id in d.config.models.plugins), valid: !error, error, usedBy: used.get(id) ?? [] };
    });
    return { plugins: d.registry.list(), instances };
  });

  app.put<{ Body: unknown }>("/api/plugins/instances", { preHandler: requireToken }, async (req, reply) => {
    try {
      const instances = PluginInstances.parse((req.body as { instances?: unknown } | null)?.instances ?? {});
      for (const [id, inst] of Object.entries(instances)) d.registry.validate(id, inst);
      applyPlugins(d.config, updatePluginInstances(instances, writableDir(d.config)));
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  // Checks an unsaved draft ({plugin, settings}) or a saved instance ({instance}). No model call: settings schema, then the plugin's probe.
  app.post<{ Body: unknown }>("/api/plugins/validate", { preHandler: requireToken }, async (req, reply) => {
    try {
      const body = req.body as { instance?: string } | null;
      if (body?.instance) {
        const inst = instancesOf(d.config.models)[body.instance];
        if (!inst) return reply.code(404).send({ error: `no plugin instance "${body.instance}"` });
        return await d.registry.check(body.instance, inst);
      }
      const draft = Draft.parse(req.body);
      return await d.registry.check("draft", draft);
    } catch (e) { return fail(reply, e); }
  });
}
