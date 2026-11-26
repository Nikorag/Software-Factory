import { Monitor } from "lucide-react";
import { ago, gb } from "@/lib/format";
import { TONE } from "@/lib/projects";
import type { Overview } from "@/lib/types";

/** Machine and scheduler vitals, kept out of the way along the bottom. The full detail is on Factory health. */
export function StatusBar({ overview: o, open }: { overview: Overview | null; open: number }) {
  if (!o) return <footer className="min-h-[30px] border-t border-line bg-rail" />;
  const s = o.system, sch = o.scheduler?.lastDiscovery, failed = o.counts.outbox.failed;
  return (
    <footer className="flex min-h-[30px] flex-wrap items-center gap-x-[18px] gap-y-1 border-t border-line bg-rail px-4 py-1.5 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5"><Monitor className="size-3" aria-hidden />This machine</span>
      <span>{s.memory.freePercent == null ? gb(s.memory.availableBytes) : `${s.memory.freePercent}%`} mem free</span>
      {s.disk ? <span>{gb(s.disk.freeBytes)} disk</span> : null}
      <span>load {s.load[0]?.toFixed(1)}</span>
      {sch ? <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-full" style={{ background: sch.ok ? TONE.ok : TONE.fail }} />Linear {sch.ok ? "ok" : "error"} {ago(sch.at)}</span> : null}
      {failed ? <span style={{ color: TONE.wait }}>{failed} failed write-back{failed === 1 ? "" : "s"}</span> : null}
      <span className="ml-auto">{open} job{open === 1 ? "" : "s"} open</span>
    </footer>
  );
}
