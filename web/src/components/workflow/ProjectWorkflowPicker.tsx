import { useState } from "react";
import { Link } from "react-router-dom";
import { usePoll } from "@/hooks/usePoll";
import { api } from "@/lib/api";
import { assignWorkflow, unassignWorkflow } from "@/lib/workflow-api";
import type { WorkflowList } from "@/lib/workflows";
import { WorkflowSelect } from "./WorkflowSelect";

/** The project's workflow: saved straight away (it is not part of the project's own settings). Clearing it falls back to the global default. */
export function ProjectWorkflowPicker({ projectId }: { projectId: string }) {
  const { data, reload } = usePoll((s) => api<WorkflowList>("/api/workflows", s), 60000);
  const [err, setErr] = useState<string | null>(null), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false);
  if (!data) return <p className="text-xs text-muted-foreground">Loading workflows…</p>;
  const current = data.assignments.find((a) => a.scope === "project" && a.targetId === projectId)?.workflowId;
  const def = data.workflows.find((w) => w.id === data.settings.defaultWorkflowId);
  const change = async (id: string | undefined) => {
    setBusy(true); setErr(null); setSaved(false);
    const r = id ? await assignWorkflow({ scope: "project", targetId: projectId, workflowId: id }) : await unassignWorkflow("project", projectId);
    setBusy(false);
    if (r.ok) { setSaved(true); await reload(); } else setErr(r.error);
  };
  return (
    <div className="grid gap-1.5">
      <WorkflowSelect label="Workflow" workflows={current ? data.workflows : data.workflows.filter((w) => w.enabled)} value={current} empty={`Use the global default (${def?.name ?? data.settings.defaultWorkflowId})`} className="w-96" disabled={busy} onChange={(id) => void change(id)} />
      {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : saved ? <p role="status" className="text-xs text-ok">Saved. New tickets use it; running jobs keep theirs.</p> : null}
      <p className="text-xs text-muted-foreground">Manage workflows and ticket-label routing in <Link className="underline" to="/workflows">Workflows</Link>.</p>
    </div>
  );
}
