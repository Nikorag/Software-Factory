import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Copy, Lock, Plus, Search, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { DeleteWorkflowDialog } from "@/components/workflow/DeleteWorkflowDialog";
import { NewWorkflowDialog } from "@/components/workflow/NewWorkflowDialog";
import { RoutingPanel } from "@/components/workflow/RoutingPanel";
import { usePoll } from "@/hooks/usePoll";
import { api } from "@/lib/api";
import { usageParts } from "@/lib/describe";
import { ago } from "@/lib/format";
import { duplicateWorkflow, setWorkflowEnabled } from "@/lib/workflow-api";
import type { WorkflowList, WorkflowListItem } from "@/lib/workflows";
import { matches } from "@/lib/paging";

function Library({ data, reload }: { data: WorkflowList; reload: () => Promise<void> }) {
  const nav = useNavigate();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<WorkflowListItem | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = useMemo(() => data.workflows.filter((w) => matches(filter, w.name, w.description, w.category, w.tags.join(" "))), [data.workflows, filter]);
  const toggle = async (w: WorkflowListItem, on: boolean) => { setBusy(w.id); setMsg(null); const r = await setWorkflowEnabled(w.id, on); setBusy(null); if (!r.ok) setMsg(r.error); await reload(); };
  const dup = async (w: WorkflowListItem) => { setBusy(w.id); setMsg(null); const r = await duplicateWorkflow(w.id); setBusy(null); if (r.ok) nav(`/workflows/${encodeURIComponent(r.data.workflow.id)}`); else setMsg(r.error); };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Filter workflows" className="pl-8" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, category or tag" /></div>
        <span className="flex-1" />
        <Button size="sm" onClick={() => setCreating(true)}><Plus />New workflow</Button>
      </div>
      {msg ? <Alert variant="destructive" role="alert"><AlertDescription>{msg}</AlertDescription></Alert> : null}
      <Card><CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader><TableRow>{["Workflow", "Version", "Stages", "Status", "Used by", "Updated", "On", ""].map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {rows.map((w) => {
              const used = usageParts(w.usage);
              return (
                <TableRow key={w.id}>
                  <TableCell className="max-w-sm whitespace-normal">
                    <Link to={`/workflows/${encodeURIComponent(w.id)}`} className="font-medium hover:underline">{w.name}</Link>
                    {w.builtin ? <Badge variant="secondary" className="ml-2 gap-1"><Lock className="size-3" />built in</Badge> : null}
                    {w.description ? <p className="line-clamp-2 text-xs text-muted-foreground">{w.description}</p> : null}
                    {w.category || w.tags.length ? <div className="mt-1 flex flex-wrap gap-1">{w.category ? <Badge variant="outline">{w.category}</Badge> : null}{w.tags.map((t) => <Badge key={t} variant="outline" className="font-normal">{t}</Badge>)}</div> : null}
                  </TableCell>
                  <TableCell className="tabular-nums">v{w.version}</TableCell>
                  <TableCell className="tabular-nums">{w.stageCount}</TableCell>
                  <TableCell><div className="flex flex-wrap gap-1"><Badge variant="outline" className={w.enabled ? "border-ok/40 text-ok" : "text-muted-foreground"}>{w.enabled ? "enabled" : "disabled"}</Badge>{w.valid ? null : <Badge variant="outline" className="border-destructive/50 text-destructive">invalid</Badge>}</div></TableCell>
                  <TableCell className="text-xs" aria-label={`usage of ${w.name}`}>{used.length ? used.join(" · ") : <span className="text-muted-foreground">not used</span>}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{ago(w.updatedAt)}</TableCell>
                  <TableCell><Switch checked={w.enabled} disabled={w.builtin || busy === w.id} onCheckedChange={(c) => void toggle(w, c)} aria-label={`${w.enabled ? "Disable" : "Enable"} ${w.name}`} title={w.builtin ? "The built-in workflow is always enabled" : undefined} /></TableCell>
                  <TableCell><div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" disabled={busy === w.id} aria-label={`Duplicate ${w.name}`} onClick={() => void dup(w)}><Copy />Duplicate</Button>
                    {w.builtin ? null : <Button variant="ghost" size="sm" aria-label={`Delete ${w.name}`} onClick={() => { setMsg(null); setDeleting(w); }}><Trash2 /></Button>}
                  </div></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{data.workflows.length ? `No workflow matches “${filter}”.` : "No workflows yet."}</p> : null}
      </CardContent></Card>
      <p className="text-xs text-muted-foreground">The built-in Default Workflow is read-only and cannot be deleted: duplicate it to make your own. Which workflow a ticket uses is decided under <b>Routing</b> (label, then project, then the global default).</p>
      <NewWorkflowDialog open={creating} onClose={() => setCreating(false)} workflows={data.workflows} />
      <DeleteWorkflowDialog workflow={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); void reload(); }} />
    </div>
  );
}

export function Workflows() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "library";
  const { data, error, updatedAt, reload } = usePoll((signal) => api<WorkflowList>("/api/workflows", signal), 10000);
  return (
    <div className="grid gap-4">
      <div><h2 className="text-lg font-semibold">Workflows</h2><p className="text-sm text-muted-foreground">The steps a ticket goes through, and how each one is configured. Pick which workflow a project or a ticket label uses under Routing.</p></div>
      <ConnectionBanner error={error} updatedAt={updatedAt} what="workflows" />
      {!data ? <Skeleton className="h-64 w-full" /> : (
        <Tabs value={tab} onValueChange={(v) => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", v); return n; }, { replace: true })}>
          <TabsList><TabsTrigger value="library">Library</TabsTrigger><TabsTrigger value="routing">Routing</TabsTrigger></TabsList>
          <TabsContent value="library"><Library data={data} reload={async () => { await reload(); }} /></TabsContent>
          <TabsContent value="routing"><RoutingPanel data={data} reload={async () => { await reload(); }} /></TabsContent>
        </Tabs>
      )}
    </div>
  );
}
