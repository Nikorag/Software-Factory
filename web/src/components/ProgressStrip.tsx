import { stageLabel } from "@/lib/format";
import { stripStates, type NodeState } from "@/lib/pipeline";
import type { Job } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useStripOrder } from "@/hooks/useStripOrder";

const COLOR: Record<NodeState, string> = { done: "bg-ok", run: "bg-run ring-2 ring-run/30", wait: "bg-wait", blocked: "bg-wait", fail: "bg-destructive", idle: "bg-border", skipped: "bg-border" };

/** One square per step on the job's workflow (its success path); the amber count is fix cycles used so far. */
export function ProgressStrip({ job }: { job: Job }) {
  const w = useStripOrder(job.workflowId);
  const order = w?.order ?? [];
  const s = stripStates(job, order);
  return (
    <div className="flex items-center gap-[3px]" role="img" aria-label={`${stageLabel(job.stage, w?.names)}${job.remediationAttempts ? `, ${job.remediationAttempts} fix cycles` : ""}`}>
      {order.map((id, i) => <i key={id} title={stageLabel(id, w?.names)} className={cn("size-[11px] rounded-[3px]", COLOR[s[i]!])} />)}
      {job.remediationAttempts ? <em className="ml-1.5 text-[11px] font-semibold not-italic text-loop">↺ {job.remediationAttempts}</em> : null}
    </div>
  );
}
