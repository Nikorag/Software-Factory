import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronRight, Clock, Info, Loader2, MessageSquare, Pause, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, dur } from "@/lib/format";
import { buildTimeline, statsOf, type TimelineEvent, type Tone } from "@/lib/timeline";
import type { Invocation, JobDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

const TONE: Record<Tone, { icon: React.ReactNode; text: string; rail: string }> = {
  ok: { icon: <CheckCircle2 className="size-4" />, text: "text-ok", rail: "bg-ok/30" },
  fail: { icon: <XCircle className="size-4" />, text: "text-destructive", rail: "bg-destructive/40" },
  run: { icon: <Loader2 className="size-4 animate-spin" />, text: "text-run", rail: "bg-run/40" },
  wait: { icon: <Pause className="size-4" />, text: "text-wait", rail: "bg-wait/40" },
  loop: { icon: <RotateCcw className="size-4" />, text: "text-loop", rail: "bg-loop/50" },
  info: { icon: <Info className="size-4" />, text: "text-muted-foreground", rail: "bg-border" },
};
const PAGE = 3;
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * What happened to this job, as a story you can read top to bottom: each step, how it ended and why, when and for how long, what the
 * factory decided (sent back for fixes, review verdicts, your answers) and the agent runs behind it. Click a step to focus it on the flow
 * chart; open a run to read Claude's conversation.
 */
/** The one button per step that opens its agent sessions, one tab each. */
export function PeekButton({ runs, onPeek, variant = "outline" }: { runs: Invocation[]; onPeek: (runs: Invocation[]) => void; variant?: "outline" | "secondary" }) {
  const live = runs.some((r) => !r.finished);
  return (
    <Button size="sm" variant={variant} className="h-7 gap-1.5 px-2 text-xs" onClick={() => onPeek(runs)} aria-label={`${live ? "Watch live" : "Peek"}: ${runs.length} session${runs.length === 1 ? "" : "s"}`}>
      <MessageSquare className="size-3" />{live ? "Watch live" : "Peek"}<span className="text-muted-foreground">· {runs.length} session{runs.length === 1 ? "" : "s"}</span>
    </Button>
  );
}

/** What the factory decided along the way. Long lists (every implementation pass, every deferral) stay folded until asked for. */
function Events({ events }: { events: TimelineEvent[] }) {
  const [open, setOpen] = useState(false);
  const fold = events.length > 2;
  const shown = open || !fold ? events : [];
  return (
    <div className="mt-1 text-xs text-muted-foreground">
      {fold ? <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 hover:text-foreground max-md:min-h-11"><ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />{open ? "Hide" : "Show"} {events.length} details</button> : null}
      {shown.length ? (
        <ul className="mt-1 grid gap-0.5">
          {shown.map((ev, j) => <li key={j} className="flex gap-1.5"><span className="shrink-0 font-medium text-foreground/70">{ev.label}:</span><span className="min-w-0 wrap-anywhere">{ev.text}</span></li>)}
        </ul>
      ) : null}
    </div>
  );
}

export function Timeline({ detail, cap, selected, onSelect, onPeek }: { detail: JobDetail; cap: number; selected: string | null; onSelect: (nodeId: string) => void; onPeek: (runs: Invocation[]) => void }) {
  const all = useMemo(() => buildTimeline(detail, cap), [detail, cap]);
  const [newestFirst, setNewestFirst] = useState(true);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const stats = statsOf(all);
  const shown = (onlyProblems ? all.filter((e) => e.tone === "fail" || e.tone === "loop" || e.tone === "wait") : all);
  const ordered = newestFirst ? [...shown].reverse() : shown;
  // A long job has dozens of entries: show a few, then 3 more at a time (and, once you have asked for more, a way to see everything).
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [newestFirst, onlyProblems]);
  const rows = ordered.slice(0, limit);
  const hidden = ordered.length - rows.length;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-x-4 gap-y-2">
        <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">What happened</CardTitle>
        <span className="text-xs text-muted-foreground">
          {stats.steps} step{stats.steps === 1 ? "" : "s"}
          {stats.fixCycles ? <> · <span className="text-loop">{stats.fixCycles} fix cycle{stats.fixCycles === 1 ? "" : "s"}</span></> : null}
          {stats.problems ? <> · <span className="text-destructive">{stats.problems} failed</span></> : null}
          {stats.runs ? <> · {stats.runs} agent run{stats.runs === 1 ? "" : "s"}, {dur(stats.agentMs)}</> : null}
        </span>
        <span className="flex-1" />
        <div className="contents max-md:grid max-md:grid-cols-2 max-md:gap-2">
          <Button size="sm" variant={onlyProblems ? "default" : "outline"} aria-pressed={onlyProblems} aria-label="Problems and fixes only" onClick={() => setOnlyProblems(!onlyProblems)}><span>Problems<span className="max-md:hidden"> and fixes only</span><span className="md:hidden"> &amp; fixes</span></span></Button>
          <Button size="sm" variant="outline" onClick={() => setNewestFirst(!newestFirst)}>{newestFirst ? "Newest first" : "Oldest first"}</Button>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">{onlyProblems ? "Nothing has gone wrong or been sent back." : "Nothing has happened yet."}</p> : (
          <ol className="grid">
            {rows.map((e, i) => {
              const t = TONE[e.tone];
              const isSel = e.nodeId && e.nodeId === selected;
              return (
                <li key={e.key} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
                  <div className="flex flex-col items-center">
                    <span className={cn("mt-1 shrink-0", t.text)}>{t.icon}</span>
                    {i < rows.length - 1 ? <span className={cn("w-0.5 flex-1", t.rail)} aria-hidden="true" /> : null}
                  </div>
                  <div className={cn("min-w-0 pb-4", e.tone === "loop" && "-ml-2 rounded-md border-l-2 border-loop/60 bg-loop/5 pl-2 pr-2 pt-1 mb-3")}>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      {e.nodeId ? <button type="button" onClick={() => onSelect(e.nodeId!)} className={cn("text-left font-medium hover:underline relative max-md:after:absolute max-md:after:-inset-x-2 max-md:after:-inset-y-3 max-md:after:content-['']", isSel && "underline")}>{e.title}</button> : <span className="font-medium">{e.title}</span>}
                      {e.run > 1 && !e.cycle ? <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">run {e.run}</span> : null}
                      <span className="flex-1" />
                      <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground" title={ago(e.at)}><Clock className="size-3" />{e.at ? clock(e.at) : "…"}{e.checks ? ` · last checked ${e.lastCheckAt ? clock(e.lastCheckAt) : "…"}` : e.end && e.end > e.at ? ` · took ${dur(e.end - e.at)}` : ""}</span>
                    </div>
                    {e.summary ? <p className={cn("mt-0.5 text-sm", e.tone === "fail" ? "text-destructive" : e.tone === "loop" ? "text-foreground" : "text-muted-foreground")}>{e.summary}</p> : null}
                    {e.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{e.detail}</p> : null}
                    {e.events.length ? <Events events={e.events} /> : null}
                    {e.runs.length ? (
                      <div className="mt-1.5"><PeekButton runs={e.runs} onPeek={onPeek} /></div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {ordered.length > PAGE ? (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
            <span>Showing {rows.length} of {ordered.length}</span>
            {hidden > 0 ? <Button size="sm" variant="outline" onClick={() => setLimit(limit + PAGE)}>View more</Button> : null}
            {hidden > 0 && limit > PAGE ? <Button size="sm" variant="outline" onClick={() => setLimit(ordered.length)}>View all</Button> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
