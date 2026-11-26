import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { Issue, WorkflowDef } from "@/lib/workflows";
import { stageIndexOfIssue } from "@/lib/draft";

/** The whole workflow's validation result in one place. Each issue that belongs to a stage can be clicked to jump to it. */
export function ValidationSummary({ errors, warnings, pending, def, onJump, failed }: { errors: Issue[]; warnings: Issue[]; pending: boolean; def: WorkflowDef; onJump: (stageId: string) => void; failed: string | null }) {
  const row = (i: Issue, k: number) => {
    const idx = stageIndexOfIssue(i), st = idx === null ? undefined : def.stages[idx];
    return (
      <li key={`${i.severity}${k}`} className={i.severity === "error" ? "text-destructive" : "text-loop"}>
        {i.severity === "error" ? <XCircle className="mr-1.5 inline size-3.5" aria-hidden="true" /> : <AlertTriangle className="mr-1.5 inline size-3.5" aria-hidden="true" />}
        {st ? <button type="button" className="font-medium underline" onClick={() => onJump(st.id)}>{st.name}</button> : <b>Workflow</b>}: {i.message}
      </li>
    );
  };
  const ok = !errors.length && !failed;
  return (
    <section aria-label="Validation" className="grid gap-1.5 rounded-lg border p-3 text-sm">
      <div className="flex items-center gap-2 font-medium" role="status">
        {pending ? <><Loader2 className="size-4 animate-spin" />Checking…</> : failed ? <><XCircle className="size-4 text-destructive" />Could not validate: {failed}</> : ok ? <><CheckCircle2 className="size-4 text-ok" />Valid{warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : ""}</> : <><XCircle className="size-4 text-destructive" />{errors.length} problem{errors.length === 1 ? "" : "s"} to fix before saving</>}
      </div>
      {errors.length || warnings.length ? <ul className="grid gap-1">{[...errors, ...warnings].map(row)}</ul> : null}
    </section>
  );
}
