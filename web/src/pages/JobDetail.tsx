import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Archive, ArchiveRestore, ArrowLeft, ExternalLink, Loader2, RotateCcw, Search, Send, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { DeleteJobButton } from "@/components/JobsTable";
import { Pager } from "@/components/Pager";
import { matches, usePaged } from "@/lib/paging";
import { Peek } from "@/components/Peek";
import { Timeline } from "@/components/Timeline";
import { FlowChart, FlowLegend } from "@/components/FlowChart";
import { StatusBadge, toneOf } from "@/components/StatusBadge";
import { api, apiText, deleteJobRequest, post, send, type DeleteOptions, type SendResult } from "@/lib/api";
import { ago, dur, HELD, safeUrl, stageLabel, stageText } from "@/lib/format";
import { layoutDefinition } from "@/lib/graph";
import { deriveFlow, fallbackDefinition, stageNames } from "@/lib/pipeline";
import { NodeDetail } from "@/components/workflow/NodeDetail";
import { WorkflowBadge } from "@/components/workflow/WorkflowBadge";
import type { Invocation, JobDetail as D } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { ConnectionBanner, useOffline } from "@/components/ConnectionBanner";
import { cn } from "@/lib/utils";

export function JobDetail() {
  const { id = "" } = useParams();
  const { data: polled, error, updatedAt, reload } = usePoll((signal) => api<D>(`/api/jobs/${encodeURIComponent(id)}`, signal), 3000, [id]);
  const d = polled?.job.id === id ? polled : null; // never show (or act on) the previous job while the next one loads
  const offline = useOffline() || error !== null;
  const [pending, setPending] = useState<string | null>(null); // the action in flight: its buttons stay disabled until it settles
  const [sel, setSel] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [log, setLog] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ ids: number[]; id: number } | null>(null); // the agent sessions open in the peek window, and which tab
  const [wrap, setWrap] = useState(() => { try { return localStorage.getItem("sf.session.wrap") !== "0"; } catch { return true; } });
  const setWrapPref = (w: boolean) => { setWrap(w); try { localStorage.setItem("sf.session.wrap", w ? "1" : "0"); } catch { /* a preference only */ } };
  const nav = useNavigate();
  const [fh, setFh] = useState(""), [fa, setFa] = useState(""), [fd, setFd] = useState("");
  const execAll = d?.executions ?? [];
  const nodeStage = sel;
  const def = useMemo(() => (d ? d.workflow?.definition ?? fallbackDefinition(d.stageOrder, d.executions, d.job) : null), [d]);
  const names = useMemo(() => stageNames(def), [def]);
  const graph = useMemo(() => (def ? layoutDefinition(def, names) : null), [def, names]);
  const histRows = useMemo(() => execAll.filter((e) => (!nodeStage || e.stage === nodeStage) && matches(fh, e.stage, stageLabel(e.stage, names), e.outcome, stageText(e.error, names))), [execAll, nodeStage, fh, names]);
  const agentRows = useMemo(() => (d?.invocations ?? []).filter((a) => matches(fa, a.agent, a.model, a.exitCode)), [d?.invocations, fa]);
  const decRows = useMemo(() => (d?.decisions ?? []).filter((x) => matches(fd, x.kind, stageText(x.decision, names), stageText(x.rationale, names), x.actor)), [d?.decisions, fd, names]);
  const hist = usePaged(histRows, 10, `${id}|${nodeStage}|${fh}`), agents = usePaged(agentRows, 10, `${id}|${fa}`), decs = usePaged(decRows, 10, `${id}|${fd}`);
  const flow = useMemo(() => (d && def ? deriveFlow(d.job, def, d.executions, d.invocations) : null), [d, def]);
  const banner = <ConnectionBanner error={error} updatedAt={updatedAt} what="job" />;
  if (!d || !flow || !def || !graph) return error ? banner : <Skeleton className="h-96 w-full" />;
  const j = d.job, held = HELD.includes(j.stage), canRetry = held || j.status === "failed", canCancel = ["queued", "running", "waiting"].includes(j.status);
  const pr = safeUrl(j.prUrl);
  /** One action at a time: a double click must not send a second request (which the server would refuse, showing a false error). */
  const guard = async (name: string, fn: () => Promise<void>) => {
    if (pending) return;
    setPending(name);
    try { await fn(); } finally { setPending(null); }
  };
  const run = (name: string, path: string, body?: unknown) => guard(name, async () => { const err = await post(path, body); setMsg(err); if (!err) { if (name === "answer") setAnswer(""); await reload(); } });
  const locked = pending !== null || offline;
  const archived = Boolean(j.archivedAt);
  const openPeek = (runs: Invocation[], id?: number) => { if (runs.length) setPeek({ ids: runs.map((r) => r.id), id: id ?? runs.find((r) => !r.finished)?.id ?? runs.at(-1)!.id }); };
  const peekRuns = peek ? d.invocations.filter((i) => peek.ids.includes(i.id)) : [];
  const node = sel ? def.stages.find((x) => x.id === sel) ?? null : null;
  const execs = node ? execAll.filter((e) => e.stage === node.id) : execAll;
  const archiveIt = (to: boolean) => guard("archive", async () => { const r = await send("POST", `/api/jobs/${j.id}/${to ? "archive" : "unarchive"}`); setMsg(r.ok ? null : r.error); await reload(); });
  const deleteIt = async (o: DeleteOptions): Promise<SendResult> => { const r = await deleteJobRequest(j.id, o); if (r.ok) nav("/jobs"); return r; };
  const finished = ["done", "failed", "cancelled"].includes(j.status);
  const cycles = j.remediationAttempts, cap = d.remediationCap ?? 3;

  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <Link to="/jobs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />jobs</Link>
      <Card><CardContent className="grid gap-4 md:grid-cols-[1.6fr_1fr_1fr] md:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h2 className="font-mono text-base font-semibold">{j.key}</h2><StatusBadge status={j.status} /><span className="text-sm text-muted-foreground">{j.project}{j.autonomous ? " · autonomous" : ""}{j.dryRun ? " · dry run" : ""}</span></div>
          <WorkflowBadge workflow={d.workflow} fallbackName={j.workflow} />
          <div className="mt-2 flex flex-wrap gap-2">
            {pr ? <Button variant="outline" size="sm" asChild><a href={pr} target="_blank" rel="noopener noreferrer"><ExternalLink />pull request</a></Button> : null}
            {canRetry ? <Button size="sm" disabled={locked} title={archived ? "Retrying restores this job from the archive" : undefined} onClick={() => void run("retry", `/api/jobs/${j.id}/retry`)}>{pending === "retry" ? <Loader2 className="animate-spin" /> : <RotateCcw />}{archived ? "Retry and restore" : "Retry"}</Button> : null}
            {finished ? <Button size="sm" variant="outline" disabled={locked} onClick={() => void archiveIt(!j.archivedAt)}>{j.archivedAt ? <><ArchiveRestore />Restore</> : <><Archive />Archive</>}</Button> : null}
            {finished ? <DeleteJobButton job={j} label="Delete" disabled={locked} onDelete={deleteIt} /> : null}
            {canCancel ? (
              <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" size="sm" disabled={locked}><X />Cancel</Button></AlertDialogTrigger>
                <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Cancel {j.key}?</AlertDialogTitle><AlertDialogDescription>A running agent is stopped at its next check. The worktree is kept.</AlertDialogDescription></AlertDialogHeader>
                  <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={() => void run("cancel", `/api/jobs/${j.id}/cancel`)}>Cancel job</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
            ) : null}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground"><b className="block text-base text-foreground tabular-nums">{cycles} of {cap}</b>fix cycles used (the cap is {cap} for this project, shared by every review and CI)</div>
          <div className="mt-2 flex gap-1" aria-hidden="true">{Array.from({ length: Math.max(1, cap) }, (_, i) => <i key={i} className={cn("h-2 flex-1 rounded-sm bg-border", i < cycles && (cycles >= cap ? "bg-destructive" : "bg-loop"))} />)}</div>
          {Object.keys(flow.cycles).length || flow.loopsUsed.size ? <p className="mt-1 text-xs text-muted-foreground" aria-label="loops used">{flow.loopsUsed.size} failure route{flow.loopsUsed.size === 1 ? "" : "s"} taken{Object.entries(flow.cycles).map(([ph, c]) => ` · ${ph}: ${c.used} of ${c.of}`).join("")}</p> : null}
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground"><div><b className="block text-base text-foreground tabular-nums">{dur(flow.elapsedMs)}</b>elapsed</div><div><b className="block text-base text-foreground tabular-nums">{dur(flow.agentMs)}</b>agent time</div></div>
      </CardContent></Card>

      {error ? banner : null}
      {archived && canRetry ? <Alert role="status"><ArchiveRestore /><AlertDescription>This job is archived. Retrying will restore this job from the archive (it shows in the job list again).</AlertDescription></Alert> : null}
      {j.lastError ? <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{stageText(j.lastError, names)}</AlertDescription></Alert> : null}
      {held ? <Alert><AlertDescription>Held at {stageLabel(j.stage, names)}{j.heldFromStage ? ` (was ${stageLabel(j.heldFromStage, names)})` : ""}. Retry resumes there, with fresh counters.</AlertDescription></Alert> : null}
      {msg ? <Alert variant="destructive" role="alert"><AlertDescription>{msg}</AlertDescription></Alert> : null}

      {held && j.stage !== "CANCELLED" ? (
        <Card><CardHeader><CardTitle className="text-sm">Answer &amp; resume</CardTitle></CardHeader><CardContent className="grid gap-2">
          <Textarea rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer to the questions above. It is given to the agent as authoritative, then the job resumes." />
          <div><Button disabled={!answer.trim() || locked} onClick={() => void run("answer", `/api/jobs/${j.id}/answer`, { answer })}>{pending === "answer" ? <Loader2 className="animate-spin" /> : <Send />}Answer &amp; resume</Button></div>
        </CardContent></Card>
      ) : null}

      <Card><CardHeader><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Flow</CardTitle></CardHeader><CardContent>
        <FlowChart graph={graph} flow={flow} selected={sel} onSelect={setSel} label={`${d.workflow?.name ?? "Workflow"} flow chart`} />
        <p className="mt-1 text-xs text-muted-foreground">On a narrow screen the chart scrolls sideways. Click a step to see what it does, how its gate and routes decided, and to filter the stage history to it.</p>
        <FlowLegend />
      </CardContent></Card>

      <Timeline detail={d} cap={cap} selected={sel} onSelect={setSel} onPeek={(runs) => openPeek(runs)} />

      {node ? <NodeDetail stage={node} flow={flow} executions={execs} invocations={d.invocations} names={names} onPeek={(r) => openPeek(r)} onClear={() => setSel(null)} /> : null}

      {peek && peekRuns.length ? <Peek jobId={j.id} runs={peekRuns} activeId={peek.id} onActive={(id) => setPeek({ ids: peek.ids, id })} onClose={() => setPeek(null)} wrap={wrap} onWrap={setWrapPref} ctx={{ key: j.key, branch: d.worktree?.branch }} /> : null}

      <Tabs defaultValue="history">
        <TabsList><TabsTrigger value="history">Stage history</TabsTrigger><TabsTrigger value="agents" id="agent-runs-tab">Agent runs</TabsTrigger><TabsTrigger value="decisions">Decisions</TabsTrigger><TabsTrigger value="more">Artifacts &amp; write-back</TabsTrigger></TabsList>
        <TabsContent value="history"><Card><CardContent>
          <div className="mb-3 flex flex-wrap items-center gap-2"><div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Filter stage history" className="pl-8" value={fh} onChange={(e) => setFh(e.target.value)} placeholder="Filter by stage, outcome or error" /></div>{node ? <span className="text-xs text-muted-foreground">Showing {node.name} only.</span> : null}</div>
          <Table><TableHeader><TableRow>{["Stage", "#", "Outcome", "Took", "Detail"].map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{hist.slice.map((e) => <TableRow key={e.id}><TableCell className="text-xs" title={e.stage}>{stageLabel(e.stage, names)}</TableCell><TableCell>{e.attempt}</TableCell><TableCell className={toneOf(e.outcome)}>{e.outcome}</TableCell><TableCell>{e.finishedAt && e.startedAt ? dur(e.finishedAt - e.startedAt) : "…"}</TableCell><TableCell className={e.error ? "text-destructive" : "text-muted-foreground"}>{stageText((e.error || "").slice(0, 200), names)}</TableCell></TableRow>)}</TableBody></Table>
          <Pager page={hist.page} pages={hist.pages} pageSize={hist.pageSize} total={hist.total} onPage={hist.setPage} onPageSize={hist.setPageSize} />
        </CardContent></Card></TabsContent>
        <TabsContent value="agents"><Card><CardContent>
          <div className="mb-3 relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Filter agent runs" className="pl-8" value={fa} onChange={(e) => setFa(e.target.value)} placeholder="Filter by agent or model" /></div>
          <Table><TableHeader><TableRow>{["Agent", "Model", "Took", "Exit", "Denied", "", "Log"].map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{agents.slice.map((a) => <TableRow key={a.id}><TableCell>{a.agent}</TableCell><TableCell>{a.model || ""}</TableCell><TableCell>{dur(a.durationMs)}</TableCell><TableCell>{a.exitCode ?? (a.finished ? <span className="text-muted-foreground" title="The run ended without an exit code: it was stopped (timeout, cancel, emergency stop), failed to start, or the service restarted mid-run.">stopped</span> : "")}</TableCell><TableCell className={a.usage?.denials ? "text-loop" : "text-muted-foreground"}>{a.usage?.denials ?? ""}</TableCell>
              <TableCell>{a.hasLog ? <Button variant="outline" size="sm" onClick={() => openPeek(a.stageExecutionId === null ? [a] : d.invocations.filter((i) => i.stageExecutionId === a.stageExecutionId), a.id)}>{a.finished ? "Conversation" : "Watch live"}</Button> : ""}</TableCell>
              <TableCell>{a.hasLog ? <Button variant="outline" size="sm" onClick={async () => { try { setLog(await apiText(`/api/jobs/${j.id}/invocations/${a.id}/log?tail=30000`)); } catch (e) { setLog(`No log: ${(e as Error).message}`); } }}>view</Button> : ""}</TableCell></TableRow>)}</TableBody></Table>
          <Pager page={agents.page} pages={agents.pages} pageSize={agents.pageSize} total={agents.total} onPage={agents.setPage} onPageSize={agents.setPageSize} />
          {log !== null ? <pre className="mt-3 max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{log}</pre> : null}
        </CardContent></Card></TabsContent>
        <TabsContent value="decisions"><Card><CardContent>
          {d.decisions.length ? <div className="mb-3 relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Filter decisions" className="pl-8" value={fd} onChange={(e) => setFd(e.target.value)} placeholder="Filter decisions" /></div> : null}
          {d.decisions.length ? <><Table><TableBody>{decs.slice.map((x) => <TableRow key={x.id}><TableCell className="font-mono text-xs">{x.kind}</TableCell><TableCell>{stageText(x.decision, names)}</TableCell><TableCell className="text-muted-foreground">{stageText(x.rationale, names) || ""}</TableCell><TableCell className="text-muted-foreground">{x.actor}</TableCell></TableRow>)}</TableBody></Table><Pager page={decs.page} pages={decs.pages} pageSize={decs.pageSize} total={decs.total} onPage={decs.setPage} onPageSize={decs.setPageSize} /></> : <p className="text-sm text-muted-foreground">None.</p>}
        </CardContent></Card></TabsContent>
        <TabsContent value="more"><Card><CardContent className="grid gap-4 text-sm">
          <div><h4 className="mb-1 font-semibold">Artifacts</h4>{d.artifacts.length ? <ul className="grid gap-1">{d.artifacts.map((a) => <li key={a.path}><b>{a.kind}</b> <span className="font-mono text-xs text-muted-foreground">{a.path}</span></li>)}</ul> : <p className="text-muted-foreground">None.</p>}</div>
          {d.worktree ? <div><h4 className="mb-1 font-semibold">Worktree</h4><div className="font-mono text-xs">{d.worktree.path} ({d.worktree.state}) on {d.worktree.branch}</div></div> : null}
          <div><h4 className="mb-1 font-semibold">Linear write-back</h4>{d.outbox.length ? <div className="flex flex-wrap gap-2">{d.outbox.map((o) => <Badge key={o.id} variant="outline" title={o.lastError || ""} className={o.status === "done" ? "text-ok" : o.status === "failed" ? "text-destructive" : "text-loop"}>{o.kind} {o.status}</Badge>)}</div> : <p className="text-muted-foreground">None.</p>}</div>
          <div className="text-xs text-muted-foreground">Updated {ago(j.updatedAt)} · {def.stages.length} workflow steps</div>
        </CardContent></Card></TabsContent>
      </Tabs>
    </div>
  );
}
