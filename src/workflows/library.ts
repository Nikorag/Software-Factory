import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { WorkflowsConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { jobs, workflowAssignments, workflowSettings, workflowVersions, workflows } from "../db/schema.js";
import { buildDefaultDefinition, DEFAULT_WORKFLOW_DESCRIPTION, DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_NAME } from "./default.js";
import { WorkflowDefinition, WorkflowMeta } from "./definition.js";
import { assertValid, validateDefinition, type Issue } from "./validate.js";

export type WorkflowRow = typeof workflows.$inferSelect;
export class WorkflowError extends Error {
  constructor(message: string, readonly code: "invalid" | "not_found" | "conflict" | "protected" | "in_use" = "invalid", readonly issues: Issue[] = [], readonly usage?: WorkflowUsage) { super(message); }
}
const ACTIVE = ["queued", "running", "waiting"] as const;

export interface WorkflowUsage {
  projects: string[];
  labels: { id: string; name: string | null; priority: number }[];
  activeJobs: number;
  isGlobalDefault: boolean;
}

export interface WorkflowView {
  id: string; name: string; description: string; version: number; enabled: boolean; builtin: boolean; category: string | null; tags: string[];
  createdAt: number; updatedAt: number; stageCount: number; valid: boolean;
}
export const toView = (r: WorkflowRow): WorkflowView => {
  let stageCount = 0, valid = false;
  try { const d = JSON.parse(r.definitionJson) as { stages?: unknown[] }; stageCount = d.stages?.length ?? 0; valid = validateDefinition(d).ok; } catch { /* unreadable definition: reported as invalid */ }
  return { id: r.id, name: r.name, description: r.description, version: r.version, enabled: r.enabled, builtin: r.builtin, category: r.category, tags: JSON.parse(r.tagsJson) as string[], createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime(), stageCount, valid };
};

export const getWorkflow = (db: FactoryDb, id: string): WorkflowRow | undefined => db.select().from(workflows).where(eq(workflows.id, id)).get();
export const listWorkflows = (db: FactoryDb): WorkflowRow[] => db.select().from(workflows).orderBy(asc(workflows.name)).all();

/** Parses a stored definition. A stored row that no longer validates is returned as an error, never silently repaired. */
export function definitionOf(row: Pick<WorkflowRow, "definitionJson">): WorkflowDefinition {
  return assertValid(JSON.parse(row.definitionJson));
}

function recordVersion(db: FactoryDb, row: WorkflowRow): void {
  db.insert(workflowVersions).values({ workflowId: row.id, version: row.version, name: row.name, definitionJson: row.definitionJson }).onConflictDoNothing().run();
}

/**
 * Creates the built-in Default Workflow on a new installation, and keeps it current on an upgrade: it is derived from the factory's own
 * state machine and workflows.yaml, so when either changes its definition (and version) changes with them. Jobs already running keep
 * their snapshot. Also creates the settings row and gives jobs created before workflows existed the snapshot they have been running on.
 */
export function syncBuiltinWorkflow(db: FactoryDb, policy: WorkflowsConfig): WorkflowRow {
  db.insert(workflowSettings).values({ id: 1 }).onConflictDoNothing().run();
  const definition = buildDefaultDefinition(policy);
  const json = JSON.stringify(definition);
  return db.transaction((tx) => {
    const cur = tx.select().from(workflows).where(eq(workflows.id, DEFAULT_WORKFLOW_ID)).get();
    if (!cur) {
      tx.insert(workflows).values({ id: DEFAULT_WORKFLOW_ID, name: DEFAULT_WORKFLOW_NAME, description: DEFAULT_WORKFLOW_DESCRIPTION, builtin: true, category: "built-in", tagsJson: "[]", definitionJson: json }).run();
    } else if (cur.definitionJson !== json || !cur.builtin) {
      tx.update(workflows).set({ definitionJson: json, version: cur.version + 1, builtin: true, enabled: true, updatedAt: new Date() }).where(eq(workflows.id, DEFAULT_WORKFLOW_ID)).run();
    }
    const row = tx.select().from(workflows).where(eq(workflows.id, DEFAULT_WORKFLOW_ID)).get()!;
    recordVersion(tx as unknown as FactoryDb, row);
    return row;
  });
}

/** Jobs created before workflows existed have no snapshot: give them the Default Workflow built from their own kind's policy, so in-flight work continues unchanged. */
export function backfillJobSnapshots(db: FactoryDb, policy: WorkflowsConfig): number {
  const legacy = db.select().from(jobs).where(isNull(jobs.workflowSnapshotJson)).all();
  if (!legacy.length) return 0;
  const version = getWorkflow(db, DEFAULT_WORKFLOW_ID)?.version ?? 1;
  const cache = new Map<string, string>();
  db.transaction((tx) => {
    for (const j of legacy) {
      const json = cache.get(j.workflow) ?? JSON.stringify(buildDefaultDefinition(policy, j.workflow));
      cache.set(j.workflow, json);
      tx.update(jobs).set({
        workflowId: DEFAULT_WORKFLOW_ID, workflowVersion: version, workflowSnapshotJson: json,
        workflowResolutionJson: JSON.stringify({ source: "default", reason: "created before configurable workflows existed: continues on the built-in Default Workflow", matchedLabels: [], legacy: true }),
      }).where(eq(jobs.id, j.id)).run();
    }
  });
  return legacy.length;
}

export interface WorkflowInput { meta: WorkflowMeta; definition: unknown }

function checkName(db: FactoryDb, name: string, exceptId?: string): void {
  const clash = db.select().from(workflows).where(eq(workflows.name, name)).get();
  if (clash && clash.id !== exceptId) throw new WorkflowError(`there is already a workflow called "${name}"`, "conflict");
}
function checked(definition: unknown): WorkflowDefinition {
  const v = validateDefinition(definition);
  if (!v.ok) throw new WorkflowError(`the workflow is not valid: ${v.errors.slice(0, 3).map((e) => `${e.path || "workflow"}: ${e.message}`).join("; ")}${v.errors.length > 3 ? ` (+${v.errors.length - 3} more)` : ""}`, "invalid", v.errors);
  return v.definition;
}

export function createWorkflow(db: FactoryDb, input: WorkflowInput & { id?: string }): WorkflowRow {
  const meta = WorkflowMeta.parse(input.meta);
  const def = checked(input.definition);
  checkName(db, meta.name);
  const id = input.id ?? `wf_${randomUUID().slice(0, 8)}`;
  return db.transaction((tx) => {
    tx.insert(workflows).values({ id, name: meta.name, description: meta.description, category: meta.category ?? null, tagsJson: JSON.stringify(meta.tags), definitionJson: JSON.stringify(def) }).run();
    const row = tx.select().from(workflows).where(eq(workflows.id, id)).get()!;
    recordVersion(tx as unknown as FactoryDb, row);
    return row;
  });
}

/** A copy of any workflow (the Default Workflow included) under a new name, with its own id and version 1: edit it freely. */
export function duplicateWorkflow(db: FactoryDb, sourceId: string, name?: string): WorkflowRow {
  const src = getWorkflow(db, sourceId);
  if (!src) throw new WorkflowError(`no such workflow ${sourceId}`, "not_found");
  let n = name?.trim() || `${src.name} (copy)`;
  if (!name) for (let i = 2; db.select().from(workflows).where(eq(workflows.name, n)).get(); i++) n = `${src.name} (copy ${i})`;
  return createWorkflow(db, { meta: { name: n, description: src.description, category: src.category === "built-in" ? null : src.category, tags: JSON.parse(src.tagsJson) as string[] }, definition: JSON.parse(src.definitionJson) });
}

/** Saves metadata and/or the definition. The version moves only when the definition changes. The built-in workflow is read-only. */
export function updateWorkflow(db: FactoryDb, id: string, patch: { meta?: Partial<WorkflowMeta> & { enabled?: boolean }; definition?: unknown }): WorkflowRow {
  const cur = getWorkflow(db, id);
  if (!cur) throw new WorkflowError(`no such workflow ${id}`, "not_found");
  if (cur.builtin) throw new WorkflowError("the built-in Default Workflow is read-only: duplicate it and edit the copy", "protected");
  const set: Partial<typeof workflows.$inferInsert> = { updatedAt: new Date() };
  if (patch.meta?.name !== undefined) { const name = WorkflowMeta.shape.name.parse(patch.meta.name); checkName(db, name, id); set.name = name; }
  if (patch.meta?.description !== undefined) set.description = WorkflowMeta.shape.description.parse(patch.meta.description);
  if (patch.meta?.category !== undefined) set.category = WorkflowMeta.shape.category.parse(patch.meta.category) ?? null;
  if (patch.meta?.tags !== undefined) set.tagsJson = JSON.stringify(WorkflowMeta.shape.tags.parse(patch.meta.tags));
  if (patch.meta?.enabled !== undefined) set.enabled = patch.meta.enabled;
  if (patch.definition !== undefined) {
    const json = JSON.stringify(checked(patch.definition));
    if (json !== cur.definitionJson) { set.definitionJson = json; set.version = cur.version + 1; }
  }
  return db.transaction((tx) => {
    tx.update(workflows).set(set).where(eq(workflows.id, id)).run();
    const row = tx.select().from(workflows).where(eq(workflows.id, id)).get()!;
    recordVersion(tx as unknown as FactoryDb, row);
    return row;
  });
}

export function usageOf(db: FactoryDb, id: string): WorkflowUsage {
  const a = db.select().from(workflowAssignments).where(eq(workflowAssignments.workflowId, id)).all();
  const activeJobs = db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.workflowId, id), inArray(jobs.status, [...ACTIVE]))).all().length;
  return {
    projects: a.filter((x) => x.scope === "project").map((x) => x.targetId).sort(),
    labels: a.filter((x) => x.scope === "label").map((x) => ({ id: x.targetId, name: x.targetName, priority: x.priority })).sort((x, y) => x.priority - y.priority || x.id.localeCompare(y.id)),
    activeJobs, isGlobalDefault: getSettings(db).defaultWorkflowId === id,
  };
}

