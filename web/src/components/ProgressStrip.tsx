import { stageLabel } from "@/lib/format";
import { modeOfJob, nodesFor, stripFor, stripStates } from "@/lib/pipeline";
import type { Job } from "@/lib/types";
import { cn } from "@/lib/utils";

const COLOR = { done: "bg-ok", run: "bg-run ring-2 ring-run/30", wait: "bg-wait", fail: "bg-destructive", idle: "bg-border" } as const;

/** One square per pipeline step; the amber count is fix cycles used so far. */
export function ProgressStrip({ job }: { job: Job }) {
  const s = stripStates(job);
  return (
    <div className="flex items-center gap-[3px]" role="img" aria-label={`${stageLabel(job.stage)}${job.remediationAttempts ? `, ${job.remediationAttempts} fix cycles` : ""}`}>
      {stripFor(modeOfJob(job)).map((id, i) => <i key={id} title={nodesFor(modeOfJob(job)).find((n) => n.id === id)?.label} className={cn("size-[11px] rounded-[3px]", COLOR[s[i]!])} />)}
      {job.remediationAttempts ? <em className="ml-1.5 text-[11px] font-semibold not-italic text-loop">↺ {job.remediationAttempts}</em> : null}
    </div>
  );
}
