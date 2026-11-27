import { Monitor } from "lucide-react";
import { ago, gb } from "@/lib/format";
import { TONE } from "@/lib/projects";
import type { Overview } from "@/lib/types";
import { ClaudeUsageChip } from "@/components/ClaudeUsage";

/** Machine and scheduler vitals, kept out of the way along the bottom. The full detail is on Factory health. */
export function StatusBar({ overview: o, open }: { overview: Overview | null; open: number }) {
  if (!o) return <footer className="min-h-[30px] border-t border-line bg-rail" />;
  const s = o.system, sch = o.scheduler?.lastDiscovery, failed = o.counts.outbox.failed;
  return (
    <footer className="flex min-h-[30px] flex-wrap items-center gap-x-[18px] gap-y-1 border-t border-line bg-rail px-4 py-1.5 text-xs text-muted-foreground max-md:gap-x-3 max-md:pb-[calc(env(safe-area-inset-bottom)+0.5rem)] max-md:pt-2">
      <span className="inline-flex items-center gap-1.5 max-md:hidden"><Monitor className="size-3" aria-hidden />This machine</span>
      <span className="max-md:hidden">{s.memory.freePercent == null ? gb(s.memory.availableBytes) : `${s.memory.freePercent}%`} mem free</span>
      {s.disk ? <span className="max-md:hidden">{gb(s.disk.freeBytes)} disk</span> : null}
      <span className="max-md:hidden">load {s.load[0]?.toFixed(1)}</span>
      {sch ? <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-full" style={{ background: sch.ok ? TONE.ok : TONE.fail }} />Linear {sch.ok ? "ok" : "error"} {ago(sch.at)}</span> : null}
      <ClaudeUsageChip usage={o.claudeUsage} />
      {failed ? <span style={{ color: TONE.wait }}>{failed} failed write-back{failed === 1 ? "" : "s"}</span> : null}
      <span className="ml-auto">{open} job{open === 1 ? "" : "s"} open</span>
    </footer>
  );
}
