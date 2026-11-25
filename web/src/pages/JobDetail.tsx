import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, RotateCcw, Send, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { FlowChart, FlowLegend } from "@/components/FlowChart";
import { StatusBadge, toneOf } from "@/components/StatusBadge";
import { api, apiText, post } from "@/lib/api";
import { ago, dur, HELD, safeUrl, stageLabel } from "@/lib/format";
import { deriveFlow, NODE, NODES } from "@/lib/pipeline";
import type { JobDetail as D } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { cn } from "@/lib/utils";

export function JobDetail() {
  const { id = "" } = useParams();
  const { data: d, error, reload } = usePoll(() => api<D>(`/api/jobs/${encodeURIComponent(id)}`), 3000, [id]);
  const [sel, setSel] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [log, setLog] = useState<string | null>(null);
  const flow = useMemo(() => (d ? deriveFlow(d.job, d.executions, d.invocations) : null), [d]);
  if (error && !d) return <Alert variant="destructive"><AlertDescription>Cannot load: {error}</AlertDescription></Alert>;
  if (!d || !flow) return <Skeleton className="h-96 w-full" />;
  const j = d.job, held = HELD.includes(j.stage), canRetry = held || j.status === "failed", canCancel = ["queued", "running", "waiting"].includes(j.status);
  const pr = safeUrl(j.prUrl);
  const run = async (path: string, body?: unknown) => { const err = await post(path, body); setMsg(err); if (!err) { setAnswer(""); void reload(); } };
  const node = sel ? NODE[sel] : null;
  const execs = node ? d.executions.filter((e) => e.stage === node.stage) : d.executions;
  const cycles = j.remediationAttempts;

  return (
    <div className="grid min-w-0 gap-4">
      <Link to="/jobs" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />jobs</Link>
      <Card><CardContent className="grid gap-4 md:grid-cols-[1.6fr_1fr_1fr] md:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h2 className="font-mono text-base font-semibold">{j.key}</h2><StatusBadge status={j.status} /><span className="text-sm text-muted-foreground">{j.project} · {j.workflow}{j.autonomous ? " · autonomous" : ""}{j.dryRun ? " · dry run" : ""}</span></div>
          <div className="mt-2 flex flex-wrap gap-2">
            {pr ? <Button variant="outline" size="sm" asChild><a href={pr} target="_blank" rel="noopener noreferrer"><ExternalLink />pull request</a></Button> : null}
            {canRetry ? <Button size="sm" onClick={() => void run(`/api/jobs/${j.id}/retry`)}><RotateCcw />Retry</Button> : null}
            {canCancel ? (
              <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" size="sm"><X />Cancel</Button></AlertDialogTrigger>
                <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Cancel {j.key}?</AlertDialogTitle><AlertDialogDescription>A running agent is stopped at its next check. The worktree is kept.</AlertDialogDescription></AlertDialogHeader>
                  <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={() => void run(`/api/jobs/${j.id}/cancel`)}>Cancel job</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
            ) : null}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground"><b className="block text-base text-foreground tabular-nums">{cycles} of 3</b>fix cycles used (the cap is 3, shared by every review and CI)</div>
          <div className="mt-2 flex gap-1" aria-hidden="true">{[0, 1, 2].map((i) => <i key={i} className={cn("h-2 flex-1 rounded-sm bg-border", i < cycles && (cycles >= 3 ? "bg-destructive" : "bg-loop"))} />)}</div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground"><div><b className="block text-base text-foreground tabular-nums">{dur(flow.elapsedMs)}</b>elapsed</div><div><b className="block text-base text-foreground tabular-nums">{dur(flow.agentMs)}</b>agent time</div></div>
      </CardContent></Card>

      {j.lastError ? <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{j.lastError}</AlertDescription></Alert> : null}
      {held ? <Alert><AlertDescription>Held at {stageLabel(j.stage)}{j.heldFromStage ? ` (was ${stageLabel(j.heldFromStage)})` : ""}. Retry resumes there, with fresh counters.</AlertDescription></Alert> : null}
      {msg ? <Alert variant="destructive" role="alert"><AlertDescription>{msg}</AlertDescription></Alert> : null}

      {held && j.stage !== "CANCELLED" ? (
        <Card><CardHeader><CardTitle className="text-sm">Answer &amp; resume</CardTitle></CardHeader><CardContent className="grid gap-2">
          <Textarea rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer to the questions above. It is given to the agent as authoritative, then the job resumes." />
          <div><Button disabled={!answer.trim()} onClick={() => void run(`/api/jobs/${j.id}/answer`, { answer })}><Send />Answer &amp; resume</Button></div>
        </CardContent></Card>
      ) : null}

      <Card><CardHeader><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Flow</CardTitle></CardHeader><CardContent>
        <FlowChart flow={flow} selected={sel} onSelect={setSel} />
        <p className="mt-1 text-xs text-muted-foreground">On a narrow screen the chart scrolls sideways. Click a step to see what it does and filter the stage history to it.</p>
        <FlowLegend />
      </CardContent></Card>

      <Card><CardHeader><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">What happened, in order</CardTitle></CardHeader><CardContent>
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs">
          {flow.trail.map((t, i) => <span key={i} className="inline-flex items-center gap-1">{i ? <span className="text-muted-foreground">→</span> : null}<Badge variant="outline" className={cn("whitespace-nowrap", t.kind === "ok" && "border-ok/45", t.kind === "bad" && "border-destructive text-destructive", t.kind === "run" && "border-run text-run", t.kind === "loop" && "border-loop bg-loop/10 text-loop")}>{t.text}</Badge></span>)}
        </div>
      </CardContent></Card>

      {node ? (
        <Card><CardContent className="grid gap-4 md:grid-cols-2">
          <div><div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Selected step</div><h3 className="text-base font-semibold">{node.label}</h3><div className="font-mono text-xs text-muted-foreground">{node.stage}</div>
            <p className="mt-2 text-sm">{({ done: "Finished", run: "Running now", wait: "Waiting", fail: "Stopped here", idle: "Not reached yet" })[flow.state[node.id] ?? "idle"]}{(flow.attempts[node.id] ?? 0) > 1 ? ` · ${flow.attempts[node.id]} attempts` : ""}{flow.duration[node.id] ? ` · ${dur(flow.duration[node.id])}` : ""}</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setSel(null)}>Show all steps</Button></div>
          <div className="grid gap-3 text-sm"><div><div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">What happens here</div><p>{node.what}</p></div><div><div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">If it finds problems</div><p>{node.issues}</p></div></div>
        </CardContent></Card>
      ) : null}

      <Tabs defaultValue="history">
        <TabsList><TabsTrigger value="history">Stage history</TabsTrigger><TabsTrigger value="agents">Agent runs</TabsTrigger><TabsTrigger value="decisions">Decisions</TabsTrigger><TabsTrigger value="more">Artifacts &amp; write-back</TabsTrigger></TabsList>
        <TabsContent value="history"><Card><CardContent>
          {node ? <p className="mb-2 text-xs text-muted-foreground">Filtered to {node.label}.</p> : null}
          <Table><TableHeader><TableRow>{["Stage", "#", "Outcome", "Took", "Detail"].map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{execs.map((e) => <TableRow key={e.id}><TableCell className="font-mono text-xs">{e.stage}</TableCell><TableCell>{e.attempt}</TableCell><TableCell className={toneOf(e.outcome)}>{e.outcome}</TableCell><TableCell>{e.finishedAt && e.startedAt ? dur(e.finishedAt - e.startedAt) : "…"}</TableCell><TableCell className={e.error ? "text-destructive" : "text-muted-foreground"}>{(e.error || "").slice(0, 200)}</TableCell></TableRow>)}</TableBody></Table>
        </CardContent></Card></TabsContent>
        <TabsContent value="agents"><Card><CardContent>
          <Table><TableHeader><TableRow>{["Agent", "Model", "Took", "Exit", "Denied", "Log"].map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{d.invocations.map((a) => <TableRow key={a.id}><TableCell>{a.agent}</TableCell><TableCell>{a.model || ""}</TableCell><TableCell>{dur(a.durationMs)}</TableCell><TableCell>{a.exitCode ?? ""}</TableCell><TableCell className={a.usage?.denials ? "text-loop" : "text-muted-foreground"}>{a.usage?.denials ?? ""}</TableCell>
              <TableCell>{a.hasLog ? <Button variant="outline" size="sm" onClick={async () => { try { setLog(await apiText(`/api/jobs/${j.id}/invocations/${a.id}/log?tail=30000`)); } catch (e) { setLog(`No log: ${(e as Error).message}`); } }}>view</Button> : ""}</TableCell></TableRow>)}</TableBody></Table>
          {log !== null ? <pre className="mt-3 max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{log}</pre> : null}
        </CardContent></Card></TabsContent>
        <TabsContent value="decisions"><Card><CardContent>
          {d.decisions.length ? <Table><TableBody>{d.decisions.map((x) => <TableRow key={x.id}><TableCell className="font-mono text-xs">{x.kind}</TableCell><TableCell>{x.decision}</TableCell><TableCell className="text-muted-foreground">{x.rationale || ""}</TableCell><TableCell className="text-muted-foreground">{x.actor}</TableCell></TableRow>)}</TableBody></Table> : <p className="text-sm text-muted-foreground">None.</p>}
        </CardContent></Card></TabsContent>
        <TabsContent value="more"><Card><CardContent className="grid gap-4 text-sm">
          <div><h4 className="mb-1 font-semibold">Artifacts</h4>{d.artifacts.length ? <ul className="grid gap-1">{d.artifacts.map((a) => <li key={a.path}><b>{a.kind}</b> <span className="font-mono text-xs text-muted-foreground">{a.path}</span></li>)}</ul> : <p className="text-muted-foreground">None.</p>}</div>
          {d.worktree ? <div><h4 className="mb-1 font-semibold">Worktree</h4><div className="font-mono text-xs">{d.worktree.path} ({d.worktree.state}) on {d.worktree.branch}</div></div> : null}
          <div><h4 className="mb-1 font-semibold">Linear write-back</h4>{d.outbox.length ? <div className="flex flex-wrap gap-2">{d.outbox.map((o) => <Badge key={o.id} variant="outline" title={o.lastError || ""} className={o.status === "done" ? "text-ok" : o.status === "failed" ? "text-destructive" : "text-loop"}>{o.kind} {o.status}</Badge>)}</div> : <p className="text-muted-foreground">None.</p>}</div>
          <div className="text-xs text-muted-foreground">Updated {ago(j.updatedAt)} · {NODES.length} pipeline steps</div>
        </CardContent></Card></TabsContent>
      </Tabs>
    </div>
  );
}