/** Disabling: refused for the built-in; assignments to it stay (and make matching tickets wait, visibly) until a person changes them. */
export function setEnabled(db: FactoryDb, id: string, enabled: boolean): WorkflowRow {
  const cur = getWorkflow(db, id);
  if (cur?.builtin && !enabled) throw new WorkflowError("the built-in Default Workflow cannot be disabled", "protected");
  return updateWorkflow(db, id, { meta: { enabled } });
}

/**
 * Deleting: never the built-in, never the global default, never one an active job is running. One that is assigned is refused unless
 * `removeAssignments` says the person has seen what uses it (the assignments go with it).
 */
export function deleteWorkflow(db: FactoryDb, id: string, opts: { removeAssignments?: boolean } = {}): void {
  const cur = getWorkflow(db, id);
  if (!cur) throw new WorkflowError(`no such workflow ${id}`, "not_found");
  if (cur.builtin) throw new WorkflowError("the built-in Default Workflow cannot be deleted", "protected");
  const usage = usageOf(db, id);
  if (usage.isGlobalDefault) throw new WorkflowError("it is the global default workflow: choose another default first", "in_use", [], usage);
  if (usage.activeJobs) throw new WorkflowError(`${usage.activeJobs} active job(s) are running it: let them finish or cancel them first`, "in_use", [], usage);
  if ((usage.projects.length || usage.labels.length) && !opts.removeAssignments) throw new WorkflowError(`it is assigned to ${usage.projects.length} project(s) and ${usage.labels.length} label(s)`, "in_use", [], usage);
  db.transaction((tx) => {
    tx.delete(workflowAssignments).where(eq(workflowAssignments.workflowId, id)).run();
    // Jobs keep their own snapshot, so deleting the workflow never changes what a finished or running job shows.
    tx.delete(workflowVersions).where(eq(workflowVersions.workflowId, id)).run();
    tx.delete(workflows).where(eq(workflows.id, id)).run();
  });
}

