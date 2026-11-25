import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BB_API, BitbucketAuthError, resolveCredential } from "../bitbucket/auth.js";
import { createBitbucketClient } from "../bitbucket/client.js";
import { BUNDLED_CONFIG_DIR, ConfigError } from "../config/load.js";
import type { LoadedConfig } from "../config/schema.js";
import { applyBitbucket, BitbucketCredentialInput, removeBitbucketCredential, seedHomeConfig, setBitbucketCredential } from "../config/store.js";
import type { SecretStore } from "../jira/auth.js";

export interface BitbucketRouteDeps { config: LoadedConfig; store: SecretStore; fetch?: typeof fetch; apiBase?: string }
const dirOf = (c: LoadedConfig) => (!c.configDir || c.configDir === BUNDLED_CONFIG_DIR ? seedHomeConfig() : c.configDir);

/** Credentials for Bitbucket Cloud: add a token, see which projects use it, and test it against a repository. Tokens go to the keychain, never to config. */
export function registerBitbucketRoutes(app: FastifyInstance, d: BitbucketRouteDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const fail = (reply: FastifyReply, e: unknown, code = 400) => reply.code(e instanceof z.ZodError ? 400 : code).send({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message });
  const usedBy = (name: string) => d.config.projects.projects.filter((p) => p.host === "bitbucket" && p.bitbucket.credential === name).map((p) => p.id);

  app.get("/api/bitbucket/credentials", async () => ({
    credentials: Object.entries(d.config.bitbucket.credentials).map(([name, c]) => ({ name, kind: c.kind, email: c.email ?? null, hasToken: Boolean(d.store.get(name)), usedBy: usedBy(name) })),
  }));

  app.put<{ Params: { name: string }; Body: unknown }>("/api/bitbucket/credentials/:name", { preHandler: requireToken }, async (req, reply) => {
    try {
      const body = BitbucketCredentialInput.parse(req.body);
      const name = req.params.name;
      if (!d.store.get(name) && !body.token) throw new ConfigError("paste the token");
      const fresh = setBitbucketCredential(name, { kind: body.kind, email: body.email }, dirOf(d.config)); // validates the name and the whole config first
      if (body.token) d.store.set(name, body.token.trim());
      applyBitbucket(d.config, fresh);
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  app.delete<{ Params: { name: string } }>("/api/bitbucket/credentials/:name", { preHandler: requireToken }, async (req, reply) => {
    const using = usedBy(req.params.name);
    if (using.length) return reply.code(409).send({ error: `still used by: ${using.join(", ")}. Point those projects at another credential first.` });
    try { applyBitbucket(d.config, removeBitbucketCredential(req.params.name, dirOf(d.config))); d.store.set(req.params.name, ""); return { ok: true }; } catch (e) { return fail(reply, e); }
  });

  /** Can this credential see this repository? (Access tokens cannot call account endpoints, so the repository itself is the honest test.) */
  app.post<{ Params: { name: string }; Body: { repo?: unknown } }>("/api/bitbucket/credentials/:name/test", { preHandler: requireToken }, async (req, reply) => {
    const repo = typeof req.body?.repo === "string" ? req.body.repo.trim() : "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return reply.code(400).send({ error: "give the repository as workspace/slug" });
    try {
      const c = createBitbucketClient({ credential: resolveCredential(d.config, req.params.name, d.store), fetch: d.fetch, apiBase: d.apiBase ?? BB_API, maxRetries: 1 });
      return { ok: true, ...(await c.repository(repo)) };
    } catch (e) { return fail(reply, e instanceof BitbucketAuthError ? e : new Error((e as Error).message), 400); }
  });
}
