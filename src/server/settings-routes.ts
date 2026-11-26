import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { BUNDLED_CONFIG_DIR, ConfigError, homeConfigDir } from "../config/load.js";
import { applyGlobal, applyProjects, globalSettingsOf, ProjectSettings, removeProject, seedHomeConfig, updateGlobalSettings, upsertProject } from "../config/store.js";
import type { LoadedConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { auditTeam, type TeamAudit } from "../linear/check.js";
import { applySetup } from "../linear/setup.js";
import type { LinearClient } from "../linear/client.js";
import { createLinearClient } from "../linear/client.js";
import { trackerName } from "../tracker/index.js";
import { syncProjects } from "../repo/registry.js";
import { listGhAccounts, type GhAccount } from "../github/accounts.js";
import { ACTIONS, type ActionKind, type ProjectActions } from "../service/actions.js";
import type { TaskManager } from "../service/tasks.js";
import { unassign } from "../workflows/library.js";

export interface SettingsDeps {
  db: FactoryDb;
  config: LoadedConfig;
  tasks: TaskManager;
  actions: ProjectActions;
  linear: () => LinearClient;
  /** Validates against Linear first, then stores the key (keychain). Returns who it authenticated as. */
  saveLinearKey: (key: string) => Promise<{ name: string }>;
  linearKeyPresent: () => boolean;
  githubAccounts?: () => Promise<GhAccount[]>;
}

/** Edits go to the user's own config dir (seeded from the shipped defaults on first write), never to the shipped defaults. */
const writableDir = (c: LoadedConfig): string => (!c.configDir || c.configDir === BUNDLED_CONFIG_DIR ? seedHomeConfig() : c.configDir);
const fail = (reply: FastifyReply, e: unknown) => reply.code(e instanceof ConfigError || e instanceof z.ZodError ? 400 : 409).send({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message });

export function registerSettingsRoutes(app: FastifyInstance, d: SettingsDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const apply = (fresh: LoadedConfig) => { applyProjects(d.config, fresh); syncProjects(d.db, d.config.projects.projects); };

  // ---- setup wizard ----
  app.get("/api/setup", async () => ({
    configDir: d.config.configDir ?? null, homeConfigDir: homeConfigDir(), usingDefaults: !d.config.configDir || d.config.configDir === BUNDLED_CONFIG_DIR,
    projectCount: d.config.projects.projects.length, tracker: { kind: d.config.factory.tracker, name: trackerName(d.config), connected: d.linearKeyPresent() }, linear: { keyPresent: d.linearKeyPresent(), env: d.config.linear.apiKeyEnv, keychainService: d.config.linear.keychainService ?? null },
  }));

  app.post<{ Body: { key?: unknown } }>("/api/setup/linear-key", { preHandler: requireToken }, async (req, reply) => {
    if (d.config.factory.tracker === "jira") return reply.code(400).send({ error: "this profile uses Jira: connect it with OAuth in Settings → Tracker" });
    if (d.config.factory.tracker === "github") return reply.code(400).send({ error: "this profile uses GitHub Issues: it signs in with the gh login, not a Linear key" });
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    if (!/^lin_api_[A-Za-z0-9]{20,}$/.test(key)) return reply.code(400).send({ error: "that does not look like a Linear personal API key (it starts with lin_api_)" });
    try {
      await createLinearClient({ apiKey: key }).viewer(); // prove it works before storing anything
      return { ok: true, ...(await d.saveLinearKey(key)) };
    } catch (e) { return reply.code(400).send({ error: `Linear rejected that key or it could not be stored: ${(e as Error).message}` }); }
  });

  /** Teams, their projects, and which of the statuses/labels the factory needs are missing. Read-only. */
  app.get("/api/setup/linear", async (_req, reply) => {
    try {
      const client = d.linear();
      const teams = await client.teams();
      const out: { key: string; name: string; projects: string[]; audit: TeamAudit; audited: boolean }[] = [];
      const jira = d.config.factory.tracker === "jira";
      // Jira: "teams" are Jira projects and "projects" their components. Nothing is created in Jira, so there is no audit: see the mapping instead.
      // GitHub: "teams" are repositories (there can be hundreds), so only the ones a project is linked to are read and audited: the rest just fill the picker.
      const github = d.config.factory.tracker === "github";
      const linked = new Set(d.config.projects.projects.flatMap((p) => (p.linear ? [p.linear.teamKey] : [])));
      const none = (t: { key: string; name: string }): TeamAudit => ({ team: { key: t.key, name: t.name }, statuses: [], labels: [], existingStatuses: [], existingLabels: [], ok: true });
      for (const t of teams) {
        if (github && !linked.has(t.key)) { out.push({ key: t.key, name: t.name, projects: [], audit: none(t), audited: false }); continue; }
        out.push({ key: t.key, name: t.name, projects: (await client.projects(t.id)).map((p) => p.name), audit: jira ? none(t) : await auditTeam(client, d.config.linear, t), audited: !jira });
      }
      return { teams: out };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  /** Creates only what is missing (never edits or deletes). */
  app.post<{ Params: { team: string } }>("/api/setup/linear/:team/create", { preHandler: requireToken }, async (req, reply) => {
    if (d.config.factory.tracker === "jira") return reply.code(400).send({ error: "Jira statuses and labels cannot be created by the factory: map them to existing ones in Settings → Tracker" });
    try {
      const client = d.linear();
      const team = (await client.teams()).find((t) => t.key === req.params.team);
      if (!team) return reply.code(404).send({ error: `no Linear team ${req.params.team}` });
      const r = await applySetup(client, d.config.linear, team, {});
      return { ok: r.failed.length === 0, created: r.created, failed: r.failed };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  /** Which GitHub accounts gh is logged in to (logins only, never tokens), and this profile's default. */
  app.get("/api/setup/github", async () => ({ accounts: await (d.githubAccounts ?? listGhAccounts)(), defaultAccount: d.config.factory.githubAccount ?? null }));

  // ---- workflow settings: concurrency, fix-cycle limit, models per task ----
  app.get("/api/settings/global", async () => globalSettingsOf(d.config));
  app.put<{ Body: unknown }>("/api/settings/global", { preHandler: requireToken }, async (req, reply) => {
    try { applyGlobal(d.config, updateGlobalSettings(req.body, writableDir(d.config))); return { ok: true, ...globalSettingsOf(d.config) }; } catch (e) { return fail(reply, e); }
  });

  // ---- projects ----
  app.put<{ Params: { id: string }; Body: unknown }>("/api/settings/projects/:id", { preHandler: requireToken }, async (req, reply) => {
    try {
      const body = ProjectSettings.parse({ ...(req.body as object), id: req.params.id });
      apply(upsertProject(body, writableDir(d.config)));
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });
  app.delete<{ Params: { id: string } }>("/api/settings/projects/:id", { preHandler: requireToken }, async (req, reply) => {
    // a running job needs its project's config: removing it under them fails them with a ConfigError and orphans their worktrees
    const active = d.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.projectId, req.params.id), inArray(jobs.status, ["queued", "running", "waiting"]))).all().length;
    if (active) return reply.code(409).send({ error: `${req.params.id} has ${active} active job(s). Finish or cancel them before removing the project.` });
    try { apply(removeProject(req.params.id, writableDir(d.config))); unassign(d.db, "project", req.params.id); return { ok: true }; } catch (e) { return fail(reply, e); }
  });

  // ---- background actions on a project ----
  app.post<{ Params: { id: string; kind: string } }>("/api/projects/:id/actions/:kind", { preHandler: requireToken }, async (req, reply) => {
    const kind = req.params.kind as ActionKind;
    const project = d.config.projects.projects.find((p) => p.id === req.params.id);
    if (!project) return reply.code(404).send({ error: `no such project: ${req.params.id}` });
    if (!(kind in ACTIONS)) return reply.code(404).send({ error: `no such action: ${req.params.kind}` });
    try {
      const t = d.tasks.start(`${ACTIONS[kind]}: ${project.id}`, `project:${project.id}`, (log) => d.actions[kind](project, log));
      return { ok: true, taskId: t.id };
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const t = d.tasks.get(req.params.id);
    return t ? { id: t.id, label: t.label, status: t.status, lines: t.lines, startedAt: t.startedAt, finishedAt: t.finishedAt } : reply.code(404).send({ error: "no such task" });
  });
}
