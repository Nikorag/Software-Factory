import { eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { workflowAssignments } from "../db/schema.js";
import { buildDefaultDefinition, DEFAULT_WORKFLOW_ID } from "./default.js";
import type { WorkflowDefinition } from "./definition.js";
import { CompiledWorkflow } from "./graph.js";
import { getSettings, getWorkflow, type WorkflowRow } from "./library.js";
import { validateDefinition } from "./validate.js";
import type { WorkflowsConfig } from "../config/schema.js";

export interface TicketLabel { id: string; name: string }

export interface ResolutionRecord {
  source: "label" | "project" | "default";
  reason: string;
  matchedLabels: { id: string; name: string; priority: number; workflowId: string }[];
  /** Set when several labels pointed at different workflows. */
  conflict?: { policy: string; outcome: "priority" | "project" | "tiebreak" | "blocked"; candidates: { workflowId: string; labelId: string; priority: number }[] };
}

export type Resolution =
  | { ok: true; workflowId: string; workflowName: string; version: number; definition: WorkflowDefinition; entryStage: string; record: ResolutionRecord }
  | { ok: false; code: "unavailable" | "invalid" | "conflict"; reason: string; record: ResolutionRecord };

const assignmentFor = (db: FactoryDb, scope: "project" | "label", id: string) =>
  db.select().from(workflowAssignments).where(eq(workflowAssignments.scope, scope)).all().find((a) => a.targetId === id);

/** The assigned workflow, if it can run a job: it exists, is enabled and still validates. Never substitutes another. */
function usable(row: WorkflowRow | undefined, label: string): { ok: true; row: WorkflowRow; definition: WorkflowDefinition } | { ok: false; code: "unavailable" | "invalid"; reason: string } {
  if (!row) return { ok: false, code: "unavailable", reason: `${label} points at a workflow that no longer exists` };
  if (!row.enabled) return { ok: false, code: "unavailable", reason: `${label} points at "${row.name}", which is disabled` };
  const v = validateDefinition(JSON.parse(row.definitionJson));
  if (!v.ok) return { ok: false, code: "invalid", reason: `${label} points at "${row.name}", whose definition is not valid (${v.errors[0]?.path}: ${v.errors[0]?.message})` };
  return { ok: true, row, definition: v.definition };
}

/**
 * Chooses the workflow for a ticket, in this order:
 *  1. Workflows assigned to the ticket's labels (matched by stable label id). Labels naming the same workflow count once. Different
 *     workflows: the lowest `priority` number wins; a tie between different workflows follows the conflict policy
 *     (block: do not start the ticket / project: use the project's workflow / tiebreak: the workflow whose id sorts first).
 *  2. The project's assigned workflow.
 *  3. The global default (the built-in Default Workflow unless another was chosen).
 * The order Linear returns labels in never matters. A chosen workflow that is missing, disabled or invalid is reported, never swapped
 * for another: the ticket waits (and says why) until a person fixes the assignment.
 */
export function resolveWorkflow(db: FactoryDb, input: { projectId: string; labels: readonly TicketLabel[] }, fallbackPolicy?: WorkflowsConfig): Resolution {
  const settings = getSettings(db);
  const byLabel = new Map(db.select().from(workflowAssignments).where(eq(workflowAssignments.scope, "label")).all().map((a) => [a.targetId, a]));
  const matched = [...new Map(input.labels.filter((l) => byLabel.has(l.id)).map((l) => [l.id, l])).values()]
    .map((l) => { const a = byLabel.get(l.id)!; return { id: l.id, name: l.name, priority: a.priority, workflowId: a.workflowId }; })
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const record: ResolutionRecord = { source: "default", reason: "", matchedLabels: matched };

  const accept = (row: WorkflowRow, definition: WorkflowDefinition, source: ResolutionRecord["source"], reason: string): Resolution => {
    const c = new CompiledWorkflow(definition);
    return { ok: true, workflowId: row.id, workflowName: row.name, version: row.version, definition, entryStage: c.entry, record: { ...record, source, reason } };
  };
  const reject = (code: "unavailable" | "invalid" | "conflict", reason: string): Resolution => ({ ok: false, code, reason, record: { ...record, reason } });
  const label = (m: { name: string; id: string }) => `label "${m.name}" (${m.id})`;

  let choice: (typeof matched)[number] | undefined;
  if (matched.length) {
    const distinct = [...new Set(matched.map((m) => m.workflowId))];
    if (distinct.length === 1) choice = matched[0];
    else {
      const top = matched[0]!.priority;
      const contenders = matched.filter((m) => m.priority === top);
      const candidates = matched.map((m) => ({ workflowId: m.workflowId, labelId: m.id, priority: m.priority }));
      if (new Set(contenders.map((m) => m.workflowId)).size === 1) {
        choice = contenders[0];
        record.conflict = { policy: "priority", outcome: "priority", candidates };
      } else if (settings.labelConflictPolicy === "tiebreak") {
        choice = [...contenders].sort((a, b) => a.workflowId.localeCompare(b.workflowId) || a.id.localeCompare(b.id))[0];
        record.conflict = { policy: "tiebreak", outcome: "tiebreak", candidates };
      } else if (settings.labelConflictPolicy === "project") {
        record.conflict = { policy: "project", outcome: "project", candidates };
      } else {
        record.conflict = { policy: "block", outcome: "blocked", candidates };
        return reject("conflict", `labels ${contenders.map((m) => `"${m.name}"`).join(" and ")} point at different workflows with the same priority (${top}), and the conflict policy is "block". Give one of them a lower priority number, or change the policy, in Settings → Workflows.`);
      }
    }
  }
  if (choice) {
    const u = usable(getWorkflow(db, choice.workflowId), label(choice));
    if (!u.ok) return reject(u.code, u.reason);
    const others = matched.length > 1 ? ` (also matched ${matched.filter((m) => m !== choice).map((m) => `"${m.name}"`).join(", ")}; ${record.conflict?.outcome === "priority" ? "priority decided" : record.conflict?.outcome === "tiebreak" ? "tie broken by workflow id" : "same workflow"})` : "";
    return accept(u.row, u.definition, "label", `${label(choice)} is assigned to "${u.row.name}"${others}`);
  }

  const pa = assignmentFor(db, "project", input.projectId);
  if (pa) {
    const u = usable(getWorkflow(db, pa.workflowId), `project ${input.projectId}`);
    if (!u.ok) return reject(u.code, u.reason);
    return accept(u.row, u.definition, "project", record.conflict?.outcome === "project" ? `labels conflicted, so the project's workflow "${u.row.name}" was used` : `project ${input.projectId} is assigned to "${u.row.name}"${matched.length ? "" : " and no label has an assignment"}`);
  }

  // The global fallback. A configured default that cannot run falls back to the built-in one (always valid), and says so.
  const configured = usable(getWorkflow(db, settings.defaultWorkflowId), "the global default");
  if (configured.ok) return accept(configured.row, configured.definition, "default", `no label or project assignment applies: the global default "${configured.row.name}"`);
  const builtin = getWorkflow(db, DEFAULT_WORKFLOW_ID);
  const b = usable(builtin, "the built-in Default Workflow");
  if (b.ok) return accept(b.row, b.definition, "default", `no assignment applies, and ${configured.reason}: using the built-in Default Workflow`);
  if (fallbackPolicy) { // a database that has not been seeded yet (tests, first run): the built-in definition from code
    const definition = buildDefaultDefinition(fallbackPolicy);
    return { ok: true, workflowId: DEFAULT_WORKFLOW_ID, workflowName: "Default Workflow", version: 0, definition, entryStage: new CompiledWorkflow(definition).entry, record: { ...record, source: "default", reason: "no assignment applies: the built-in Default Workflow" } };
  }
  return reject("unavailable", `${b.reason}: restart the factory to restore it`);
}
