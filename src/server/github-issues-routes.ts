import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BUNDLED_CONFIG_DIR } from "../config/load.js";
import { type LoadedConfig } from "../config/schema.js";
import { applyTracker, GithubIssuesMapping, seedHomeConfig, updateGithubIssuesConfig } from "../config/store.js";
import type { GhExec } from "../github/client.js";
import { createTrackerClient } from "../tracker/index.js";

export interface GithubIssuesRouteDeps { config: LoadedConfig; gh?: GhExec }

const dirOf = (c: LoadedConfig) => (!c.configDir || c.configDir === BUNDLED_CONFIG_DIR ? seedHomeConfig() : c.configDir);

/**
 * GitHub Issues settings. There is no OAuth app or secret to manage (the tracker signs in with the profile's `gh` login), so this is only:
 * who GitHub says we are, and the names the factory uses for its statuses and labels. Creating the missing ones is the same
 * "/api/setup/linear/:team/create" flow Linear uses, because the factory can create labels.
 */
export function registerGithubIssuesRoutes(app: FastifyInstance, d: GithubIssuesRouteDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const fail = (reply: FastifyReply, e: unknown, code = 400) => reply.code(e instanceof z.ZodError ? 400 : code).send({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message });
  const client = () => createTrackerClient(d.config, { gh: d.gh });

  app.get("/api/github-issues/status", async () => ({ tracker: d.config.factory.tracker, account: d.config.factory.githubAccount ?? null, statusPrefix: d.config.githubIssues.statusPrefix }));

  /** Who GitHub says we are, as proof the login works (only when the page asks). */
  app.get("/api/github-issues/whoami", async (_req, reply) => { try { return await client().viewer(); } catch (e) { return fail(reply, e, 502); } });

  app.get("/api/github-issues/mapping", async () => ({ statusPrefix: d.config.githubIssues.statusPrefix, statuses: d.config.githubIssues.statuses, labels: d.config.githubIssues.labels }));

  app.put<{ Body: unknown }>("/api/github-issues/mapping", { preHandler: requireToken }, async (req, reply) => {
    try {
      const mapping = GithubIssuesMapping.parse(req.body);
      applyTracker(d.config, updateGithubIssuesConfig(mapping, dirOf(d.config)));
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });
}
