import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  done: "text-ok border-ok/40", completed: "text-ok border-ok/40", succeeded: "text-ok border-ok/40", ok: "text-ok border-ok/40",
  running: "text-run border-run/40", waiting: "text-loop border-loop/40", warn: "text-loop border-loop/40",
  failed: "text-destructive border-destructive/40", fail: "text-destructive border-destructive/40", timed_out: "text-destructive border-destructive/40",
  queued: "text-muted-foreground", cancelled: "text-muted-foreground",
};
export const toneOf = (s: string) => TONE[s] ?? "";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return <Badge variant="outline" className={cn("capitalize", toneOf(status), className)}>{status.replaceAll("_", " ")}</Badge>;
}
