import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Tabs as TabsPrimitive } from "radix-ui";
import { Archive, ArchiveRestore, ExternalLink, Loader2, MessageSquareText, RotateCcw, Search, Send, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { DeleteJobButton } from "@/components/JobsTable";
import { Pager } from "@/components/Pager";
import { matches, usePaged } from "@/lib/paging";
import { Peek } from "@/components/Peek";
import { JobChat } from "@/components/JobChat";
import { RequestChanges } from "@/components/RequestChanges";
import { PeekButton, Timeline } from "@/components/Timeline";
import { FlowChart, FlowLegend, FlowSteps } from "@/components/FlowChart";
import { toneOf } from "@/components/StatusBadge";
import { JobHero, NeedsYou } from "@/components/job/JobHero";
import { Approvals } from "@/components/job/Approvals";
import { DecisionList, FilesPanel, SectionHead } from "@/components/job/JobSections";
import { api, apiText, deleteJobRequest, post, send, type DeleteOptions, type SendResult } from "@/lib/api";
import { ago, dur, HELD, safeUrl, stageLabel, stageText } from "@/lib/format";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { deriveFlow, modeOfJob, nodesFor } from "@/lib/pipeline";
import type { Invocation, Job, JobDetail as D } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { ConnectionBanner, useOffline } from "@/components/ConnectionBanner";
import { cn } from "@/lib/utils";

const panel = "grid-cols-[minmax(0,1fr)] border border-[var(--z-line)] bg-[#0d0d0d] p-5 md:p-6"; // a single column that never grows past the page
function Filter({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full max-w-xs max-md:max-w-none">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground max-md:top-3.5" aria-hidden />
      <Input aria-label={label} className="pl-8" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

/**
 * One job, in the Zonto look. A hero says what the job is doing (status, title, the pipeline as a segmented bar, the numbers and
 * the actions); a band says what it needs from you, if anything; everything else is in tabs, remembered in the URL (?tab=) so Back
 * and a shared link land in the same place.
 */
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
  const [params, setParams] = useSearchParams();
  const strip = useRef<HTMLDivElement>(null);
  const tabParam = params.get("tab");
  // On a phone the tab strip scrolls sideways: keep the active tab in view (moving the strip only, never the page).
  useEffect(() => {
    const list = strip.current, el = list?.querySelector<HTMLElement>('[data-state="active"]');
    if (list && el && typeof list.scrollTo === "function") list.scrollTo({ left: Math.max(0, el.offsetLeft - (list.clientWidth - el.offsetWidth) / 2) });
  }, [tabParam, Boolean(polled)]);
  const [chart, setChart] = useState(false); // phones: the step list by default, the full chart on request
  const [fh, setFh] = useState(""), [fa, setFa] = useState(""), [fd, setFd] = useState("");
  const execAll = d?.executions ?? [];
  const isMobile = useIsMobile();
  const mode = modeOfJob(d?.job ?? ({} as Job), d?.executions ?? []);
  const NODES = nodesFor(mode), NODE = Object.fromEntries(NODES.map((x) => [x.id, x]));
  const nodeStage = sel ? NODE[sel]?.stage : null;
  const histRows = useMemo(() => execAll.filter((e) => (!nodeStage || e.stage === nodeStage) && matches(fh, e.stage, stageLabel(e.stage), e.outcome, stageText(e.error))), [execAll, nodeStage, fh]);
  const agentRows = useMemo(() => (d?.invocations ?? []).filter((a) => matches(fa, a.agent, a.model, a.exitCode)), [d?.invocations, fa]);
  const decRows = useMemo(() => [...(d?.decisions ?? [])].reverse().filter((x) => matches(fd, x.kind, stageText(x.decision), stageText(x.rationale), x.actor)), [d?.decisions, fd]);
  const hist = usePaged(histRows, 10, `${id}|${nodeStage}|${fh}`), agents = usePaged(agentRows, 10, `${id}|${fa}`), decs = usePaged(decRows, 10, `${id}|${fd}`);
  const flow = useMemo(() => (d ? deriveFlow(d.job, d.executions, d.invocations) : null), [d]);
  const banner = <ConnectionBanner error={error} updatedAt={updatedAt} what="job" />;
  if (!d || !flow) return error ? banner : <Skeleton className="h-96 w-full" />;
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
  const node = sel ? NODE[sel] : null;
  const execs = node ? execAll.filter((e) => e.stage === node.stage) : execAll;
  const archiveIt = (to: boolean) => guard("archive", async () => { const r = await send("POST", `/api/jobs/${j.id}/${to ? "archive" : "unarchive"}`); setMsg(r.ok ? null : r.error); await reload(); });
  const deleteIt = async (o: DeleteOptions): Promise<SendResult> => { const r = await deleteJobRequest(j.id, o); if (r.ok) nav(`/p/${encodeURIComponent(j.project)}`); return r; };
  const finished = ["done", "failed", "cancelled"].includes(j.status);
  const cycles = j.remediationAttempts, cap = d.remediationCap ?? 3;
  // The agent was refused something a person can allow (core/approvals.ts): the step waits for Approve / Deny, not for an answer.
  const asking = held && j.stage === "NEEDS_ATTENTION" && (j.lastError ?? "").startsWith("Waiting for your approval:");
  const asks = (d.permissions ?? []).filter((r) => r.status === "pending" || (r.status === "refused" && r.stage === j.heldFromStage));
  const awaitingMerge = !held && j.stage === "MERGING" && ["queued", "waiting"].includes(j.status) && Boolean(pr);
  const canRequest = Boolean(j.prUrl) && (!finished || j.status === "failed" || Boolean(d.feedback?.length));
  const openFeedback = (d.feedback ?? []).filter((f) => f.status === "pending" || f.status === "applying").length;
  const viewLog = async (a: Invocation) => { try { setLog(await apiText(`/api/jobs/${j.id}/invocations/${a.id}/log?tail=30000`)); } catch (e) { setLog(`No log: ${(e as Error).message}`); } };
  const runsOf = (a: Invocation) => (a.stageExecutionId === null ? [a] : d.invocations.filter((i) => i.stageExecutionId === a.stageExecutionId));

  const tabs = [
    { id: "overview", label: "Overview" },
    ...(canRequest ? [{ id: "changes", label: "Request changes", count: openFeedback || undefined }] : []),
    { id: "history", label: "Stage history", count: execAll.length },
    { id: "agents", label: "Agent runs", count: d.invocations.length },
    { id: "decisions", label: "Decisions", count: d.decisions.length },
    ...(d.plan ? [{ id: "prompt", label: "Prompt" }] : []),
    { id: "chat", label: "Ask Claude" },
    { id: "files", label: "Files" },
  ];
  const tab = tabs.some((t) => t.id === params.get("tab")) ? params.get("tab")! : "overview";
  const setTab = (t: string) => setParams((p) => { const n = new URLSearchParams(p); if (t === "overview") n.delete("tab"); else n.set("tab", t); return n; }, { replace: true });

  const actions = (<>
    {canRetry && !(held && j.stage !== "CANCELLED") ? <Button disabled={locked} title={archived ? "Retrying restores this job from the archive" : undefined} onClick={() => void run("retry", `/api/jobs/${j.id}/retry`)}>{pending === "retry" ? <Loader2 className="animate-spin" /> : <RotateCcw />}{archived ? "Retry and restore" : "Retry"}</Button> : null}
    {pr ? <Button variant="outline" asChild><a href={pr} target="_blank" rel="noopener noreferrer"><ExternalLink />Pull request</a></Button> : null}
    {finished ? <Button variant="outline" disabled={locked} onClick={() => void archiveIt(!j.archivedAt)}>{j.archivedAt ? <><ArchiveRestore />Restore</> : <><Archive />Archive</>}</Button> : null}
    {finished ? <DeleteJobButton job={j} label="Delete" size="default" disabled={locked} onDelete={deleteIt} /> : null}
    {canCancel ? (
      <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" disabled={locked}><X />Cancel job</Button></AlertDialogTrigger>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Cancel {j.key}?</AlertDialogTitle><AlertDialogDescription>A running agent is stopped at its next check. The worktree is kept.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={() => void run("cancel", `/api/jobs/${j.id}/cancel`)}>Cancel job</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    ) : null}
  </>);

  const stepRuns = (() => { const ids = new Set(execs.map((e) => e.id)); return d.invocations.filter((i) => i.stageExecutionId !== null && ids.has(i.stageExecutionId)); })();
  const selected = node ? (
    <div className="grid gap-5 border-t border-[var(--z-line)] pt-5 md:grid-cols-2" aria-label="Selected step" role="group">
      <div className="grid content-start gap-2">
        <span className="z-label">Selected step</span>
        <h3 className="z-display text-xl">{node.label}</h3>
        <p className="text-sm text-muted-foreground">{({ done: "Finished", run: "Running now", wait: "Waiting", fail: "Stopped here", idle: "Not reached yet" })[flow.state[node.id] ?? "idle"]}{(flow.attempts[node.id] ?? 0) > 1 ? ` · ${flow.attempts[node.id]} attempts` : ""}{flow.duration[node.id] ? ` · ${dur(flow.duration[node.id])}` : ""}</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {stepRuns.length ? <PeekButton runs={stepRuns} variant="secondary" onPeek={(r) => openPeek(r)} /> : null}
          <Button variant="outline" size="sm" onClick={() => setTab("history")}>Its stage history</Button>
          <Button variant="ghost" size="sm" onClick={() => setSel(null)}>Show all steps</Button>
        </div>
      </div>
      <div className="grid content-start gap-4 text-sm">
        <div className="grid gap-1"><span className="z-label">What happens here</span><p>{node.what}</p></div>
        <div className="grid gap-1"><span className="z-label">If it finds problems</span><p>{node.issues}</p></div>
      </div>
    </div>
  ) : null;

  return (
    <div className="zonto grid min-w-0 gap-5 [&>*]:min-w-0">
      <JobHero job={j} elapsedMs={flow.elapsedMs} agentMs={flow.agentMs} cycles={cycles} cap={cap} actions={actions} />

      {error ? banner : null}
      {msg ? <Alert variant="destructive" role="alert"><AlertDescription>{msg}</AlertDescription></Alert> : null}
      {archived && canRetry ? <Alert role="status"><ArchiveRestore /><AlertDescription>This job is archived. Retrying will restore this job from the archive (it shows in the job list again).</AlertDescription></Alert> : null}

      {asking && asks.length ? (
        <NeedsYou tone="wait" label="Needs your permission" title="The agent is asking for access">
          <p className="max-w-2xl text-sm text-muted-foreground">It was refused something it needs for {stageLabel(j.heldFromStage ?? j.stage)}. Decide each request: the step resumes, in the same agent session, once none is left undecided. Anything you allow applies to this job only.</p>
          <Approvals jobId={j.id} requests={asks} locked={locked} onDecided={reload} />
        </NeedsYou>
      ) : held && j.stage !== "CANCELLED" ? (
        <NeedsYou tone={j.stage === "FAILED" ? "fail" : "wait"} label={j.stage === "FAILED" ? "Failed" : "Needs you"} title={`Stopped at ${stageLabel(j.heldFromStage ?? j.stage)}`}
          actions={<>
            <Button disabled={!answer.trim() || locked} onClick={() => void run("answer", `/api/jobs/${j.id}/answer`, { answer })}>{pending === "answer" ? <Loader2 className="animate-spin" /> : <Send />}Answer &amp; resume</Button>
            <Button variant="outline" disabled={locked} title={archived ? "Retrying restores this job from the archive" : undefined} onClick={() => void run("retry", `/api/jobs/${j.id}/retry`)}>{pending === "retry" ? <Loader2 className="animate-spin" /> : <RotateCcw />}{archived ? "Retry and restore" : "Retry without an answer"}</Button>
          </>}>
          {j.lastError ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere border border-[var(--z-line)] bg-[#0a0a0a] p-3 font-sans text-[13px] leading-relaxed">{stageText(j.lastError)}</pre> : null}
          <p className="text-xs text-muted-foreground">Retry resumes at {stageLabel(j.heldFromStage ?? j.stage)}, with fresh counters. An answer is given to the agent as authoritative.</p>
          <Textarea rows={4} aria-label="Your answer" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer to the questions above. It is given to the agent as authoritative, then the job resumes." />
        </NeedsYou>
      ) : awaitingMerge ? (
        <NeedsYou tone="go" label="Your move" title="Ready for your review"
          actions={<>
            <Button asChild><a href={pr!} target="_blank" rel="noopener noreferrer"><ExternalLink />Review pull request</a></Button>
            <Button variant="outline" onClick={() => setTab("changes")}><MessageSquareText />Request changes</Button>
          </>}>
          <p className="max-w-2xl text-sm text-muted-foreground">Checks passed and the reviews approved. The factory runs in PR-only mode, so it never merges: merge it yourself, or ask for changes and it will push them to the same pull request.</p>
        </NeedsYou>
      ) : j.lastError ? <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{stageText(j.lastError)}</AlertDescription></Alert> : null}

      {peek && peekRuns.length ? <Peek jobId={j.id} runs={peekRuns} activeId={peek.id} onActive={(id) => setPeek({ ids: peek.ids, id })} onClose={() => setPeek(null)} wrap={wrap} onWrap={setWrapPref} ctx={{ key: j.key, branch: d.worktree?.branch }} /> : null}

      <TabsPrimitive.Root value={tab} onValueChange={setTab} className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <TabsPrimitive.List ref={strip} aria-label="Job sections" className="no-scrollbar sticky top-0 z-[5] -mx-1 flex overflow-x-auto border-b border-[var(--z-line)] bg-[#0e0e10]/95 px-1 backdrop-blur max-md:-mx-4 max-md:top-[calc(60px+env(safe-area-inset-top))] max-md:px-4">
          {tabs.map((t) => (
            <TabsPrimitive.Trigger key={t.id} value={t.id}
              className="z-label my-1.5 flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap border border-transparent px-3.5 outline-none hover:text-foreground focus-visible:border-[var(--z-acc)] data-[state=active]:border-[var(--z-acc)] data-[state=active]:text-foreground max-md:min-h-11">
              {t.label}{t.count ? <span className="text-[10px] text-[var(--z-muted)] tabular-nums">{t.count}</span> : null}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>

        <TabsPrimitive.Content value="overview" className="grid grid-cols-[minmax(0,1fr)] gap-5 outline-none">
          <section aria-label="Pipeline" className={cn(panel, "grid gap-4")}>
            <SectionHead title="Pipeline" note={<>{stageLabel(j.status === "failed" && j.heldFromStage ? j.heldFromStage : j.stage)}{cycles ? <span className="text-[var(--z-warn)]"> · sent back {cycles}×</span> : null}</>} />
            {isMobile ? (<>
              {chart ? <FlowChart flow={flow} selected={sel} onSelect={setSel} /> : <FlowSteps flow={flow} selected={sel} onSelect={setSel} />}
              <p className="text-xs text-muted-foreground">{chart ? "Drag to move around, pinch to zoom." : "Tap a step to see what it does."}</p>
              {chart ? <FlowLegend /> : null}
              <Button variant="outline" size="sm" className="w-full" aria-pressed={chart} onClick={() => setChart(!chart)}>{chart ? "Show as a list" : "Show the full chart"}</Button>
            </>) : (<>
              <FlowChart flow={flow} selected={sel} onSelect={setSel} />
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2"><FlowLegend /><p className="text-xs text-muted-foreground">Click a step to see what it does. Drag to pan when zoomed in, ⌘-scroll or pinch to zoom.</p></div>
            </>)}
            {selected}
          </section>
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0"><Timeline detail={d} cap={cap} selected={sel} onSelect={setSel} onPeek={(runs) => openPeek(runs)} /></div>
            <section aria-label="Details" className={cn(panel, "grid gap-4")}>
              <SectionHead title="Details" />
              <dl className="grid gap-3.5 text-[13px]">
                {([["Workflow", j.workflow], ["Branch", d.worktree?.branch ?? "not created"], ["Worktree", d.worktree ? d.worktree.state : "not created"], ["Mode", `PR-only${j.autonomous ? ", autonomous" : ""}${j.dryRun ? ", dry run" : ""}`], ["Started", j.createdAt ? ago(j.createdAt) : "not started"]] as const).map(([k, v]) => (
                  <div key={k} className="grid gap-0.5"><dt className="z-label">{k}</dt><dd className={cn("wrap-anywhere", k === "Branch" && "font-mono text-xs")}>{v}</dd></div>
                ))}
              </dl>
            </section>
          </div>
        </TabsPrimitive.Content>

        {canRequest ? (
          <TabsPrimitive.Content value="changes" className="outline-none">
            <RequestChanges jobId={j.id} feedback={d.feedback ?? []} open={!["done", "cancelled"].includes(j.status)} github={Boolean(pr)} locked={offline} onSent={reload} />
          </TabsPrimitive.Content>
        ) : null}

        <TabsPrimitive.Content value="history" className={cn(panel, "grid gap-4 outline-none")}>
          <SectionHead title="Stage history" note={node ? <>Showing {node.label} only · <button type="button" className="text-[var(--z-acc)] hover:underline" onClick={() => setSel(null)}>show all</button></> : `${execAll.length} runs`}>
            <Filter label="Filter stage history" value={fh} onChange={setFh} placeholder="Filter by stage, outcome or error" />
          </SectionHead>
          {isMobile ? (
            <ul className="grid divide-y divide-[var(--z-line)]" aria-label="Stage history">{hist.slice.map((e) => (
              <li key={e.id} className="grid gap-0.5 py-3 text-sm">
                <span className="flex items-baseline gap-2"><b className="min-w-0 flex-1 truncate font-medium" title={e.stage}>{stageLabel(e.stage)} <span className="font-normal text-muted-foreground">#{e.attempt}</span></b><span className={cn("z-label", toneOf(e.outcome))}>{e.outcome}</span></span>
                <span className="text-xs text-muted-foreground">{e.finishedAt && e.startedAt ? `took ${dur(e.finishedAt - e.startedAt)}` : "running…"}</span>
                {e.error ? <span className="line-clamp-3 wrap-anywhere text-xs text-destructive">{stageText(e.error.slice(0, 200))}</span> : null}
              </li>))}
            </ul>
          ) : <Table><TableHeader><TableRow>{["Stage", "#", "Outcome", "Took", "Detail"].map((c) => <TableHead key={c} className="z-label">{c}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{hist.slice.map((e) => <TableRow key={e.id}><TableCell className="text-[13px]" title={e.stage}>{stageLabel(e.stage)}</TableCell><TableCell className="tabular-nums">{e.attempt}</TableCell><TableCell className={cn("z-label", toneOf(e.outcome))}>{e.outcome}</TableCell><TableCell className="tabular-nums">{e.finishedAt && e.startedAt ? dur(e.finishedAt - e.startedAt) : "…"}</TableCell><TableCell className={cn("min-w-72 whitespace-normal wrap-anywhere", e.error ? "text-destructive" : "text-muted-foreground")}>{stageText((e.error || "").slice(0, 200))}</TableCell></TableRow>)}</TableBody></Table>}
          <Pager page={hist.page} pages={hist.pages} pageSize={hist.pageSize} total={hist.total} onPage={hist.setPage} onPageSize={hist.setPageSize} />
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="agents" className={cn(panel, "grid gap-4 outline-none")}>
          <SectionHead title="Agent runs" note={`${d.invocations.length} runs · ${dur(flow.agentMs)}`}>
            <Filter label="Filter agent runs" value={fa} onChange={setFa} placeholder="Filter by agent or model" />
          </SectionHead>
          {isMobile ? (
            <ul className="grid divide-y divide-[var(--z-line)]" aria-label="Agent runs">{agents.slice.map((a) => (
              <li key={a.id} className="grid gap-2 py-3 text-sm">
                <span className="flex flex-wrap items-baseline gap-x-2"><b className="font-medium">{a.agent}</b><span className="text-xs text-muted-foreground">{a.model || ""}</span></span>
                <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground"><span>took {dur(a.durationMs)}</span><span>exit {a.exitCode ?? (a.finished ? "stopped" : "…")}</span>{a.usage?.denials ? <span className="text-loop">{a.usage.denials} denied</span> : null}</span>
                {a.hasLog ? <span className="grid grid-cols-2 gap-2">
                  <Button variant="outline" size="sm" onClick={() => openPeek(runsOf(a), a.id)}>{a.finished ? "Conversation" : "Watch live"}</Button>
                  <Button variant="outline" size="sm" onClick={() => void viewLog(a)}>View log</Button>
                </span> : null}
              </li>))}
            </ul>
          ) : <Table><TableHeader><TableRow>{["Agent", "Model", "Took", "Exit", "Denied", "", "Log"].map((c, i) => <TableHead key={i} className="z-label">{c}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{agents.slice.map((a) => <TableRow key={a.id}><TableCell className="font-mono text-[13px]">{a.agent}</TableCell><TableCell>{a.model || ""}</TableCell><TableCell className="tabular-nums">{dur(a.durationMs)}</TableCell><TableCell>{a.exitCode ?? (a.finished ? <span className="text-muted-foreground" title="The run ended without an exit code: it was stopped (timeout, cancel, emergency stop), failed to start, or the service restarted mid-run.">stopped</span> : "")}</TableCell><TableCell className={a.usage?.denials ? "text-loop" : "text-muted-foreground"}>{a.usage?.denials ?? ""}</TableCell>
              <TableCell>{a.hasLog ? <Button variant="outline" size="sm" onClick={() => openPeek(runsOf(a), a.id)}>{a.finished ? "Conversation" : "Watch live"}</Button> : ""}</TableCell>
              <TableCell>{a.hasLog ? <Button variant="outline" size="sm" onClick={() => void viewLog(a)}>view</Button> : ""}</TableCell></TableRow>)}</TableBody></Table>}
          <Pager page={agents.page} pages={agents.pages} pageSize={agents.pageSize} total={agents.total} onPage={agents.setPage} onPageSize={agents.setPageSize} />
          {log !== null ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap border border-[var(--z-line)] bg-[#0a0a0a] p-3 text-xs">{log}</pre> : null}
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="decisions" className={cn(panel, "grid gap-4 outline-none")}>
          <SectionHead title="Decisions" note={`${d.decisions.length} · newest first`}>
            {d.decisions.length ? <Filter label="Filter decisions" value={fd} onChange={setFd} placeholder="Filter decisions" /> : null}
          </SectionHead>
          {d.decisions.length ? <><DecisionList rows={decs.slice} /><Pager page={decs.page} pages={decs.pages} pageSize={decs.pageSize} total={decs.total} onPage={decs.setPage} onPageSize={decs.setPageSize} /></> : <p className="text-sm text-muted-foreground">None yet.</p>}
        </TabsPrimitive.Content>

        {d.plan ? (
          <TabsPrimitive.Content value="prompt" aria-label="Prompt" className={cn(panel, "grid gap-6 outline-none")}>
            <div className="grid gap-2">
              <SectionHead title="Implementer prompt" />
              <p className="text-xs text-muted-foreground">Written by Haiku from the ticket and the repository. The implementer gets this, the acceptance criteria below and the ticket.</p>
              <pre aria-label="Implementer prompt" className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words border border-[var(--z-line)] bg-[#0a0a0a] p-4 font-sans text-[13.5px] leading-relaxed">{d.plan.prompt}</pre>
            </div>
            <div className="grid gap-3">
              <SectionHead title="Acceptance criteria" note={`${d.plan.criteria.length}`} />
              <ul className="grid border border-[var(--z-line)]">{d.plan.criteria.map((c) => <li key={c.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 border-b border-[var(--z-line)] px-4 py-2.5 text-sm last:border-0"><b className="z-label text-[var(--z-acc)]">{c.id}</b><span>{c.text}</span></li>)}</ul>
            </div>
          </TabsPrimitive.Content>
        ) : null}

        <TabsPrimitive.Content value="chat" className="outline-none"><JobChat jobId={j.id} /></TabsPrimitive.Content>

        <TabsPrimitive.Content value="files" className={cn(panel, "outline-none")}><FilesPanel d={d} /></TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </div>
  );
}
