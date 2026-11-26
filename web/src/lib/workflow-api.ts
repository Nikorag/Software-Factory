import { send, type SendResult } from "./api";
import type { AssignmentRow, ConflictPolicy, Issue, WorkflowDef, WorkflowFull, WorkflowUsage } from "./workflows";

const enc = encodeURIComponent;
export interface ValidateResponse { ok: boolean; errors: Issue[]; warnings: Issue[]; definition?: WorkflowDef }
export interface MetaInput { name: string; description?: string; category?: string | null; tags?: string[] }

/** Mutations go through send(), which adds the same-origin header the server requires. */
export const validateDefinition = (definition: unknown) => send<ValidateResponse>("POST", "/api/workflows/validate", { definition });
export const createWorkflow = (meta: MetaInput, from?: string) => send<{ workflow: WorkflowFull }>("POST", "/api/workflows", { meta, ...(from ? { from } : {}) });
export const duplicateWorkflow = (id: string, name?: string) => send<{ workflow: WorkflowFull }>("POST", `/api/workflows/${enc(id)}/duplicate`, name ? { name } : {});
export const saveWorkflow = (id: string, body: { meta?: Partial<MetaInput> & { enabled?: boolean }; definition?: WorkflowDef }) => send<{ workflow: WorkflowFull }>("PUT", `/api/workflows/${enc(id)}`, body);
export const setWorkflowEnabled = (id: string, enabled: boolean) => send("POST", `/api/workflows/${enc(id)}/${enabled ? "enable" : "disable"}`);
/** 409 carries `usage`, so the dialog can show exactly what blocks the delete. */
export async function deleteWorkflow(id: string, removeAssignments = false): Promise<SendResult & { usage?: WorkflowUsage | null }> {
  try {
    const res = await fetch(`/api/workflows/${enc(id)}${removeAssignments ? "?removeAssignments=1" : ""}`, { method: "DELETE", headers: { "X-Factory-UI": "1" } });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string; usage?: WorkflowUsage | null };
    return res.ok ? { ok: true, data } : { ok: false, error: data.error || `HTTP ${res.status}`, ...(data.code ? { code: data.code } : {}), usage: data.usage ?? null };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
export const assignWorkflow = (a: { scope: "project" | "label"; targetId: string; targetName?: string | null; workflowId: string; priority?: number }) => send<{ assignment: AssignmentRow }>("PUT", "/api/workflows/assignments", a);
export const unassignWorkflow = (scope: "project" | "label", targetId: string) => send("DELETE", `/api/workflows/assignments?scope=${scope}&targetId=${enc(targetId)}`);
export const saveWorkflowSettings = (s: { defaultWorkflowId?: string; labelConflictPolicy?: ConflictPolicy }) => send("PUT", "/api/workflows/settings", s);
