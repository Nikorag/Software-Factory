import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LoadedConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import type { LinearClient } from "../linear/client.js";
import { trackerIdOf } from "../config/schema.js";
import { trackerIdsInUse, trackerName } from "../tracker/index.js";
import { buildDefaultDefinition } from "../workflows/default.js";
import { COMPLETE, FACTORY_HANDLERS, FAILURE_ACTIONS, FAILURE_KINDS, GATE_TYPES, STAGE_TYPES, WorkflowMeta } from "../workflows/definition.js";
import { SYSTEM_LIMITS } from "../workflows/limits.js";
import {
  assign, createWorkflow, deleteWorkflow, duplicateWorkflow, getSettings, getWorkflow, listAssignments, listWorkflows, setEnabled, toView, unassign,
  syncBuiltinWorkflow, updateSettings, updateWorkflow, usageOf, versionsOf, WorkflowError,
} from "../workflows/library.js";
import { MANDATORY_GATES } from "../workflows/safety.js";
import { CHECK_COMMANDS, READ_ONLY_ROLES, REVIEW_ROLES, STAGE_TYPE_SPECS } from "../workflows/stage-types.js";
import { PROMPT_VARIABLES } from "../workflows/template.js";
import { validateDefinition } from "../workflows/validate.js";
const zod = z;

export interface WorkflowRouteDeps { db: FactoryDb; config: LoadedConfig; /** The client of a tracker connection (default: the profile's default). */ linear?: (trackerId?: string) => LinearClient }

const fail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof WorkflowError) return reply.code(e.code === "not_found" ? 404 : e.code === "invalid" ? 400 : e.code === "protected" ? 403 : 409).send({ error: e.message, code: e.code, issues: e.issues, usage: e.usage ?? null });
  if (e instanceof z.ZodError) return reply.code(400).send({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), code: "invalid", issues: [] });
  throw e;
};