export function versionsOf(db: FactoryDb, id: string) {
  return db.select({ version: workflowVersions.version, name: workflowVersions.name, createdAt: workflowVersions.createdAt }).from(workflowVersions).where(eq(workflowVersions.workflowId, id)).orderBy(asc(workflowVersions.version)).all()
    .map((v) => ({ ...v, createdAt: v.createdAt.getTime() }));
}

// ---- assignments and settings ----
export const getSettings = (db: FactoryDb) => {
  db.insert(workflowSettings).values({ id: 1 }).onConflictDoNothing().run();
  return db.select().from(workflowSettings).where(eq(workflowSettings.id, 1)).get()!;
};

export function updateSettings(db: FactoryDb, patch: { defaultWorkflowId?: string; labelConflictPolicy?: "block" | "project" | "tiebreak" }) {
  if (patch.defaultWorkflowId !== undefined) {
    const w = getWorkflow(db, patch.defaultWorkflowId);
    if (!w) throw new WorkflowError(`no such workflow ${patch.defaultWorkflowId}`, "not_found");
    if (!w.enabled) throw new WorkflowError("a disabled workflow cannot be the global default", "invalid");
    if (!validateDefinition(JSON.parse(w.definitionJson)).ok) throw new WorkflowError("that workflow is not valid", "invalid");
  }
  getSettings(db);
  db.update(workflowSettings).set({ ...patch, updatedAt: new Date() }).where(eq(workflowSettings.id, 1)).run();
  return getSettings(db);
}

