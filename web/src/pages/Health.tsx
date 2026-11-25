import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ConnectionBanner, useOffline } from "@/components/ConnectionBanner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { ago, gb } from "@/lib/format";
import type { HealthReport } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

export function HealthPage() {
  // "Re-check" asks the server to probe again now instead of serving cached results (failed probes are otherwise cached for a while)
  const refresh = useRef(false);
  const [checking, setChecking] = useState(false);
  const { data: r, error, updatedAt, reload } = usePoll((signal) => {
    const fresh = refresh.current;
    refresh.current = false;
    return api<HealthReport>(`/api/health${fresh ? "?refresh=1" : ""}`, signal);
  }, 5000);
  const offline = useOffline() || error !== null;
  const recheck = async () => {
    if (checking) return;
    setChecking(true); refresh.current = true;
    try { await reload(); } finally { setChecking(false); }
  };
  const banner = <ConnectionBanner error={error} updatedAt={updatedAt} what="health report" />;
  if (!r) return error ? banner : <Skeleton className="h-48 w-full" />;
  const s = r.system;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {error ? <div className="md:col-span-2">{banner}</div> : null}
      <Card><CardHeader className="flex flex-row items-center justify-between gap-2"><CardTitle className="text-sm">Dependencies</CardTitle>
        <Button variant="outline" size="sm" disabled={checking || offline} onClick={() => void recheck()}><RefreshCw className={checking ? "animate-spin" : undefined} />Re-check</Button></CardHeader>
        <CardContent className="space-y-2 text-sm">
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
