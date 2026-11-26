import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePoll } from "@/hooks/usePoll";
import { api } from "@/lib/api";
import { assignWorkflow, saveWorkflowSettings, unassignWorkflow } from "@/lib/workflow-api";
import type { AssignedLabel, ConflictPolicy, TrackerLabel, WorkflowList } from "@/lib/workflows";
import type { Project } from "@/lib/types";
import { NumField, Pick } from "./fields";
import { WorkflowSelect } from "./WorkflowSelect";
import { cn } from "@/lib/utils";

const POLICIES: { v: ConflictPolicy; label: string; hint: string }[] = [
  { v: "block", label: "Block", hint: "Do not start the ticket and say why, until someone fixes the labels or their priorities." },
  { v: "project", label: "Use the project's workflow", hint: "Ignore the conflicting labels and use the workflow assigned to the ticket's project (or the global default)." },
  { v: "tiebreak", label: "Tie-break", hint: "Pick the workflow whose id sorts first, so the choice is always the same." },
];

/** Which workflow runs which ticket: the global default, the conflict policy, project assignments and label assignments. */
export function RoutingPanel({ data, reload }: { data: WorkflowList; reload: () => Promise<void> }) {
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<{ ok: boolean } & { error?: string }>) => { setErr(null); const r = await fn(); if (!r.ok) setErr(r.error ?? "failed"); await reload(); };
  const { data: lab, error: labErr, reload: reloadLabels } = usePoll((s) => api<{ labels: TrackerLabel[]; assigned: AssignedLabel[] }>("/api/workflows/labels", s), 120000);
  const { data: projs } = usePoll((s) => api<{ projects: Project[] }>("/api/projects", s), 60000);
  const enabled = data.workflows.filter((w) => w.enabled && w.valid);
  const byId = new Map(data.workflows.map((w) => [w.id, w]));
  const labelRows: AssignedLabel[] = lab?.assigned ?? data.assignments.filter((a) => a.scope === "label").map((a) => ({ id: a.targetId, name: a.targetName, workflowId: a.workflowId, priority: a.priority, foundInTracker: true }));
  const sorted = [...labelRows].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const teamsOf = (id: string) => lab?.labels.find((l) => l.id === id)?.teams.join(", ");
  const projectAssign = new Map(data.assignments.filter((a) => a.scope === "project").map((a) => [a.targetId, a.workflowId]));
  const [newLabel, setNewLabel] = useState<string | undefined>(), [newWf, setNewWf] = useState<string | undefined>(), [newPrio, setNewPrio] = useState<number | undefined>(100);
  useEffect(() => { if (newWf === undefined && enabled[0]) setNewWf(enabled[0].id); }, [enabled, newWf]);
  const free = (lab?.labels ?? []).filter((l) => !labelRows.some((r) => r.id === l.id));
  const setLabel = useCallback(async (row: AssignedLabel, patch: { workflowId?: string; priority?: number }) => { await run(() => assignWorkflow({ scope: "label", targetId: row.id, targetName: row.name, workflowId: patch.workflowId ?? row.workflowId, priority: patch.priority ?? row.priority })); await reloadLabels(); }, [reloadLabels]); 
  const chosen = free.find((l) => l.id === newLabel);

  return (
    <div className="grid gap-4">
      {err ? <Alert variant="destructive" role="alert"><AlertDescription>{err}</AlertDescription></Alert> : null}
      <Card><CardHeader><CardTitle className="text-sm">How a ticket gets its workflow</CardTitle></CardHeader>
        <CardContent><ol className="grid list-decimal gap-1 pl-5 text-sm" aria-label="resolution order">
          <li><b>Label.</b> If the ticket carries a label assigned to a workflow below, that workflow is used. Labels are matched by their tracker id, not their name. If several labels point at different workflows, the lowest priority number wins; a tie is settled by the conflict policy.</li>
          <li><b>Project.</b> Otherwise the workflow assigned to the ticket's project (set on the project, or here).</li>
          <li><b>Global default.</b> Otherwise the global default workflow below (the built-in Default Workflow unless you choose another).</li>
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">A workflow that is missing, disabled or invalid is never swapped for another: the ticket waits and says why until the assignment is fixed. Each job keeps the version it started with.</p></CardContent></Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle className="text-sm">Global default</CardTitle><CardDescription>Used when neither a label nor the project picks a workflow.</CardDescription></CardHeader>
          <CardContent><WorkflowSelect label="Global default workflow" workflows={enabled.some((w) => w.id === data.settings.defaultWorkflowId) ? enabled : [...enabled, ...(byId.get(data.settings.defaultWorkflowId) ? [byId.get(data.settings.defaultWorkflowId)!] : [])]} value={data.settings.defaultWorkflowId} onChange={(id) => id && void run(() => saveWorkflowSettings({ defaultWorkflowId: id }))} /></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">When labels disagree</CardTitle><CardDescription>Only applies when a ticket's labels point at different workflows with the same priority.</CardDescription></CardHeader>
          <CardContent className="grid gap-2">
            <Pick label="Label conflict policy" value={data.settings.labelConflictPolicy} onChange={(v) => v && void run(() => saveWorkflowSettings({ labelConflictPolicy: v as ConflictPolicy }))} options={POLICIES.map((p) => ({ value: p.v, label: p.label }))} className="w-72" />
            <p className="text-xs text-muted-foreground">{POLICIES.find((p) => p.v === data.settings.labelConflictPolicy)?.hint}</p>
            <ul className="grid gap-0.5 text-xs text-muted-foreground">{POLICIES.map((p) => <li key={p.v}><b>{p.label}:</b> {p.hint}</li>)}</ul>
          </CardContent></Card>
      </div>

      <Card><CardHeader><CardTitle className="text-sm">Label assignments</CardTitle><CardDescription>A ticket with one of these labels runs the workflow shown. Lower priority number wins when a ticket has several.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          {labErr ? <Alert role="status"><AlertDescription>Could not read the tracker's labels ({labErr}). Existing assignments still apply; you can only add new ones once the tracker is reachable.</AlertDescription></Alert> : null}
          <div className="overflow-x-auto"><Table>
            <TableHeader><TableRow>{["Label", "Team", "Triggers", "Priority", ""].map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <TableRow key={r.id}>
                  <TableCell><div className="font-medium">{r.name ?? r.id}</div><div className="font-mono text-[11px] text-muted-foreground">{r.id}</div>{!r.foundInTracker ? <Badge variant="outline" className="mt-1 gap-1 border-loop/50 text-loop"><AlertTriangle className="size-3" />not found in the tracker</Badge> : null}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{teamsOf(r.id) ?? ""}</TableCell>
                  <TableCell><WorkflowSelect label={`Workflow for label ${r.name ?? r.id}`} workflows={data.workflows} value={r.workflowId} onChange={(id) => id && void setLabel(r, { workflowId: id })} /></TableCell>
                  <TableCell><NumField label={`Priority of label ${r.name ?? r.id}`} value={r.priority} min={0} max={10000} onChange={(n) => n !== undefined && n !== r.priority && void setLabel(r, { priority: n })} className="w-24" /></TableCell>
                  <TableCell><Button variant="ghost" size="sm" aria-label={`Remove the assignment of label ${r.name ?? r.id}`} onClick={() => void run(() => unassignWorkflow("label", r.id)).then(() => reloadLabels())}><Trash2 /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></div>
          {sorted.length === 0 ? <p className="text-sm text-muted-foreground">No label triggers a workflow yet.</p> : null}
          <div className="grid gap-2 rounded-md border bg-muted/20 p-3" aria-label="Assign a label">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Assign a tracker label</div>
            <div className="flex flex-wrap items-center gap-2">
              <Pick label="Tracker label" value={newLabel} onChange={setNewLabel} empty="Choose a label…" className="w-64" options={free.map((l) => ({ value: l.id, label: `${l.name}${l.teams.length ? ` (${l.teams.join(", ")})` : ""}` }))} />
              <span className="text-sm text-muted-foreground">runs</span>
              <WorkflowSelect label="Workflow to assign" workflows={enabled} value={newWf} onChange={setNewWf} />
              <span className="text-sm text-muted-foreground">priority</span>
              <NumField label="New assignment priority" value={newPrio} min={0} max={10000} onChange={setNewPrio} className="w-24" />
              <Button size="sm" disabled={!chosen || !newWf} onClick={() => { if (chosen && newWf) void run(() => assignWorkflow({ scope: "label", targetId: chosen.id, targetName: chosen.name, workflowId: newWf, priority: newPrio ?? 100 })).then(async () => { setNewLabel(undefined); await reloadLabels(); }); }}><Plus />Assign</Button>
            </div>
            {lab && lab.labels.length === 0 && !labErr ? <p className="text-xs text-muted-foreground">The tracker reported no labels (or no tracker is connected).</p> : null}
          </div>
        </CardContent></Card>

      <Card><CardHeader><CardTitle className="text-sm">Projects</CardTitle><CardDescription>The workflow each project uses when the ticket's labels do not choose one. Empty: the global default. The same setting is in each project's editor.</CardDescription></CardHeader>
        <CardContent className="grid gap-2">
          {(projs?.projects ?? []).map((p) => (
            <div key={p.id} className={cn("flex flex-wrap items-center gap-3")}><span className="w-48 truncate text-sm font-medium" title={p.id}>{p.name}</span>
              <WorkflowSelect label={`Workflow for project ${p.name}`} workflows={data.workflows} value={projectAssign.get(p.id)} empty={`Use the global default (${byId.get(data.settings.defaultWorkflowId)?.name ?? data.settings.defaultWorkflowId})`} className="w-80"
                onChange={(id) => void run(() => (id ? assignWorkflow({ scope: "project", targetId: p.id, workflowId: id }) : unassignWorkflow("project", p.id)))} /></div>
          ))}
          {projs && projs.projects.length === 0 ? <p className="text-sm text-muted-foreground">No projects yet.</p> : null}
        </CardContent></Card>
    </div>
  );
}
