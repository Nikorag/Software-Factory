import { useMemo, useState } from "react";
import { CheckCircle2, Clock, Info, Loader2, MessageSquare, Pause, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, dur } from "@/lib/format";
import { buildTimeline, statsOf, type Tone } from "@/lib/timeline";
import type { JobDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

const TONE: Record<Tone, { icon: React.ReactNode; text: string; rail: string }> = {
  ok: { icon: <CheckCircle2 className="size-4" />, text: "text-ok", rail: "bg-ok/30" },
  fail: { icon: <XCircle className="size-4" />, text: "text-destructive", rail: "bg-destructive/40" },
  run: { icon: <Loader2 className="size-4 animate-spin" />, text: "text-run", rail: "bg-run/40" },
  wait: { icon: <Pause className="size-4" />, text: "text-wait", rail: "bg-wait/40" },
  loop: { icon: <RotateCcw className="size-4" />, text: "text-loop", rail: "bg-loop/50" },
  info: { icon: <Info className="size-4" />, text: "text-muted-foreground", rail: "bg-border" },
};
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * What happened to this job, as a story you can read top to bottom: each step, how it ended and why, when and for how long, what the
 * factory decided (sent back for fixes, review verdicts, your answers) and the agent runs behind it. Click a step to focus it on the flow
 * chart; open a run to read Claude's conversation.
 */
export function Timeline({ detail, cap, selected, onSelect, onWatch }: { detail: JobDetail; cap: number; selected: string | null; onSelect: (nodeId: string) => void; onWatch: (runId: number) => void }) {
  const all = useMemo(() => buildTimeline(detail, cap), [detail, cap]);
  const [newestFirst, setNewestFirst] = useState(true);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const stats = statsOf(all);
  const shown = (onlyProblems ? all.filter((e) => e.tone === "fail" || e.tone === "loop" || e.tone === "wait") : all);
  const rows = newestFirst ? [...shown].reverse() : shown;

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
        <Button size="sm" variant={onlyProblems ? "default" : "outline"} aria-pressed={onlyProblems} onClick={() => setOnlyProblems(!onlyProblems)}>Problems and fixes only</Button>
        <Button size="sm" variant="outline" onClick={() => setNewestFirst(!newestFirst)}>{newestFirst ? "Newest first" : "Oldest first"}</Button>
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
                      {e.nodeId ? <button type="button" onClick={() => onSelect(e.nodeId!)} className={cn("text-left font-medium hover:underline", isSel && "underline")}>{e.title}</button> : <span className="font-medium">{e.title}</span>}
                      {e.run > 1 && !e.cycle ? <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">run {e.run}</span> : null}
                      <span className="flex-1" />
                      <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground" title={ago(e.at)}><Clock className="size-3" />{e.at ? clock(e.at) : "…"}{e.end && e.end > e.at ? ` · took ${dur(e.end - e.at)}` : ""}</span>
                    </div>
                    {e.summary ? <p className={cn("mt-0.5 text-sm", e.tone === "fail" ? "text-destructive" : e.tone === "loop" ? "text-foreground" : "text-muted-foreground")}>{e.summary}</p> : null}
                    {e.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{e.detail}</p> : null}
                    {e.events.length ? (
                      <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                        {e.events.map((ev, j) => <li key={j} className="flex gap-1.5"><span className="shrink-0 font-medium text-foreground/70">{ev.label}:</span><span className="min-w-0 break-words">{ev.text}</span></li>)}
                      </ul>
                    ) : null}
                    {e.runs.length ? (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {e.runs.map((r) => (
                          <Button key={r.id} size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs" onClick={() => onWatch(r.id)}>
                            <MessageSquare className="size-3" />{r.finished ? "Conversation" : "Watch live"}: {r.agent.split("/")[1] ?? r.agent}{r.durationMs ? ` · ${dur(r.durationMs)}` : ""}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
