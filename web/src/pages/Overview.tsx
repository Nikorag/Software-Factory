import { Link, useOutletContext } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { JobsTable } from "@/components/JobsTable";
import { ago, gb } from "@/lib/format";
import type { Overview as O } from "@/lib/types";
import { cn } from "@/lib/utils";

export const useOverview = () => useOutletContext<{ overview: O | null; reload: () => void; offline: boolean }>();

const Kpi = ({ label, v, tone }: { label: string; v: string | number; tone?: string }) => (
  <div><div className={cn("text-2xl font-semibold tabular-nums", tone)}>{v}</div><div className="text-xs text-muted-foreground">{label}</div></div>
);

export function Overview() {
  const { overview: o } = useOverview();
  if (!o) return <Skeleton className="h-64 w-full" />;
  const c = o.counts.byStatus, sys = o.system, sch = o.scheduler;
  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      {o.projectCount === 0 ? (
        <Card><CardContent className="flex flex-wrap items-center gap-3"><div className="flex-1"><b>Let's get you set up.</b><div className="text-sm text-muted-foreground">Connect your tools and Linear, then add your first project.</div></div><Link to="/setup" className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">Start setup</Link></CardContent></Card>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card><CardHeader><CardTitle className="text-sm">Jobs</CardTitle></CardHeader><CardContent className="grid grid-cols-5 gap-2">
          <Kpi label="running" v={c.running || 0} /><Kpi label="queued" v={c.queued || 0} /><Kpi label="waiting" v={c.waiting || 0} tone={c.waiting ? "text-loop" : ""} /><Kpi label="done" v={c.done || 0} tone="text-ok" /><Kpi label="failed" v={c.failed || 0} tone={c.failed ? "text-destructive" : ""} />
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">This machine</CardTitle></CardHeader><CardContent className="grid grid-cols-3 gap-2">
          <Kpi label="memory free" v={sys.memory.freePercent == null ? gb(sys.memory.availableBytes) : `${sys.memory.freePercent}%`} tone={sys.memory.pressure === "critical" ? "text-destructive" : sys.memory.pressure === "warn" ? "text-loop" : ""} />
          <Kpi label="disk free" v={sys.disk ? gb(sys.disk.freeBytes) : "?"} /><Kpi label="load" v={sys.load[0]!.toFixed(1)} />
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">Scheduler</CardTitle></CardHeader><CardContent className="space-y-1 text-sm">
          {sch ? <>
            <div>Linear poll: {sch.lastDiscovery ? <span className={sch.lastDiscovery.ok ? "text-ok" : "text-destructive"}>{sch.lastDiscovery.ok ? "ok" : "error"} {ago(sch.lastDiscovery.at)}</span> : "not yet"}{sch.lastDiscovery ? ` · ${sch.lastDiscovery.enqueued} new` : ""}{sch.lastDiscovery?.skipped ? <span title="Tickets ignored this poll: usually a project that is not onboarded yet (see Settings → Projects), or a ticket that is not labelled for the factory."> · {sch.lastDiscovery.skipped} skipped</span> : null}</div>
            {sch.lastDiscovery?.error ? <div className="text-destructive">{sch.lastDiscovery.error.slice(0, 160)}</div> : null}
            <div>Write-back: {sch.lastFlush ? `${sch.lastFlush.sent} sent, ${sch.lastFlush.pending} pending, ${sch.lastFlush.failed} failed (${ago(sch.lastFlush.at)})` : "not yet"}</div>
            <div className="text-muted-foreground">Backlog: {o.counts.outbox.pending} pending, {o.counts.outbox.failed} failed Linear writes</div>
          </> : <div className="text-muted-foreground">Dashboard only: the scheduler is not running.</div>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">Dependencies</CardTitle></CardHeader><CardContent className="space-y-1 text-sm">
          {o.health.length ? o.health.map((x) => <div key={x.name}><span className={x.status === "ok" ? "text-ok" : "text-loop"}>{x.status === "ok" ? "● " : "▲ "}</span><b>{x.name}</b><span className="text-muted-foreground"> {x.detail}</span></div>) : <div className="text-muted-foreground">No health probes configured.</div>}
          {o.counts.recentAgentFailures.rateLimited ? <div className="text-loop">{o.counts.recentAgentFailures.rateLimited} rate-limit hit(s) in the last hour</div> : null}
        </CardContent></Card>
      </div>
      {([["Running now", o.active], ["Queued and waiting", o.queued], ["Recently finished", o.recent]] as const).map(([t, jobs]) => (
        <Card key={t}><CardHeader><CardTitle className="text-sm">{t}</CardTitle></CardHeader><CardContent><JobsTable jobs={[...jobs]} /></CardContent></Card>
      ))}
    </div>
  );
}
