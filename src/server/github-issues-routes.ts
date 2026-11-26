import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BUNDLED_CONFIG_DIR, ConfigError } from "../config/load.js";
import { type GithubIssuesConfig, type LoadedConfig } from "../config/schema.js";
import { applyTracker, GithubIssuesMapping, seedHomeConfig, updateGithubIssuesConfig } from "../config/store.js";
import type { GhExec } from "../github/client.js";
import { createTrackerClient } from "../tracker/index.js";

export interface GithubIssuesRouteDeps { config: LoadedConfig; gh?: GhExec }

const dirOf = (c: LoadedConfig) => (!c.configDir || c.configDir === BUNDLED_CONFIG_DIR ? seedHomeConfig() : c.configDir);

/**
 * GitHub Issues settings, for one GitHub connection (`?tracker=<id>`, default the built-in "github"). There is no OAuth app or secret to manage
 * (it signs in with a `gh` login), so this is only: who GitHub says we are, which account, and the names the factory uses for its statuses and
 * labels. Creating the missing ones is the same "/api/setup/linear/:team/create" flow Linear uses, because the factory can create labels.
 */
export function registerGithubIssuesRoutes(app: FastifyInstance, d: GithubIssuesRouteDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const fail = (reply: FastifyReply, e: unknown, code = 400) => reply.code(e instanceof z.ZodError ? 400 : code).send({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message });
  const idOf = (req: FastifyRequest) => (req.query as { tracker?: string } | undefined)?.tracker ?? "github";
  const connOf = (id: string): GithubIssuesConfig & { kind: "github" } => {
    const c = d.config.connections[id];
    if (!c || c.kind !== "github") throw new ConfigError(`"${id}" is not a GitHub Issues connection`);
    return c;
  };

  app.get("/api/github-issues/status", async (req, reply) => {
    try { const id = idOf(req), c = connOf(id); return { tracker: d.config.factory.tracker, id, account: c.account ?? d.config.factory.githubAccount ?? null, ownAccount: c.account ?? null, statusPrefix: c.statusPrefix }; } catch (e) { return fail(reply, e, 404); }
  });

  /** Who GitHub says we are, as proof the login works (only when the page asks). */
  app.get("/api/github-issues/whoami", async (req, reply) => { try { return await createTrackerClient(d.config, { id: idOf(req), gh: d.gh }).viewer(); } catch (e) { return fail(reply, e, 502); } });

  app.get("/api/github-issues/mapping", async (req, reply) => {
    try { const c = connOf(idOf(req)); return { statusPrefix: c.statusPrefix, statuses: c.statuses, labels: c.labels, account: c.account ?? null }; } catch (e) { return fail(reply, e, 404); }
  });

  app.put<{ Body: unknown }>("/api/github-issues/mapping", { preHandler: requireToken }, async (req, reply) => {
    try {
      const id = idOf(req); connOf(id);
      const body = (req.body ?? {}) as { account?: unknown };
      const account = body.account === undefined ? undefined : body.account === null || body.account === "" ? null : z.string().regex(/^[A-Za-z0-9-]{1,39}$/, "not a GitHub login").parse(body.account);
      const mapping = GithubIssuesMapping.parse(req.body);
      applyTracker(d.config, updateGithubIssuesConfig({ ...mapping, ...(account !== undefined ? { account } : {}) }, dirOf(d.config), id));
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });
}
