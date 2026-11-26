import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Copy, Loader2, Lock, RotateCcw, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FlowChart, FlowLegend } from "@/components/FlowChart";
import { Field, Issues, Mono, NumField } from "@/components/workflow/fields";
import { StageList } from "@/components/workflow/StageList";
import { StagePanel } from "@/components/workflow/StagePanel";
import { ValidationSummary } from "@/components/workflow/ValidationSummary";
import { useValidation } from "@/hooks/useValidation";
import { api } from "@/lib/api";
import { clone, insertStage, lockedHandlers, moveStage, newStage, removeStage, sameDef, updateStage, workflowIssues } from "@/lib/draft";
import { layoutDefinition } from "@/lib/graph";
import { duplicateWorkflow, saveWorkflow } from "@/lib/workflow-api";
import type { StageDef, StageType, WorkflowDef, WorkflowFull, WorkflowsMeta } from "@/lib/workflows";

interface MetaDraft { name: string; description: string; category: string; tags: string; enabled: boolean }
const metaOf = (w: WorkflowFull): MetaDraft => ({ name: w.name, description: w.description, category: w.category ?? "", tags: w.tags.join(", "), enabled: w.enabled });
const tagList = (t: string) => [...new Set(t.split(",").map((x) => x.trim()).filter(Boolean))];

/** Editing state for one workflow: the draft definition and metadata, the saved baseline, and the operations the editor needs on it. */
export function useWorkflowDraft(w: WorkflowFull | null) {
  const [def, setDef] = useState<WorkflowDef | null>(null);
  const [meta, setMeta] = useState<MetaDraft | null>(null);
  const [base, setBase] = useState<{ def: WorkflowDef; meta: MetaDraft } | null>(null);
  useEffect(() => { if (w) { setDef(clone(w.definition)); setMeta(metaOf(w)); setBase({ def: clone(w.definition), meta: metaOf(w) }); } }, [w]);
  const dirty = Boolean(def && meta && base && (!sameDef(def, base.def) || !sameDef(meta, base.meta)));
  const revert = () => { if (base) { setDef(clone(base.def)); setMeta({ ...base.meta }); } };
  return { def, setDef, meta, setMeta, dirty, revert };
}

