import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BUILTIN_HELP } from "@/lib/builtin-stages";
import { describeGate, FAILURE_DEFAULTS } from "@/lib/describe";
import { dur, stageText } from "@/lib/format";
import { describeFailures, type Flow, type NodeState } from "@/lib/pipeline";
import type { Execution, Invocation } from "@/lib/types";
import { COMPLETE, type GateTrace, type RouteRecord, type StageDef } from "@/lib/workflows";
import { PeekButton } from "@/components/Timeline";
import { cn } from "@/lib/utils";

const STATE: Record<NodeState, string> = { done: "Finished", run: "Running now", wait: "Waiting", fail: "Stopped here", blocked: "Waiting for a person", skipped: "Skipped", idle: "Not reached yet" };
const h = "text-xs font-semibold uppercase tracking-wider text-muted-foreground";

function Trace({ t, depth = 0 }: { t: GateTrace; depth?: number }) {
  return (
    <li style={{ marginLeft: depth * 12 }} className="list-none">
      <span className={t.passed ? "text-ok" : "text-destructive"}>{t.passed ? "passed" : "failed"}</span> <span className="font-mono text-xs text-muted-foreground">{t.type}</span> {t.detail}
      {t.children?.length ? <ul className="mt-0.5">{t.children.map((c, i) => <Trace key={i} t={c} depth={depth + 1} />)}</ul> : null}
    </li>
  );
}
export const routeText = (r: RouteRecord, names: Record<string, string>): string => {
  const to = r.to ? (r.to === COMPLETE ? "completion" : names[r.to] ?? r.to) : "";
  switch (r.action) {
    case "retry": return `retry ${r.attempt ?? "?"} of ${r.of ?? "?"}${r.delayMs ? ` after ${dur(r.delayMs)}` : ""}`;
    case "goto": return `sent to “${to}”${r.cycle ? ` (fix cycle ${r.cycle} of ${r.of ?? "?"}${r.phase ? `, ${r.phase} phase` : ""})` : ""}`;
    case "skip": return `skipped${r.reason ? `: ${r.reason}` : ""}`;
    case "branch": return `condition decided → “${to}”${r.reason ? ` (${r.reason})` : ""}`;
    case "next": return `succeeded → “${to}”`;
    case "block": return "blocked until a person answers";
    case "manual": return `needs a person${r.reason ? `: ${r.reason}` : ""}`;
    case "fail": return "failed the job";
    default: return `${r.action}${to ? ` → ${to}` : ""}`;
  }
};

/** Everything known about one step of one job: its definition, how it ran (attempts, models, gate, routing) and what to expect. */
export function NodeDetail({ stage, flow, executions, invocations, names, onPeek, onClear }: { stage: StageDef; flow: Flow; executions: Execution[]; invocations: Invocation[]; names: Record<string, string>; onPeek: (runs: Invocation[]) => void; onClear: () => void }) {
  const nf = flow.nodes[stage.id];
  const state = nf?.state ?? "idle";
  const ids = new Set(executions.map((e) => e.id));
  const runs = invocations.filter((i) => i.stageExecutionId !== null && ids.has(i.stageExecutionId));
  const help = BUILTIN_HELP[stage.handler ?? stage.id];
  const failures = describeFailures(stage, names);
  const configured = stage.model?.model || stage.model?.provider ? `${stage.model.provider ?? "default provider"}${stage.model.model ? ` / ${stage.model.model}` : ""}` : "the default route";
  const lastGate = nf?.gate;
  return (
    <Card><CardContent className="grid gap-4 md:grid-cols-2">
      <div className="grid content-start gap-1.5">
        <div className={h}>Selected step</div>
        <h3 className="text-base font-semibold">{stage.name}</h3>
        <div className="font-mono text-xs text-muted-foreground">{stage.id} · {stage.type}{stage.handler ? ` · ${stage.handler}` : ""}{stage.required ? "" : " · optional"}</div>
        <p className="text-sm" data-testid="node-state">{STATE[state]}{(nf?.attempts ?? 0) > 1 ? ` · ${nf!.attempts} attempts` : ""}{nf?.retries ? ` · ${nf.retries} retr${nf.retries === 1 ? "y" : "ies"}` : ""}{nf?.durationMs ? ` · ${dur(nf.durationMs)}` : ""}</p>
        {state === "skipped" && nf?.skippedReason ? <p className="text-xs text-muted-foreground">Skipped: {nf.skippedReason}</p> : null}
        <p className="text-xs text-muted-foreground">Retries allowed: {stage.retry.max}{stage.retry.backoff ? " (backoff)" : ""} · timeout {dur(stage.timeoutSeconds * 1000)}{stage.runIf ? " · runs only if its condition holds" : ""}</p>
        {stage.type !== "check" && stage.type !== "conditional" ? (
          <p className="text-xs text-muted-foreground">Model: configured {configured}{nf?.models.length ? <>; actually used <span className="font-mono">{nf.models.join(", ")}</span></> : ""}</p>
        ) : null}
        {runs.length ? <div className="mt-1"><PeekButton runs={runs} variant="secondary" onPeek={onPeek} /></div> : null}
        <div><Button variant="ghost" size="sm" className="mt-1 px-0" onClick={onClear}>Show all steps</Button></div>
      </div>
      <div className="grid content-start gap-3 text-sm">
        <div><div className={h}>What happens here</div><p>{stage.description || help?.what || "No description."}</p>{help && stage.description && help.what !== stage.description ? <p className="mt-1 text-xs text-muted-foreground">{help.what}</p> : null}</div>
        <div><div className={h}>Moves on when</div><p className="whitespace-pre-line text-muted-foreground">{describeGate(stage.successGate).join("\n")}</p></div>
        {lastGate?.trace ? <div><div className={h}>Last gate result</div><ul className="grid gap-0.5"><Trace t={lastGate.trace} /></ul></div> : lastGate ? <div><div className={h}>Last gate result</div><p className={lastGate.passed ? "text-ok" : "text-destructive"}>{lastGate.passed ? "passed" : "did not pass"}</p></div> : null}
        <div><div className={h}>If it finds problems</div>{help?.issues && !failures.length ? <p>{stageText(help.issues, names)}</p> : failures.length ? <ul className="grid gap-0.5">{failures.map((l) => <li key={l}>{l}</li>)}</ul> : <p className="text-muted-foreground">No failure rule: an error or timeout is {FAILURE_DEFAULTS.error}.</p>}</div>
        {nf?.routes.length ? <div><div className={h}>Routing decisions</div><ul className="grid gap-0.5">{nf.routes.map(({ exec, route }) => <li key={exec.id}><span className="text-muted-foreground">attempt {exec.attempt}:</span> <span className={cn(route.action === "goto" && "text-loop", (route.action === "fail" || route.action === "manual") && "text-destructive")}>{stageText(routeText(route, names), names)}</span></li>)}</ul></div> : null}
      </div>
    </CardContent></Card>
  );
}
