import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { mcpAccount, secretStatus } from "../agents/mcp.js";
import { BUNDLED_CONFIG_DIR } from "../config/load.js";
import { McpEnvName, McpServer, type LoadedConfig } from "../config/schema.js";
import { applyMcp, removeMcpServer, seedHomeConfig, setMcpDefaults, setMcpServer } from "../config/store.js";
import type { SecretStore } from "../jira/auth.js";

export interface McpRouteDeps { config: LoadedConfig; store: SecretStore; pathEnv?: string }
const dirOf = (c: LoadedConfig) => (!c.configDir || c.configDir === BUNDLED_CONFIG_DIR ? seedHomeConfig() : c.configDir);

/** The request body: a server definition (no secrets) plus, optionally, secret values by variable name. */
const Body = z.object({ secrets: z.record(McpEnvName, z.string().min(1).max(4000)).default({}) }).and(z.looseObject({}));

const onPath = (cmd: string, pathEnv: string): boolean => {
  const dirs = isAbsolute(cmd) ? [""] : pathEnv.split(delimiter).filter(Boolean);
  return dirs.some((d) => { try { accessSync(d ? join(d, cmd) : cmd, constants.X_OK); return true; } catch { return false; } });
};

/** MCP servers agents may use: list, add/update, remove, choose the profile default, and check readiness. Secret values go to the keychain only and are never returned. */
export function registerMcpRoutes(app: FastifyInstance, d: McpRouteDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const fail = (reply: FastifyReply, e: unknown, code = 400) => reply.code(e instanceof z.ZodError ? 400 : code).send({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message });
  const usedBy = (name: string) => d.config.projects.projects.filter((p) => p.overrides?.mcpServers?.includes(name)).map((p) => p.id);
  const view = (s: McpServer) => ({ ...s, secrets: secretStatus(s, d.store), usedBy: usedBy(s.name), isDefault: d.config.factory.mcp.defaultServers.includes(s.name) });

  app.get("/api/mcp/servers", async () => ({ servers: d.config.factory.mcp.servers.map(view), defaultServers: d.config.factory.mcp.defaultServers }));

  app.put<{ Params: { name: string }; Body: unknown }>("/api/mcp/servers/:name", { preHandler: requireToken }, async (req, reply) => {
    try {
      const { secrets, ...def } = Body.parse(req.body) as { secrets: Record<string, string> } & Record<string, unknown>;
      // The settings UI has no headers field, so a save that omits the key keeps the stored ones (an explicit `headers` replaces them).
      const kept = "headers" in def ? undefined : d.config.factory.mcp.servers.find((s) => s.name === req.params.name)?.headers;
      const server = McpServer.parse({ ...def, ...(kept ? { headers: kept } : {}), name: req.params.name });
      const stray = Object.keys(secrets).filter((k) => !server.env.includes(k));
      if (stray.length) throw new Error(`secrets for ${stray.join(", ")} but the server does not list them in env`);
      const fresh = setMcpServer(server, dirOf(d.config)); // validates the whole config first; the file holds names only
      for (const [k, v] of Object.entries(secrets)) d.store.set(mcpAccount(server.name, k), v.trim());
      applyMcp(d.config, fresh);
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  app.delete<{ Params: { name: string } }>("/api/mcp/servers/:name", { preHandler: requireToken }, async (req, reply) => {
    const server = d.config.factory.mcp.servers.find((s) => s.name === req.params.name);
    try {
      applyMcp(d.config, removeMcpServer(req.params.name, dirOf(d.config)));
      for (const n of server?.env ?? []) d.store.set(mcpAccount(req.params.name, n), ""); // the secrets go with it
      return { ok: true };
    } catch (e) { return fail(reply, e, 409); }
  });

  app.put<{ Body: { servers?: unknown } }>("/api/mcp/default", { preHandler: requireToken }, async (req, reply) => {
    try { applyMcp(d.config, setMcpDefaults(z.array(z.string()).parse(req.body?.servers), dirOf(d.config))); return { ok: true }; } catch (e) { return fail(reply, e); }
  });

  /** Readiness only: every secret is set and the command is on PATH / the url is valid. It never starts the server or contacts it. */
  app.post<{ Params: { name: string } }>("/api/mcp/servers/:name/test", { preHandler: requireToken }, async (req, reply) => {
    const s = d.config.factory.mcp.servers.find((x) => x.name === req.params.name);
    if (!s) return reply.code(404).send({ error: `no MCP server "${req.params.name}"` });
    const missingSecrets = secretStatus(s, d.store).filter((x) => !x.set).map((x) => x.name);
    const commandFound = s.type === "stdio" ? onPath(s.command ?? "", d.pathEnv ?? process.env.PATH ?? "") : undefined;
    return { ok: missingSecrets.length === 0 && commandFound !== false, missingSecrets, ...(commandFound === undefined ? {} : { commandFound }) };
  });
}
