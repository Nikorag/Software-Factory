import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { ago, gb } from "@/lib/format";
import type { HealthReport } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

export function HealthPage() {
  const { data: r } = usePoll(() => api<HealthReport>("/api/health"), 5000);
  if (!r) return null;
  const s = r.system;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card><CardHeader><CardTitle className="text-sm">Dependencies</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
        {r.health.map((x) => <div key={x.name}><span className={x.status === "ok" ? "text-ok" : "text-loop"}>{x.status === "ok" ? "● " : "▲ "}</span><b>{x.name}</b><div className="text-muted-foreground">{x.detail} (checked {ago(x.checkedAt)})</div></div>)}
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Memory and disk</CardTitle></CardHeader><CardContent className="space-y-1 text-sm">
        <div>Memory: {gb(s.memory.availableBytes)} available of {gb(s.memory.totalBytes)} ({s.memory.pressure})</div>
        <div>{s.disk ? `Disk: ${gb(s.disk.freeBytes)} free of ${gb(s.disk.totalBytes)}` : "Disk: unknown"}</div>
        <div>Load: {s.load.map((n) => n.toFixed(2)).join(" ")}</div>
        <div className="text-muted-foreground">Local inference runs one request at a time; Claude runs as separate processes.</div>
      </CardContent></Card>
    </div>
  );
}
