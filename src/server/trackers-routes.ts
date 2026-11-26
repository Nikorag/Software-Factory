import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import { BUNDLED_CONFIG_DIR } from "../config/load.js";
import { BUILTIN_TRACKER_IDS, trackerIdOf, TrackerId, TrackerKind, type LoadedConfig } from "../config/schema.js";
import { applyTracker, createConnection, removeConnection, renameConnection, seedHomeConfig, updateTracker } from "../config/store.js";
import type { FactoryDb } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { jiraStoreFor, trackerConfigured, trackerName } from "../tracker/index.js";

export interface TrackersRouteDeps { db: FactoryDb; config: LoadedConfig }
const dirOf = (c: LoadedConfig) => (!c.configDir || c.configDir === BUNDLED_CONFIG_DIR ? seedHomeConfig() : c.configDir);

/**
 * Tracker connections: named instances of Linear, Jira or GitHub Issues (a profile can have several of each: two Jiras, three Linear
 * workspaces). The profile has a DEFAULT connection; each project may name its own.
 */
export function registerTrackersRoutes(app: FastifyInstance, d: TrackersRouteDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const fail = (reply: FastifyReply, e: unknown, code = 400) => reply.code(e instanceof z.ZodError ? 400 : code).send({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message });
  const list = () => Object.entries(d.config.connections).map(([id, c]) => {
    let connected = false;
    try { connected = trackerConfigured(d.config, c.kind === "jira" ? jiraStoreFor(d.config, id) : undefined, id); } catch { /* unreadable keychain: not connected */ }
    return {
      ...(c.kind === "linear" ? { env: c.apiKeyEnv, keychainService: c.keychainService } : {}),
      id, kind: c.kind, label: trackerName(d.config, id), builtin: BUILTIN_TRACKER_IDS.includes(id), isDefault: d.config.factory.tracker === id, connected,
      projects: d.config.projects.projects.filter((p) => trackerIdOf(d.config, p) === id).map((p) => p.id),
    };
  });

  app.get("/api/trackers", async () => ({ default: d.config.factory.tracker, trackers: list() }));

  /** Adds a connection (a second Jira, a third Linear...). It gets its own credentials: set them up next. */
  app.post<{ Body: { id?: unknown; kind?: unknown; label?: unknown; account?: unknown } }>("/api/trackers", { preHandler: requireToken }, async (req, reply) => {
    try {
      const b = z.object({ id: TrackerId, kind: TrackerKind, label: z.string().trim().max(60).optional(), account: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional() }).parse(req.body);
      applyTracker(d.config, createConnection(b, dirOf(d.config)));
      return { ok: true, id: b.id };
    } catch (e) { return fail(reply, e); }
  });

  app.put<{ Params: { id: string }; Body: { label?: unknown } }>("/api/trackers/:id", { preHandler: requireToken }, async (req, reply) => {
    try {
      const label = z.string().trim().min(1).max(60).parse(req.body?.label);
      if (!d.config.connections[req.params.id]) return reply.code(404).send({ error: `no tracker connection ${req.params.id}` });
      applyTracker(d.config, renameConnection(req.params.id, label, dirOf(d.config)));
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  app.delete<{ Params: { id: string } }>("/api/trackers/:id", { preHandler: requireToken }, async (req, reply) => {
    try {
      applyTracker(d.config, removeConnection(req.params.id, dirOf(d.config)));
      return { ok: true };
    } catch (e) { return fail(reply, e, 409); }
  });

  /** The profile's default connection. Only projects that name no tracker of their own follow it, so only their active jobs matter. */
  app.put<{ Body: { tracker?: unknown } }>("/api/settings/tracker", { preHandler: requireToken }, async (req, reply) => {
    const id = req.body?.tracker;
    if (typeof id !== "string" || !d.config.connections[id]) return reply.code(400).send({ error: `tracker must be one of: ${Object.keys(d.config.connections).join(", ")}` });
    if (id === d.config.factory.tracker) return { ok: true };
    const own = d.config.projects.projects.filter((p) => p.tracker).map((p) => p.id); // these keep their tracker whatever the default is
    const following = d.config.projects.projects.filter((p) => !p.tracker).map((p) => p.id);
    const live = inArray(jobs.status, ["queued", "running", "waiting"]);
    const active = d.db.select().from(jobs).where(own.length ? and(live, notInArray(jobs.projectId, own)) : live).all().length;
    if (active) return reply.code(409).send({ error: `${active} job(s) are still active. Finish or cancel them before switching tracker: their tickets belong to the current one.` });
    applyTracker(d.config, updateTracker(id, dirOf(d.config)));
    return { ok: true, note: following.some((p) => d.config.projects.projects.find((x) => x.id === p)?.linear) ? "Projects that follow the default are still linked to the previous tracker: re-link each one in Settings → Projects (or give it its own tracker)." : undefined };
  });
}