/** The workflow library, assignments, label priorities and the conflict policy. Reads are open (like the rest of the dashboard); every change needs the token. */
export function registerWorkflowRoutes(app: FastifyInstance, d: WorkflowRouteDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const { db } = d;
  syncBuiltinWorkflow(db, d.config.workflows); // the library always has its built-in workflow, even before the first job
  const full = (id: string) => {
    const r = getWorkflow(db, id)!;
    const v = validateDefinition(JSON.parse(r.definitionJson));
    return { ...toView(r), definition: v.ok ? v.definition : JSON.parse(r.definitionJson), issues: v.ok ? [] : v.errors, warnings: v.warnings, usage: usageOf(db, id), versions: versionsOf(db, id) };
  };

  /** Everything the editor needs that is defined in code: stage types and their defaults, gate and failure vocabularies, prompt variables, limits, safety stages. */
  app.get("/api/workflows/meta", async () => ({
    stageTypes: STAGE_TYPES.map((t) => { const s = STAGE_TYPE_SPECS[t]; return { type: t, label: s.label, description: s.description, defaultConfig: s.defaultConfig, defaultGate: s.defaultGate, defaultPrompt: s.defaultPrompt ?? null, usesModel: s.usesModel, engineOnly: Boolean(s.engineOnly) }; }),
    factoryHandlers: FACTORY_HANDLERS.map((h) => { const st = buildDefaultDefinition(d.config.workflows).stages.find((x) => x.id === h)!; return { handler: h, name: st.name, description: st.description, mutating: st.mutating ?? false }; }),
    gateTypes: GATE_TYPES, failureKinds: FAILURE_KINDS, failureActions: FAILURE_ACTIONS, complete: COMPLETE,
    roles: { agent: READ_ONLY_ROLES, review: REVIEW_ROLES }, checkCommands: CHECK_COMMANDS,
    promptVariables: PROMPT_VARIABLES, limits: SYSTEM_LIMITS,
    mandatory: MANDATORY_GATES.map((m) => ({ handler: m.handler, guards: m.guards, why: m.why })),
    models: { routes: d.config.models.routes, providers: ["anthropic", "local"] },
  }));

  app.get("/api/workflows", async () => ({
    workflows: listWorkflows(db).map((r) => ({ ...toView(r), usage: usageOf(db, r.id) })),
    settings: getSettings(db), assignments: listAssignments(db).map((a) => ({ id: a.id, scope: a.scope, targetId: a.targetId, targetName: a.targetName, workflowId: a.workflowId, priority: a.priority })),
  }));
  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (req, reply) => (getWorkflow(db, req.params.id) ? full(req.params.id) : reply.code(404).send({ error: "no such workflow" })));

  /** Validates without saving: the editor calls this as you work, so every problem shows before Save. */
  app.post<{ Body: { definition?: unknown } }>("/api/workflows/validate", async (req) => {
    const r = validateDefinition(req.body?.definition);
    return r.ok ? { ok: true, errors: [], warnings: r.warnings, definition: r.definition } : { ok: false, errors: r.errors, warnings: r.warnings };
  });

  const Create = zod.object({ meta: WorkflowMeta, definition: zod.unknown().optional(), from: zod.string().optional() });
  /** Create from scratch (a minimal valid definition), from a definition, or as a copy of an existing workflow (`from`, e.g. "default"). */
  app.post<{ Body: unknown }>("/api/workflows", { preHandler: requireToken }, async (req, reply) => {
    try {
      const b = Create.parse(req.body);
      if (b.from) { const copy = duplicateWorkflow(db, b.from, b.meta.name); return { ok: true, workflow: full(updateWorkflow(db, copy.id, { meta: { description: b.meta.description, category: b.meta.category ?? null, tags: b.meta.tags } }).id) }; }
      const definition = b.definition ?? scratchDefinition();
      return { ok: true, workflow: full(createWorkflow(db, { meta: b.meta, definition }).id) };
    } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: { id: string }; Body: { name?: string } }>("/api/workflows/:id/duplicate", { preHandler: requireToken }, async (req, reply) => {
    try { return { ok: true, workflow: full(duplicateWorkflow(db, req.params.id, typeof req.body?.name === "string" ? req.body.name : undefined).id) }; } catch (e) { return fail(reply, e); }
  });
  const Patch = zod.object({ meta: WorkflowMeta.partial().extend({ enabled: zod.boolean().optional() }).optional(), definition: zod.unknown().optional() });
  app.put<{ Params: { id: string }; Body: unknown }>("/api/workflows/:id", { preHandler: requireToken }, async (req, reply) => {
    try { const b = Patch.parse(req.body); return { ok: true, workflow: full(updateWorkflow(db, req.params.id, { ...(b.meta ? { meta: b.meta } : {}), ...(b.definition !== undefined ? { definition: b.definition } : {}) }).id) }; } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: { id: string; action: string } }>("/api/workflows/:id/:action(enable|disable)", { preHandler: requireToken }, async (req, reply) => {
    try {
      // Disabling something that is assigned is allowed but visible: tickets matching those assignments wait (and say why) until reassigned.
      const w = setEnabled(db, req.params.id, req.params.action === "enable");
      return { ok: true, workflow: full(w.id) };
    } catch (e) { return fail(reply, e); }
  });
  app.delete<{ Params: { id: string }; Querystring: { removeAssignments?: string } }>("/api/workflows/:id", { preHandler: requireToken }, async (req, reply) => {
    try { deleteWorkflow(db, req.params.id, { removeAssignments: req.query.removeAssignments === "1" }); return { ok: true }; } catch (e) { return fail(reply, e); }
  });

  // ---- assignments ----
  const Assign = zod.object({ scope: zod.enum(["project", "label"]), targetId: zod.string().min(1).max(200), targetName: zod.string().max(200).nullable().optional(), workflowId: zod.string().min(1), priority: zod.number().int().min(0).max(10_000).optional() });
  app.put<{ Body: unknown }>("/api/workflows/assignments", { preHandler: requireToken }, async (req, reply) => {
    try {
      const b = Assign.parse(req.body);
      if (b.scope === "project" && !d.config.projects.projects.some((p) => p.id === b.targetId)) return reply.code(404).send({ error: `no such project ${b.targetId}` });
      return { ok: true, assignment: assign(db, b) };
    } catch (e) { return fail(reply, e); }
  });
  app.delete<{ Querystring: { scope?: string; targetId?: string } }>("/api/workflows/assignments", { preHandler: requireToken }, async (req, reply) => {
    const { scope, targetId } = req.query;
    if ((scope !== "project" && scope !== "label") || !targetId) return reply.code(400).send({ error: "scope (project|label) and targetId are required" });
    return { ok: unassign(db, scope, targetId) };
  });
  const Settings = zod.object({ defaultWorkflowId: zod.string().optional(), labelConflictPolicy: zod.enum(["block", "project", "tiebreak"]).optional() });
  app.put<{ Body: unknown }>("/api/workflows/settings", { preHandler: requireToken }, async (req, reply) => {
    try { const b = Settings.parse(req.body); return { ok: true, settings: updateSettings(db, { ...(b.defaultWorkflowId ? { defaultWorkflowId: b.defaultWorkflowId } : {}), ...(b.labelConflictPolicy ? { labelConflictPolicy: b.labelConflictPolicy } : {}) }) }; } catch (e) { return fail(reply, e); }
  });

  /** Labels the tracker has (id, name, team), for the assignment screen. Identified by id: names change and repeat across teams. Marks which are assigned. */
  app.get("/api/workflows/labels", async (_req, reply) => {
    if (!d.linear) return { labels: [], assigned: [] };
    try {
      // Labels of every tracker connection in use (projects can live in different ones). A connection that cannot be read is reported, not fatal, unless none can.
      const seen = new Map<string, { id: string; name: string; teams: string[] }>();
      const ids = trackerIdsInUse(d.config), problems: string[] = [];
      for (const tid of ids) {
        try {
          const client = d.linear(tid);
          const prefix = ids.length > 1 ? `${trackerName(d.config, tid)}: ` : "";
          const teams = (await client.teams()).filter((t) => ids.length === 1 || d.config.projects.projects.some((p) => p.linear?.teamKey === t.key && trackerIdOf(d.config, p) === tid)); // with several connections, only the teams projects are bound to
          for (const t of teams) for (const l of await client.labels(t.id)) { const e = seen.get(l.id) ?? { id: l.id, name: l.name, teams: [] }; e.teams.push(`${prefix}${t.key}`); seen.set(l.id, e); }
        } catch (e) { problems.push(`${trackerName(d.config, tid)}: ${(e as Error).message}`); }
      }
      if (problems.length === ids.length && problems.length) throw new Error(problems.join("; "));
      const assigned = listAssignments(db).filter((a) => a.scope === "label");
      return { labels: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)), assigned: assigned.map((a) => ({ id: a.targetId, name: a.targetName, workflowId: a.workflowId, priority: a.priority, foundInTracker: seen.has(a.targetId) })) };
    } catch (e) { return reply.code(502).send({ error: `cannot read labels from the tracker: ${(e as Error).message}` }); }
  });
}

/** A minimal valid workflow: the mandatory intake stage, one read-only agent step, and completion on the ticket. */
export function scratchDefinition() {
  return {
    schemaVersion: 1,
    stages: [
      { id: "ELIGIBILITY_CHECK", name: "Eligibility check", type: "factory", handler: "ELIGIBILITY_CHECK", description: "Re-reads the live ticket before anything happens.", required: true, timeoutSeconds: 900, retry: { max: 2 }, onFailure: [{ on: "error", action: "retry" }, { on: "timeout", action: "retry" }], mutating: false },
      { id: "ANALYSIS", name: "Analysis", type: "agent", config: { role: "requirements-analyst" }, required: true, timeoutSeconds: 900, retry: { max: 1 }, successGate: { type: "fields_present", fields: ["text"] }, onFailure: [{ on: "error", action: "retry" }, { on: "gate", action: "retry" }] },
      { id: "LINEAR_COMPLETION", name: "Complete", type: "factory", handler: "LINEAR_COMPLETION", description: "Comments on the ticket and moves it to Done.", required: true, timeoutSeconds: 900, retry: { max: 2 }, onFailure: [{ on: "error", action: "retry" }], mutating: true },
    ],
  };
}
