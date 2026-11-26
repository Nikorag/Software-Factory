import { and, desc, eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { stageExecutions, workflows } from "../db/schema.js";
import { humanQAs, type JobRow } from "../core/jobs.js";
import type { Stage } from "./definition.js";
import { formatAnswer } from "../app/stage-kit.js";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The latest recorded output of a stage in this job. A stage that asked for fixes is returned as its details plus a `remediate` reason. */
export function latestOutput(db: FactoryDb, jobId: string, stageId: string): unknown {
  const row = db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.stage, stageId), eq(stageExecutions.outcome, "succeeded"))).orderBy(desc(stageExecutions.id)).limit(1).get();
  if (!row?.outputJson) return undefined;
  try {
    const o = JSON.parse(row.outputJson) as Record<string, unknown>;
    return o && typeof o === "object" && "remediate" in o && o.details && typeof o.details === "object" ? { ...(o.details as object), remediate: o.remediate } : o;
  } catch { return undefined; }
}

interface Finding { severity?: string; file?: string; line?: number | null; issue?: string; fix?: string; id?: string }

/** The blocking findings of the review or check that most recently sent this job back for fixing, as text for a prompt. */
export function latestFindingsText(db: FactoryDb, jobId: string): string {
  const row = db.select().from(stageExecutions).where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.outcome, "succeeded"))).orderBy(desc(stageExecutions.id)).limit(40).all()
    .find((r) => r.outputJson?.startsWith('{"remediate"'));
  if (!row?.outputJson) return "";
  try {
    const o = JSON.parse(row.outputJson) as { remediate?: string; details?: { findings?: Finding[] } };
    const f = o.details?.findings ?? [];
    const lines = f.map((x) => `- [${x.severity ?? "?"}] ${x.file ?? ""}${x.line ? `:${x.line}` : ""} ${x.issue ?? ""}${x.fix ? ` (fix: ${x.fix})` : ""}`.trim());
    return clip([`From ${row.stage}: ${o.remediate ?? ""}`, ...lines].join("\n"), 8000);
  } catch { return ""; }
}

/**
 * The values a prompt template can use that need no network and no worktree (job, workflow, stage, project, answers, findings and earlier
 * outputs). Computed lazily: only the variables a template mentions are looked up.
 */
export function jobVariables(db: FactoryDb, job: JobRow, stage: Stage, attempt: number, extra: { projectName?: string } = {}): (name: string) => string | undefined {
  return (name) => {
    switch (name) {
      case "job.id": return job.id;
      case "job.key": return job.externalKey;
      case "job.attempt": return String(attempt);
      case "project.id": return job.projectId;
      case "project.name": return extra.projectName ?? job.projectId;
      case "workflow.name": return job.workflowId ? db.select({ n: workflows.name }).from(workflows).where(eq(workflows.id, job.workflowId)).get()?.n ?? job.workflowId : "Default Workflow";
      case "workflow.version": return String(job.workflowVersion ?? 0);
      case "stage.id": return stage.id;
      case "stage.name": return stage.name;
      case "answers": return humanQAs(db, job.id).map(formatAnswer).join("\n\n");
      case "findings": return latestFindingsText(db, job.id);
    }
    const m = /^outputs\.([A-Za-z][A-Za-z0-9_]*)(?:\.([A-Za-z0-9_]+))?$/.exec(name);
    if (!m) return undefined;
    const out = latestOutput(db, job.id, m[1]!);
    if (out === undefined) return "";
    const picked = m[2] ? (out as Record<string, unknown>)[m[2]] : out;
    return picked === undefined ? "" : clip(typeof picked === "string" ? picked : JSON.stringify(picked, null, 2), 8000);
  };
}