export type Assignment = typeof workflowAssignments.$inferSelect;
export const listAssignments = (db: FactoryDb): Assignment[] => db.select().from(workflowAssignments).orderBy(asc(workflowAssignments.scope), asc(workflowAssignments.priority), asc(workflowAssignments.targetId)).all();

/** Points a project or a label (by its stable tracker id) at a workflow. Replaces any earlier assignment of the same target. */
export function assign(db: FactoryDb, a: { scope: "project" | "label"; targetId: string; workflowId: string; targetName?: string | null; priority?: number }): Assignment {
  const w = getWorkflow(db, a.workflowId);
  if (!w) throw new WorkflowError(`no such workflow ${a.workflowId}`, "not_found");
  if (!w.enabled) throw new WorkflowError(`"${w.name}" is disabled: enable it before assigning it`, "invalid");
  if (!a.targetId.trim() || a.targetId.length > 200) throw new WorkflowError("a target id is required", "invalid");
  const priority = Math.min(Math.max(Math.trunc(a.priority ?? 100), 0), 10_000);
  const now = new Date();
  db.insert(workflowAssignments).values({ scope: a.scope, targetId: a.targetId, targetName: a.targetName ?? null, workflowId: a.workflowId, priority: a.scope === "label" ? priority : 100 })
    .onConflictDoUpdate({ target: [workflowAssignments.scope, workflowAssignments.targetId], set: { workflowId: a.workflowId, ...(a.targetName !== undefined ? { targetName: a.targetName } : {}), ...(a.scope === "label" && a.priority !== undefined ? { priority } : {}), updatedAt: now } }).run();
  return db.select().from(workflowAssignments).where(and(eq(workflowAssignments.scope, a.scope), eq(workflowAssignments.targetId, a.targetId))).get()!;
}

export function unassign(db: FactoryDb, scope: "project" | "label", targetId: string): boolean {
  return db.delete(workflowAssignments).where(and(eq(workflowAssignments.scope, scope), eq(workflowAssignments.targetId, targetId))).run().changes > 0;
}
