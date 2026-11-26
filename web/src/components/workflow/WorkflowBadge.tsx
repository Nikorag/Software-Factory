import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import type { JobWorkflow } from "@/lib/workflows";

const SOURCE = { label: "chosen by a ticket label", project: "chosen by the project", default: "the global default" } as const;

/** Which workflow runs this job, which version, and why it was chosen. */
export function WorkflowBadge({ workflow, fallbackName }: { workflow?: JobWorkflow | undefined; fallbackName: string }) {
  if (!workflow) return <div className="mt-1 text-sm text-muted-foreground">{fallbackName}</div>;
  const r = workflow.resolution;
  return (
    <div className="mt-1 grid gap-1 text-sm" aria-label="Workflow">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/workflows/${encodeURIComponent(workflow.id)}`} className="font-medium hover:underline">{workflow.name}</Link>
        {workflow.version !== null ? <Badge variant="outline">v{workflow.version}</Badge> : null}
        {r ? <Badge variant="secondary">{SOURCE[r.source]}</Badge> : null}
        {!workflow.valid ? <Badge variant="outline" className="border-destructive/50 text-destructive">snapshot not valid</Badge> : null}
      </div>
      {r ? <p className="text-xs text-muted-foreground">{r.reason}</p> : <p className="text-xs text-muted-foreground">This job started before workflows were recorded, so it shows the built-in Default Workflow.</p>}
      {r?.matchedLabels.length ? <p className="text-xs text-muted-foreground">Matched labels: {r.matchedLabels.map((m) => `${m.name} (priority ${m.priority})`).join(", ")}</p> : null}
      {r?.conflict ? <p className="text-xs text-loop">Labels pointed at different workflows; resolved by {r.conflict.outcome === "priority" ? "priority (lowest number wins)" : r.conflict.outcome === "project" ? "the project's workflow" : r.conflict.outcome === "tiebreak" ? "the tie-break (first by id)" : "blocking"} under the “{r.conflict.policy}” policy.</p> : null}
    </div>
  );
}
