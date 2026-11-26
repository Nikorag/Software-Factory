import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { hasAssignments } from "@/lib/describe";
import { deleteWorkflow } from "@/lib/workflow-api";
import type { WorkflowListItem, WorkflowUsage } from "@/lib/workflows";

function Usage({ u }: { u: WorkflowUsage }) {
  return (
    <ul className="grid gap-1 text-sm" aria-label="usage">
      {u.isGlobalDefault ? <li>It is the <b>global default</b> workflow.</li> : null}
      {u.projects.length ? <li>Assigned to project{u.projects.length === 1 ? "" : "s"}: <b>{u.projects.join(", ")}</b>.</li> : null}
      {u.labels.length ? <li>Assigned to label{u.labels.length === 1 ? "" : "s"}: <b>{u.labels.map((l) => l.name ?? l.id).join(", ")}</b>.</li> : null}
      {u.activeJobs ? <li><b>{u.activeJobs}</b> active job{u.activeJobs === 1 ? " is" : "s are"} running it.</li> : null}
      {!u.isGlobalDefault && !u.projects.length && !u.labels.length && !u.activeJobs ? <li className="text-muted-foreground">Nothing uses it.</li> : null}
    </ul>
  );
}

/** Confirms a delete and shows what the server says is using the workflow. If assignments block it, offers to delete and remove them. */
export function DeleteWorkflowDialog({ workflow, onClose, onDeleted }: { workflow: WorkflowListItem | null; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [usage, setUsage] = useState<WorkflowUsage | null>(null);
  const u = usage ?? workflow?.usage ?? null;
  const run = async (removeAssignments: boolean) => {
    if (!workflow || busy) return;
    setBusy(true); setErr(null);
    const r = await deleteWorkflow(workflow.id, removeAssignments);
    setBusy(false);
    if (r.ok) { setUsage(null); onDeleted(); return; }
    setErr(r.error);
    if (r.usage) setUsage(r.usage);
  };
  const close = () => { setErr(null); setUsage(null); onClose(); };
  const blockedHard = Boolean(u && (u.isGlobalDefault || u.activeJobs > 0));
  return (
    <Dialog open={workflow !== null} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Delete “{workflow?.name}”?</DialogTitle><DialogDescription>Jobs keep their own copy of the workflow, so finished and running jobs are not affected. Deleting cannot be undone.</DialogDescription></DialogHeader>
        {u ? <Usage u={u} /> : null}
        {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
        {blockedHard ? <p className="text-xs text-muted-foreground">{u!.isGlobalDefault ? "Choose another global default first (Workflow routing). " : ""}{u!.activeJobs ? "Let the active jobs finish or cancel them first." : ""}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={close}>Keep it</Button>
          {err && u && hasAssignments(u) && !blockedHard ? <Button variant="destructive" disabled={busy} onClick={() => void run(true)}>Delete and remove its assignments</Button> : <Button variant="destructive" disabled={busy || blockedHard} onClick={() => void run(false)}>Delete</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