export function WorkflowEditor() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [w, setW] = useState<WorkflowFull | null>(null);
  const [wm, setWm] = useState<WorkflowsMeta | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const load = useCallback(async () => { try { setW(await api<WorkflowFull>(`/api/workflows/${encodeURIComponent(id)}`)); setLoadErr(null); } catch (e) { setLoadErr((e as Error).message); } }, [id]);
  useEffect(() => { setW(null); void load(); }, [load]);
  useEffect(() => { api<WorkflowsMeta>("/api/workflows/meta").then(setWm).catch((e: Error) => setLoadErr(e.message)); }, []);
  const { def, setDef, meta, setMeta, dirty, revert } = useWorkflowDraft(w && w.id === id ? w : null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const v = useValidation(def);
  const graph = useMemo(() => (def ? layoutDefinition(def) : null), [def]);
  useEffect(() => { if (def && (!sel || !def.stages.some((s) => s.id === sel))) setSel(def.stages[0]?.id ?? null); }, [def, sel]);

  if (loadErr && !w) return <Alert variant="destructive" role="alert"><AlertDescription>Could not load this workflow: {loadErr}</AlertDescription></Alert>;
  if (!w || w.id !== id || !wm || !def || !meta || !graph) return <Skeleton className="h-96 w-full" />;

  const ro = w.builtin;
  const locked = lockedHandlers(def, wm);
  const stage = def.stages.find((s) => s.id === sel) ?? null;
  const fresh = v.for === JSON.stringify(def) && !v.pending;
  const valid = fresh && v.errors.length === 0 && !v.failed;
  const canSave = !ro && dirty && valid && !busy && meta.name.trim().length > 0;
  const setM = (p: Partial<MetaDraft>) => { setMsg(null); setMeta({ ...meta, ...p }); };
  const edit = (next: WorkflowDef) => { setMsg(null); setDef(next); };

  const save = async () => {
    setBusy(true); setMsg(null);
    const r = await saveWorkflow(w.id, { meta: { name: meta.name.trim(), description: meta.description, category: meta.category.trim() || null, tags: tagList(meta.tags), enabled: meta.enabled }, definition: def });
    setBusy(false);
    if (r.ok) { setW(r.data.workflow); setMsg({ tone: "ok", text: `Saved as version ${r.data.workflow.version}. Jobs already running keep the version they started with.` }); } else setMsg({ tone: "error", text: r.error });
  };
  const duplicate = async () => {
    setBusy(true);
    const r = await duplicateWorkflow(w.id);
    setBusy(false);
    if (r.ok) nav(`/workflows/${encodeURIComponent(r.data.workflow.id)}`); else setMsg({ tone: "error", text: r.error });
  };

  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <Link to="/workflows" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />workflows</Link>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{meta.name || "Untitled workflow"}</h2>
        {ro ? <Badge variant="secondary" className="gap-1"><Lock className="size-3" />built in · read-only</Badge> : null}
        <Badge variant="outline">v{w.version}</Badge>
        {!w.enabled ? <Badge variant="outline">disabled</Badge> : null}
        {dirty ? <Badge variant="outline" className="border-loop/50 text-loop">unsaved changes</Badge> : null}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void duplicate()}><Copy />Duplicate</Button>
        {!ro ? <Button variant="outline" size="sm" disabled={!dirty || busy} onClick={() => { revert(); setMsg(null); }}><RotateCcw />Revert</Button> : null}
        {!ro ? <Button size="sm" disabled={!canSave} title={!dirty ? "Nothing to save" : !valid ? "Fix the problems below first" : undefined} onClick={() => void save()}>{busy ? <Loader2 className="animate-spin" /> : <Save />}Save</Button> : null}
      </div>
      {ro ? <Alert><Lock /><AlertDescription>The Default Workflow is the factory's own process and cannot be edited. <b>Duplicate</b> it to make your own copy, then change that.</AlertDescription></Alert> : null}
      {msg ? <Alert variant={msg.tone === "error" ? "destructive" : "default"} role={msg.tone === "error" ? "alert" : "status"}><AlertDescription>{msg.text}</AlertDescription></Alert> : null}
      <ValidationSummary errors={v.errors} warnings={v.warnings} pending={!fresh} failed={v.failed} def={def} onJump={setSel} />

      <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
        <fieldset disabled={ro} className="min-w-0 border-0 p-0"><Card><CardHeader><CardTitle className="text-sm">Details</CardTitle><CardDescription>Used to find and describe the workflow. Id <Mono>{w.id}</Mono>.</CardDescription></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="wf-name"><Input id="wf-name" value={meta.name} maxLength={80} onChange={(e) => setM({ name: e.target.value })} /></Field>
            <Field label="Category" htmlFor="wf-cat" hint="Optional: groups workflows in the library."><Input id="wf-cat" value={meta.category} maxLength={40} onChange={(e) => setM({ category: e.target.value })} /></Field>
            <Field label="Description" htmlFor="wf-desc" className="sm:col-span-2"><Textarea id="wf-desc" rows={2} value={meta.description} maxLength={1000} onChange={(e) => setM({ description: e.target.value })} /></Field>
            <Field label="Tags" htmlFor="wf-tags" hint="Comma separated, up to 10."><Input id="wf-tags" value={meta.tags} onChange={(e) => setM({ tags: e.target.value })} /></Field>
            <div className="flex items-start gap-3 sm:pt-6"><Switch id="wf-enabled" checked={meta.enabled} onCheckedChange={(c) => setM({ enabled: c })} className="mt-0.5" /><div className="grid gap-0.5"><label htmlFor="wf-enabled" className="text-sm font-medium">Enabled</label><p className="text-xs text-muted-foreground">A disabled workflow cannot start new jobs: tickets assigned to it wait until you reassign them.</p></div></div>
            <Field label="Most stage attempts per job" htmlFor="wf-maxexec" hint={`Loop guard: a job is held for a person after this many attempts (1 to ${wm.limits.maxStageExecutions ?? 200}).`}><NumField id="wf-maxexec" value={def.limits.maxStageExecutions ?? wm.limits.maxStageExecutions ?? 200} min={1} max={wm.limits.maxStageExecutions ?? 200} onChange={(n) => n !== undefined && edit({ ...def, limits: { ...def.limits, maxStageExecutions: n } })} /></Field>
            <Field label="Whole-job timeout (seconds)" htmlFor="wf-timeout" hint="Wall-clock budget from the moment the job was created, including time spent waiting for a person. Empty: none."><NumField id="wf-timeout" optional value={def.limits.timeoutSeconds} min={60} max={wm.limits.maxWorkflowTimeoutSeconds ?? 604800} className="w-36" onChange={(n) => edit({ ...def, limits: { ...(def.limits.maxStageExecutions !== undefined ? { maxStageExecutions: def.limits.maxStageExecutions } : {}), ...(n !== undefined ? { timeoutSeconds: n } : {}) } })} /></Field>
            <div className="sm:col-span-2"><Issues issues={workflowIssues([...v.errors, ...v.warnings]).filter((i) => i.path.startsWith("limits"))} /></div>
          </CardContent></Card></fieldset>

        <Card><CardHeader><CardTitle className="text-sm">Flow</CardTitle><CardDescription>The order jobs run these stages, and where each failure rule sends them. Drawn from your draft as you edit. Click a stage to edit it.</CardDescription></CardHeader>
          <CardContent><FlowChart graph={graph} selected={sel} onSelect={setSel} label="Draft workflow flow chart" /><FlowLegend plan /></CardContent></Card>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] [&>*]:min-w-0">
          <Card className="self-start"><CardHeader><CardTitle className="text-sm">Stages</CardTitle><CardDescription>Listed in the order a job reaches them unless a stage names its own next step.</CardDescription></CardHeader>
            <CardContent>
              <StageList def={def} meta={wm} issues={[...v.errors, ...v.warnings]} selected={sel} onSelect={setSel} readOnly={ro}
                onAdd={(type: StageType, o) => { const s = newStage(wm, def, type, o); edit(insertStage(def, s, sel)); setSel(s.id); }}
                onRemove={(sid) => edit(removeStage(def, sid))} onMove={(sid, dir) => edit(moveStage(def, sid, dir))} />
            </CardContent></Card>
          <Card><CardContent className="p-5">
            {stage ? <StagePanel readOnly={ro} stage={stage} index={def.stages.indexOf(stage)} def={def} meta={wm} issues={[...v.errors, ...v.warnings]} locked={locked.get(stage.handler ?? stage.id)} onChange={(fn: (s: StageDef) => StageDef) => edit(updateStage(def, stage.id, fn))} /> : <p className="text-sm text-muted-foreground">Select a stage to edit it.</p>}
          </CardContent></Card>
        </div>
      </div>

      <Card><CardHeader><CardTitle className="text-sm">Safety stages</CardTitle><CardDescription>Enforced by the factory no matter what a workflow says. A workflow can order and tune them but cannot remove, disable, skip or route around them.</CardDescription></CardHeader>
        <CardContent><ul className="grid gap-2 text-sm">
          {wm.mandatory.map((m) => {
            const present = def.stages.find((s) => s.type === "factory" && (s.handler ?? s.id) === m.handler), on = locked.has(m.handler);
            return (
              <li key={m.handler} className="flex items-start gap-2"><Lock className={on ? "mt-0.5 size-4 shrink-0" : "mt-0.5 size-4 shrink-0 text-muted-foreground/40"} aria-hidden="true" />
                <span><b>{present?.name ?? m.handler}</b> <Mono>{m.handler}</Mono> {on ? <Badge variant="secondary">locked in this workflow</Badge> : <Badge variant="outline">not needed here</Badge>}<span className="block text-xs text-muted-foreground">{m.guards === "mutating" ? "Must come before every stage that changes a repository, the tracker or the host" : `Must come before ${(m.guards as string[]).join(", ")}`}: {m.why}.</span></span></li>
            );
          })}
        </ul></CardContent></Card>
    </div>
  );
}
